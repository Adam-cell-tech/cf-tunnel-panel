'use strict';
const zlib = require('zlib');
/**
 * 通用工具：日志环形缓冲、JSON 收发、解析器、限流、安全头
 * 从 src/server.js 按职责拆出（v0.9.0），仅做搬运，行为不变。
 */

const http=require('http'); const https=require('https');
const crypto=require('crypto');

const { LOG_MAX } = require('./paths');
function rid() {
  return Math.random().toString(16).slice(2, 10);
}

const logs = [];
let logSeq = 0;
const sseClients = new Set();

function log(line, source = 'panel') {
  const rec = { seq: ++logSeq, t: Date.now(), source, line: String(line).replace(/\s+$/, '') };
  logs.push(rec);
  if (logs.length > LOG_MAX) logs.splice(0, logs.length - LOG_MAX);
  const payload = `data: ${JSON.stringify(rec)}\n\n`;
  for (const res of sseClients) {
    try { res.write(payload); } catch { sseClients.delete(res); }
  }
  if (process.env.LOG_STDOUT === '1') console.log(`[${source}] ${rec.line}`);
}

// ---------------------------------------------------------------- 规则 → Caddy 配置
/**
 * 把用户粘贴的东西变回"隧道 token"。
 * 现实里大家经常整条命令复制过来（`docker run ... --token eyJ...`、`cloudflared tunnel run --token ...`），
 * 直接塞给 cloudflared 只会得到 "Provided Tunnel token is not valid."，所以这里先"抠"出来。
 * token 本体 = base64url(JSON {a:账号, t:隧道id, s:密钥})。
 */
/**
 * JSON 响应。体积超过 1KB 且客户端接受 gzip 时压缩 —— 面板是走在隧道上的，
 * 家宽上行只有 3.4Mbps，/api/state 这种 5KB 的响应压到 1.5KB 感知很明显。
 * req 从 res.req 取（Node 自带），不用改所有调用点。
 */
function sendJson(res, code, obj) {
  const buf = Buffer.from(JSON.stringify(obj), 'utf8');
  const req = res.req || {};
  const ae = String((req.headers && req.headers['accept-encoding']) || '');
  const gzOk = buf.length > 1024 && /\bgzip\b/.test(ae);
  // 面板每 5 秒轮询 /api/state，内容没变就没必要重发正文。
  // 注意 Cache-Control 必须是 private,no-cache（允许存、但每次要回源校验）——
  // 原来的 no-store 会让浏览器根本不发 If-None-Match，ETag 就废了。
  const tag = `W/"${buf.length.toString(16)}-${crypto.createHash('sha1').update(buf).digest('hex').slice(0, 12)}${gzOk ? '-gz' : '-id'}"`;
  const base = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'private, no-cache',
    ETag: tag,
    Vary: 'Accept-Encoding',
  };
  const inm = String((req.headers && req.headers['if-none-match']) || '');
  if (code === 200 && inm && inm.split(',').map((x) => x.trim()).includes(tag)) {
    res.writeHead(304, base);
    return res.end();
  }
  if (gzOk) {
    const gz = zlib.gzipSync(buf, { level: 6 });
    res.writeHead(code, Object.assign(base, { 'Content-Encoding': 'gzip', 'Content-Length': gz.length }));
    return res.end(gz);
  }
  res.writeHead(code, Object.assign(base, { 'Content-Length': buf.length }));
  return res.end(buf);
}

function readBody(req, limit = 512 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('请求体过大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch (e) { reject(new Error('JSON 解析失败: ' + e.message)); }
    });
    req.on('error', reject);
  });
}

function parseCidrs(text) {
  const list = String(text || '')
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  for (const c of list) {
    if (!/^[0-9a-fA-F:.\/]+$/.test(c)) throw new Error(`IP/CIDR 不合法: ${c}`);
  }
  return list;
}

function parseUpstream(upstream) {
  let u = String(upstream || '').trim();
  if (!u) throw new Error('上游地址不能为空');
  if (!/^[a-z]+:\/\//i.test(u)) u = 'http://' + u;
  let url;
  try { url = new URL(u); } catch { throw new Error(`上游地址不合法: ${upstream}`); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('上游只支持 http / https');
  const scheme = url.protocol.replace(':', '');
  const port = url.port || (scheme === 'https' ? '443' : '80');
  return { scheme, dial: `${url.hostname}:${port}` };
}

function parseHeaderLines(text) {
  const out = {};
  for (const raw of String(text || '').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf(':');
    if (i < 1) throw new Error(`请求/响应头格式应为 "名称: 值"，收到: ${line}`);
    out[line.slice(0, i).trim()] = [line.slice(i + 1).trim()];
  }
  return out;
}

const SEC_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'SAMEORIGIN',
};

function rateLimited(ip) {
  const now = Date.now();
  const b = rlHits.get(ip) || { n: 0, reset: now + 60000 };
  if (now > b.reset) { b.n = 0; b.reset = now + 60000; }
  b.n += 1;
  rlHits.set(ip, b);
  if (rlHits.size > 800) for (const [k, v] of rlHits) if (v.reset < now) rlHits.delete(k);
  return b.n > 1200;
}

const rlHits = new Map();

/** /api 的粗粒度限流：同一来源每分钟超过 1200 次直接 429（防误点也能防暴力枚举）。 */

module.exports = { SEC_HEADERS, log, logSeq, logs, parseCidrs, parseHeaderLines, parseUpstream, rateLimited, readBody, rid, rlHits, sendJson, sseClients };
