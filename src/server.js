'use strict';
/**
 * cf-tunnel-panel v0.2 —— 可视化 cloudflared 隧道 + Caddy 反向代理面板
 *
 * 数据流：公网 → Cloudflare 边缘 → cloudflared（本进程 spawn） → Caddy(:8080)
 *        → 按「域名 / 路径 / 方法 / 来源 IP」分流 → 内网服务
 *
 * 设计要点（为什么这么做，见 docs/ROADMAP.md）：
 *  1) 隧道用「token 托管模式」时 ingress 由云端决定，本地无法动态改，
 *     所以让云端把流量全交给本地 Caddy，再由 Caddy 做分流 —— 改规则秒级生效。
 *  2) 面板只做「下发配置」，不参与数据面，进程崩溃不影响已生效的代理。
 *  3) 所有敏感信息（tunnel token、Basic 认证口令哈希）只落 /data，不回显。
 */

const http = require('http');
const https = require('https');
const crypto = require('crypto');
const zlib = require('zlib');
const net = require('net');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const QRCode = require('qrcode');
const bcrypt = require('bcryptjs');

/** 版本号从 package.json 读（每次启动读一次即可；改 package.json 后重启生效） */
function pkgVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')).version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}
const VERSION = pkgVersion();

// 负载均衡策略白名单（Caddy reverse_proxy 内置策略）
const LB_POLICIES = ['round_robin', 'random', 'first', 'least_conn', 'ip_hash', 'uri_hash', 'header', 'cookie'];

const PORT = Number(process.env.PORT || 8090);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const CADDY_ADMIN = process.env.CADDY_ADMIN || 'http://127.0.0.1:2019';
const CLOUDFLARED = process.env.CLOUDFLARED_BIN || '/usr/local/bin/cloudflared';
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const UI_FILE = path.join(__dirname, 'ui.html');
const WEB_DIR = path.join(__dirname, 'web');
const ASSET_DIR = path.join(WEB_DIR, 'assets');
const PAGE_DIR = path.join(WEB_DIR, 'pages');
const ASSET_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
};
const PAGES = [
  { path: '/', file: 'overview', title: '总览', ico: '◎' },
  { path: '/tunnels', file: 'tunnels', title: '隧道出口', ico: '⇄' },
  { path: '/rules', file: 'rules', title: '代理规则', ico: '⛓' },
  { path: '/tools', file: 'tools', title: '工具箱', ico: '⚒' },
  { path: '/observe', file: 'observe', title: '观测', ico: '◔' },
  { path: '/settings', file: 'settings', title: '设置', ico: '⚙' },
];
// Caddy 把 access log 以 JSON 行写到这里；Caddy 容器里挂在 /logs，面板侧读同一份文件
const CADDY_LOG_DIR = process.env.CADDY_LOG_DIR || '/logs';
const ACCESS_LOG_FILE = path.join(DATA_DIR, 'caddy-logs', 'access.log');
const accessLogPathForCaddy = () => path.join(CADDY_LOG_DIR, 'access.log');

const LOG_MAX = 1200;
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];
const PROTOCOLS = ['auto', 'quic', 'http2', 'http2_ws'];
const LOGLEVELS = ['debug', 'info', 'warn', 'error'];

// ---------------------------------------------------------------- 状态
function rid() {
  return Math.random().toString(16).slice(2, 10);
}

function defaultState() {
  return {
    version: 2,
    settings: {
      caddyListen: process.env.CADDY_LISTEN || ':8080',
      notFoundBody:
        'cf-tunnel-panel：这条路径没有匹配的代理规则。\n请打开面板 http://<本机IP>:8090 添加规则。',
      panelTitle: 'Cloudflare 隧道面板',
      // 维护模式：整站（Caddy 那层）直接 503，出口/隧道不用动
      maintenance: { on: false, body: '站点正在维护，请稍后再来。', retryAfter: 300 },
      // 安全：全局 IP 黑名单（最先匹配）+ 可选限流（需自定义 Caddy 镜像）
      security: { ipDeny: '', rateLimit: { enabled: false, rps: 20, burst: 40 } },
      // 通知：出口掉线 / 换域名 / Caddy 下发失败时推一条
      notify: {
        url: '', format: 'generic',
        events: { tunnelDown: true, urlChange: true, caddyFail: true },
        cooldownSec: 300,  // 同一事件多少秒内不重复提醒（0 = 不冷却）
        quietHours: '',    // 静默时段，如 "23:00-07:00"，可逗号分隔多段
      },
      // Cloudflare API（可选）：在面板里建隧道、建 CNAME、删隧道
      cf: { token: '', accountId: '', zoneId: '' },
    },
    // 多个隧道出口：每个 = 一条独立的 cloudflared 进程
    // 可以同时跑「快速隧道 + 命名隧道」或「多个命名隧道（不同账号/域名）」
    tunnels: [
      {
        id: 'main',
        name: '主隧道出口',
        enabled: true,
        mode: 'quick', // quick | named
        token: '',
        origin: `http://127.0.0.1:${(process.env.CADDY_LISTEN || ':8080').split(':').pop()}`,
        publicHostname: '',
        protocol: 'auto',
        loglevel: 'info',
        metricsPort: '',
        extraArgs: '',
      },
    ],
    routes: [
      {
        id: rid(),
        name: '演示服务（whoami）',
        enabled: true,
        host: '',
        path: '/demo',
        matchMethod: '',
        ipAllow: '',
        strip: true,
        upstream: 'http://127.0.0.1:8091',
        backupUpstream: '',
        lbTryDuration: 0,
        lbPolicy: 'round_robin',
        headersReq: '',
        headersRes: '',
        timeoutSec: 0,
        basicAuth: { user: '', hash: '' },
        note: '这是自带的演示上游，返回你的请求头信息。用来确认整条链路是通的。',
      },
    ],
    // 一次性分享链接：/s/<token>/ → 上游，到期自动失效
    shares: [],
    panel: { user: '', pass: '' },
    viewer: { user: '', pass: '' },
  };
}

let state = defaultState();

function deepDefault(target, def) {
  if (Array.isArray(def)) return Array.isArray(target) ? target : def;
  if (def && typeof def === 'object') {
    const out = Object.assign({}, def);
    for (const k of Object.keys(def)) out[k] = deepDefault(target ? target[k] : undefined, def[k]);
    if (target && typeof target === 'object') for (const k of Object.keys(target)) if (!(k in out)) out[k] = target[k];
    return out;
  }
  return target === undefined ? def : target;
}

function defaultOrigin() {
  return `http://127.0.0.1:${(process.env.CADDY_LISTEN || ':8080').split(':').pop()}`;
}

function newTunnel(patch = {}) {
  return Object.assign(
    {
      id: rid(),
      name: '新隧道出口',
      enabled: true,
      mode: 'quick',
      token: '',
      origin: defaultOrigin(),
      publicHostname: '',
      protocol: 'auto',
      loglevel: 'info',
      metricsPort: '',
      extraArgs: '',
    },
    patch
  );
}

// v2（单隧道 state.tunnel）→ v3（state.tunnels 数组）
function migrateState(obj) {
  if (Array.isArray(obj.tunnels) && obj.tunnels.length) return obj;
  const old = obj.tunnel && typeof obj.tunnel === 'object' ? obj.tunnel : null;
  obj.tunnels = [
    newTunnel({
      id: 'main',
      name: '主隧道出口',
      enabled: old ? old.autoStart !== false : true,
      mode: old && old.mode === 'named' ? 'named' : 'quick',
      token: (old && old.token) || '',
      origin: (old && old.origin) || defaultOrigin(),
      publicHostname: (old && old.publicHostname) || '',
      protocol: (old && old.protocol) || 'auto',
      loglevel: (old && old.loglevel) || 'info',
      metricsPort: (old && old.metricsPort) || '',
      extraArgs: (old && old.extraArgs) || '',
    }),
  ];
  delete obj.tunnel;
  return obj;
}

function normalizeTunnels() {
  const seen = new Set();
  state.tunnels = (Array.isArray(state.tunnels) ? state.tunnels : []).map((t) => {
    const merged = Object.assign(newTunnel(), t || {});
    if (!merged.id || seen.has(merged.id)) merged.id = rid();
    seen.add(merged.id);
    if (!['quick', 'named'].includes(merged.mode)) merged.mode = 'quick';
    if (!PROTOCOLS.includes(merged.protocol)) merged.protocol = 'auto';
    if (!LOGLEVELS.includes(merged.loglevel)) merged.loglevel = 'info';
    return merged;
  });
  if (!state.tunnels.length) state.tunnels = [newTunnel({ id: 'main', name: '主隧道出口' })];
}

function loadState() {
  try {
    const raw = fs.readFileSync(STATE_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    migrateState(parsed);
    state = deepDefault(parsed, defaultState());
    state.version = 3;
    normalizeTunnels();
  } catch (e) {
    if (e.code !== 'ENOENT') log(`[state] 读取失败，使用默认配置: ${e.message}`);
    normalizeTunnels();
  }
}

function saveState(reason = 'save') {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = STATE_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, STATE_FILE);
  // 每次保存留一份滚动备份，最多 20 份（小白改坏了可以回滚）
  try {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    fs.writeFileSync(path.join(BACKUP_DIR, `${stamp}-${reason}.json`), JSON.stringify(state, null, 2), { mode: 0o600 });
    const files = fs.readdirSync(BACKUP_DIR).sort();
    for (const f of files.slice(0, Math.max(0, files.length - 20))) fs.unlinkSync(path.join(BACKUP_DIR, f));
  } catch {}
}

// ---------------------------------------------------------------- 日志
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
function normalizeTunnelToken(raw) {
  const src = String(raw == null ? '' : raw).trim();
  if (!src) return { ok: false, error: '没填' };
  const candidates = String(src).match(/eyJ[A-Za-z0-9_\-+/=]{20,}/g) || [];
  const pool = candidates.length ? candidates : (/^[A-Za-z0-9_\-+/=]{40,}$/.test(src) ? [src] : []);
  const tried = [];
  for (const c of pool.slice().sort((a, b) => b.length - a.length)) {
    const cleaned = c.replace(/=+$/, '');
    try {
      const txt = Buffer.from(cleaned.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
      const obj = JSON.parse(txt);
      if (!obj || typeof obj.a !== 'string' || typeof obj.t !== 'string' || typeof obj.s !== 'string') {
        tried.push('缺 a/t/s 字段'); continue;
      }
      return {
        ok: true,
        token: c,
        accountId: obj.a,
        tunnelId: obj.t,
        stripped: src !== c, // 说明用户粘的是整条命令，我们帮他抠出来了
      };
    } catch (e) { tried.push(e.message.slice(0, 40)); }
  }
  return {
    ok: false,
    error: '这段内容里找不到隧道 token（token 是一长串 `eyJ` 开头的字符）。到 Cloudflare → 网络 → Tunnels → 该隧道 → 配置，复制 `--token` 后面那一串。',
    tried,
  };
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

function buildRouteHandlers(r) {
  const handle = [];

  // 1) 基础认证（口令在保存时已转 bcrypt 哈希）
  if (r.basicAuth && r.basicAuth.user && r.basicAuth.hash) {
    handle.push({
      handler: 'authentication',
      providers: {
        http_basic: {
          hash: { algorithm: 'bcrypt' },
          accounts: [{ username: r.basicAuth.user, password: r.basicAuth.hash }],
        },
      },
    });
  }

  // 2) 剥离路径前缀
  if (r.strip && r.path) {
    const prefix = r.path.replace(/\*+$/, '').replace(/\/+$/, '');
    if (prefix) handle.push({ handler: 'rewrite', strip_path_prefix: prefix });
  }

  // 3) 反向代理
  const main = parseUpstream(r.upstream);
  const upstreams = [{ dial: main.dial }];
  if (r.backupUpstream) upstreams.push({ dial: parseUpstream(r.backupUpstream).dial });

  const proxy = { handler: 'reverse_proxy', upstreams };
  const transport = { protocol: 'http' };
  if (main.scheme === 'https') transport.tls = {};
  if (r.timeoutSec > 0) transport.response_header_timeout = r.timeoutSec * 1e9;
  proxy.transport = transport;
  if (r.timeoutSec > 0) proxy.flush_interval = 0;

  if (upstreams.length > 1) {
    // 注意：Caddy v2.11 起字段名是 selection_policy（老写法 selection 会 400 unknown field）
    proxy.load_balancing = {
      selection_policy: { policy: LB_POLICIES.includes(r.lbPolicy) ? r.lbPolicy : 'round_robin' },
      try_duration: (r.lbTryDuration > 0 ? r.lbTryDuration : 10) * 1e9,
      try_interval: 500e6,
    };
  }

  const reqSet = Object.assign(
    {
      'X-Forwarded-Host': ['{http.request.host}'],
      'X-Real-IP': ['{http.request.remote.host}'],
      'X-Panel-Route': [r.name || r.id],
    },
    parseHeaderLines(r.headersReq),
  );
  proxy.headers = { request: { set: reqSet } };
  const resSet = parseHeaderLines(r.headersRes);
  if (Object.keys(resSet).length) proxy.headers.response = { set: resSet };

  handle.push(proxy);
  return handle;
}

// 某个出口对外的域名：命名隧道取配置里的 publicHostname，快速隧道取运行时拿到的 trycloudflare 域名
function tunnelHostOf(id) {
  const t = tunnelById(id);
  if (!t) return '';
  if (t.mode === 'named') return String(t.publicHostname || '').trim();
  const rt = runtimes.get(id);
  const m = String((rt && rt.url) || '').match(/^https?:\/\/([^/:]+)/i);
  return m ? m[1] : '';
}

function buildMatch(r, forcedHost) {
  const m = {};
  const explicit = String(r.host || '').split(',').map((s) => s.trim()).filter(Boolean);
  const hosts = explicit.length ? explicit : (forcedHost ? [forcedHost] : []);
  if (hosts.length) m.host = hosts;
  if (r.path) m.path = [r.path.endsWith('*') ? r.path : r.path.replace(/\/+$/, '') + '*'];
  if (r.matchMethod) m.method = String(r.matchMethod).split(',').map((s) => s.trim()).filter(Boolean);
  const cidrs = parseCidrs(r.ipAllow);
  if (cidrs.length) m.remote_ip = { ranges: cidrs };
  return m;
}

let lastSkipped = [];
let pushTimer = null;
// 规则按出口域名收窄，所以出口上线/掉线/换域名后必须重新下发一次
function schedulePush(delay = 500) {
  if (pushTimer) return;
  pushTimer = setTimeout(() => {
    pushTimer = null;
    pushCaddy().catch(() => {});
  }, delay);
  if (pushTimer.unref) pushTimer.unref();
}

// Cloudflare 公布的边缘节点 IP 段（https://www.cloudflare.com/ips/）。
// 隧道进来的流量对端是这些节点，真实访客 IP 在 CF-Connecting-IP 头里；
// 要按真实访客做 IP 白名单/黑名单，必须先让 Caddy 信任这些代理段。
// 段表会变（Cloudflare 偶尔新增），可用环境变量 CLOUDFLARE_IPS 覆盖（逗号分隔）。
const CLOUDFLARE_DEFAULT_RANGES = ["173.245.48.0/20", "103.21.244.0/22", "103.22.200.0/22", "103.31.4.0/22", "141.101.64.0/18", "108.162.192.0/18", "190.93.240.0/20", "188.114.96.0/20", "197.234.240.0/22", "198.41.128.0/17", "162.158.0.0/15", "104.16.0.0/13", "104.24.0.0/14", "172.64.0.0/13", "131.0.72.0/22", "2400:cb00::/32", "2606:4700::/32", "2803:f800::/32", "2405:b500::/32", "2405:8100::/32", "2a06:98c0::/29", "2c0f:f248::/32"];

function cloudflareRanges() {
  const custom = String(process.env.CLOUDFLARE_IPS || '').trim();
  if (!custom) return CLOUDFLARE_DEFAULT_RANGES;
  return custom.split(',').map((x) => x.trim()).filter(Boolean);
}

function buildCaddyConfig() {
  const routes = [];
  let securityTail = 0;
  lastSkipped = [];

  // ① IP 黑名单：最先匹配，直接 403（连"这里有没有服务"都不暴露）
  let deny = [];
  try { deny = parseCidrs(state.settings.security && state.settings.security.ipDeny); } catch { deny = []; }
  if (deny.length) {
    routes.push({
      match: [{ remote_ip: { ranges: deny } }],
      handle: [{
        handler: 'static_response', status_code: 403,
        headers: { 'Content-Type': ['text/plain; charset=utf-8'] }, body: '403 forbidden',
      }],
      terminal: true,
    });
  }

  // ② 限流：只有自定义 Caddy 镜像（带 caddy-ratelimit）时才下发，否则会 load 失败
  const rl = (state.settings.security || {}).rateLimit || {};
  if (rl.enabled && Number(rl.rps) > 0) {
    if (process.env.CADDY_RATELIMIT === '1') {
      routes.push({
        handle: [{
          handler: 'rate_limit',
          zones: [{
            key: '{remote_host}',
            events: Math.max(1, Math.round(Number(rl.rps))),
            window: '1s',
          }],
        }],
        terminal: false,
      });
    } else if (!global.__rlWarned) {
      global.__rlWarned = true;
      log('已勾选限流，但当前 Caddy 不带 rate_limit 模块 —— 见 docs/RATELIMIT.md 换自定义镜像并设 CADDY_RATELIMIT=1', 'panel');
    }
  }

  // ③ 维护模式：整站 503，隧道和出口不用动，关掉即恢复
  const maint = state.settings.maintenance || {};
  if (maint.on) {
    routes.push({
      handle: [{
        handler: 'static_response',
        status_code: 503,
        headers: {
          'Content-Type': ['text/html; charset=utf-8'],
          'Retry-After': [String(Math.max(1, Math.min(86400, Number(maint.retryAfter) || 300)))],
          'Cache-Control': ['no-store'],
        },
        body: maintPage(String(maint.body || '站点正在维护，请稍后再来。')),
      }],
      terminal: true,
    });
  } else {
    securityTail = routes.length; // 分享链接要插在「安全层之后、业务规则之前」
    for (const r of state.routes.filter((x) => x.enabled && x.upstream)) {
      let host = '';
      if (r.tunnelId) {
        host = tunnelHostOf(r.tunnelId);
        if (!host) {
          const t = tunnelById(r.tunnelId);
          lastSkipped.push({ id: r.id, name: r.name, path: r.path, tunnelId: r.tunnelId,
            reason: t ? `出口「${t.name}」还没有公网域名（先启动它）` : '所属出口已被删除' });
          continue;
        }
      }
      routes.push({ match: [buildMatch(r, host)], handle: buildRouteHandlers(r), terminal: true });
    }
  }

  // ③ 一次性分享链接：/s/<token>/… 直通某个上游，到期由 janitor 删除
  const now = Date.now();
  const shareRoutes = [];
  for (const s of (state.shares || []).filter((x) => x && x.token && x.expiresAt > now && x.upstream)) {
    let up = null;
    try { up = parseUpstream(s.upstream); } catch { up = null; }
    if (!up) continue;
    shareRoutes.push({
      match: [{ path: [`/s/${s.token}`, `/s/${s.token}/*`] }],
      handle: [
        { handler: 'rewrite', strip_path_prefix: `/s/${s.token}` },
        { handler: 'reverse_proxy', upstreams: [{ dial: up.dial }] },
      ],
      terminal: true,
    });
  }
  // 分享链接必须排在业务规则前面：否则任何 path=/ 的兜底规则（面板、静态站）会先吃掉 /s/<token>
  if (shareRoutes.length) routes.splice(securityTail, 0, ...shareRoutes);

  routes.push({
    handle: [
      {
        handler: 'static_response',
        status_code: 404,
        headers: { 'Content-Type': ['text/plain; charset=utf-8'] },
        body: String(state.settings.notFoundBody || 'not found'),
      },
    ],
  });

  return {
    admin: { listen: '127.0.0.1:2019', origins: [CADDY_ADMIN, 'http://localhost:2019'] },
    logging: {
      logs: {
        default: {
          level: 'INFO',
          encoder: { format: 'json' },
          // 访问日志落文件，面板据此做「最近请求 / 状态码 / 命中了哪条规则」统计
          writer: { output: 'file', filename: accessLogPathForCaddy(), roll_size_mb: 10, roll_keep: 3 },
        },
      },
    },
    apps: {
      http: {
        servers: {
          main: {
            listen: [state.settings.caddyListen || ':8080'],
            automatic_https: { disable: true },
            logs: {}, // 打开 access log（写进上面的 default logger）
            // 流量经 Cloudflare 隧道进来时，TCP 对端是 cloudflared/边缘节点，
            // 真实访客 IP 在 CF-Connecting-IP 里。不配这两项，IP 白名单/黑名单
            // 会把所有人当成同一个 IP（127.0.0.1 或某个边缘地址）。
            trusted_proxies: { source: 'static', ranges: cloudflareRanges() },
            client_ip_headers: ['CF-Connecting-IP'],
            routes,
          },
        },
      },
    },
  };
}

const caddy = { ok: false, error: null, lastPush: 0, routeCount: 0 };

async function pushCaddy() {
  let cfg;
  try {
    cfg = buildCaddyConfig();
  } catch (e) {
    caddy.ok = false;
    caddy.error = '生成配置失败: ' + e.message;
    log(caddy.error, 'caddy');
    return caddy;
  }
  try {
    const res = await fetch(`${CADDY_ADMIN}/load`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: CADDY_ADMIN },
      body: JSON.stringify(cfg),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    caddy.ok = true;
    caddy.error = null;
    caddy.lastPush = Date.now();
    caddy.routeCount = cfg.apps.http.servers.main.routes.length - 1;
    log(`已下发 ${caddy.routeCount} 条代理规则到 Caddy（监听 ${state.settings.caddyListen}）`, 'caddy');
  } catch (e) {
    caddy.ok = false;
    caddy.error = e.message;
    log(`Caddy 配置下发失败: ${e.message}`, 'caddy');
  }
  return caddy;
}

// ---------------------------------------------------------------- cloudflared（多隧道出口）
// 每个出口 = 一条独立的 cloudflared 进程，互不影响。典型用法：
//   ① 快速隧道试跑 + 命名隧道长期并存
//   ② 多个命名隧道（不同 Cloudflare 账号 / 不同域名 / 不同机房）
// 它们在 Caddy 这一层汇合：默认都指向 http://127.0.0.1:8080，再由面板规则分流。
const QUICK_RE = /https:\/\/[a-z0-9][a-z0-9-]*\.trycloudflare\.com/gi;
const runtimes = new Map(); // tunnelId -> { proc, status, pid, url, startedAt, lastError, desired }

function tunnelRt(id) {
  let r = runtimes.get(id);
  if (!r) {
    r = { proc: null, status: 'stopped', pid: null, url: null, startedAt: null, lastError: null, desired: false };
    runtimes.set(id, r);
  }
  return r;
}
function tunnelById(id) { return state.tunnels.find((t) => t.id === id) || null; }
function firstTunnel() { return state.tunnels[0] || null; }

function tunnelArgs(t) {
  const args = ['tunnel', '--no-autoupdate', '--loglevel', t.loglevel || 'info'];
  if (t.protocol && t.protocol !== 'auto') args.push('--protocol', t.protocol);
  if (t.metricsPort) args.push('--metrics', `127.0.0.1:${t.metricsPort}`);
  if (t.extraArgs && t.extraArgs.trim()) args.push(...t.extraArgs.trim().split(/\s+/));
  if (t.mode === 'named') args.push('run');
  else args.push('--url', t.origin);
  return args;
}

function stopTunnel(id, silent = false) {
  const t = tunnelById(id);
  const rt = tunnelRt(id);
  const tag = t ? `[${t.name}] ` : '';
  rt.desired = false;
  if (!rt.proc) { rt.status = 'stopped'; return; }
  rt.status = 'stopping';
  const p = rt.proc;
  try { p.kill('SIGTERM'); } catch {}
  setTimeout(() => { try { if (rt.proc === p) p.kill('SIGKILL'); } catch {} }, 5000);
  if (!silent) log(`${tag}已请求停止隧道`, 'cloudflared');
}

function startTunnel(id) {
  const t = tunnelById(id);
  if (!t) return;
  const rt = tunnelRt(id);
  const tag = `[${t.name}] `;
  rt.fatal = false; // 每次启动都重新判断，别把上一次的致命标记永久带下去
  rt.throttled = false;
  if (rt.proc) stopTunnel(id, true);

  if (t.mode === 'named' && !t.token) {
    rt.status = 'error';
    rt.lastError = '命名隧道模式需要先填写 Tunnel Token';
    log(`${tag}${rt.lastError}`, 'cloudflared');
    return;
  }
  // metrics 端口撞车会让 cloudflared 直接退出，这里提前提示
  if (t.metricsPort) {
    const clash = state.tunnels.find((o) => o.id !== t.id && o.metricsPort === t.metricsPort && tunnelRt(o.id).proc);
    if (clash) log(`${tag}注意：metrics 端口 ${t.metricsPort} 与「${clash.name}」重复，可能启动失败`, 'cloudflared');
  }

  const args = tunnelArgs(t);
  const env = Object.assign({}, process.env);
  if (t.mode === 'named') env.TUNNEL_TOKEN = t.token;
  else delete env.TUNNEL_TOKEN;

  log(`${tag}启动: cloudflared ${args.join(' ')}`, 'cloudflared');
  let proc;
  try {
    proc = spawn(CLOUDFLARED, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    rt.status = 'error';
    rt.lastError = e.message;
    log(`${tag}启动失败: ${e.message}`, 'cloudflared');
    return;
  }
  rt.proc = proc;
  rt.status = 'starting';
  rt.pid = proc.pid;
  rt.startedAt = Date.now();
  rt.lastError = null;
  rt.url = null;
  rt.desired = true;

  const onData = (buf) =>
    String(buf)
      .split('\n')
      .filter((l) => l.trim())
      .forEach((l) => {
        log(`${tag}${l}`, 'cloudflared');
        if (/Registered tunnel connection|Your quick Tunnel has been created/i.test(l)) {
          if (rt.status !== 'running') {
            rt.status = 'running'; rt.failCount = 0; rt.lastError = null; schedulePush();
          }
        }
        const m = l.match(QUICK_RE);
        if (m && m[0] !== rt.url) {
          rt.url = m[0];
          log(`${tag}公网地址已就绪: ${m[0]}`, 'cloudflared');
          schedulePush(200);
        }
        if (/status 429|provisioning failed with status 429|rate.?limit/i.test(l)) rt.throttled = true;
        if (/token.{0,24}(not valid|invalid|expired|revoked)|invalid tunnel secret|unauthorized|failed to unmarshal tunnel token/i.test(l)) {
          // token 错/被吊销：重试再多次也没用，停止自动重试，把话说人话
          rt.fatal = true;
          rt.lastError = 'Tunnel Token 无效（Cloudflare 返回 “token is not valid”）—— 到 Cloudflare → Tunnels → 该隧道页重新复制 token，粘贴到「出口设置」里保存并启动';
        }
      });
  proc.stdout.on('data', onData);
  proc.stderr.on('data', onData);
  proc.on('exit', (code) => {
    log(`${tag}cloudflared 退出 code=${code}`, 'cloudflared');
    const desired = rt.desired;
    rt.proc = null;
    rt.pid = null;
    rt.status = desired ? 'error' : 'stopped';
    if (desired) rt.reconnects = (rt.reconnects || 0) + 1;
    let delay = 5000;
    if (desired && rt.fatal) {
      // 致命错误（token 无效等）：不再自动重试，避免每 5 秒刷一次日志把面板刷满
      log(`${tag}检测到致命错误，已停止自动重试：${rt.lastError}`, 'cloudflared');
      if (!rt.lastError || rt.lastError.startsWith('进程退出')) rt.lastError = `进程退出 code=${code}（不会自动重试）`;
      schedulePush();
      return;
    }
    if (desired && rt.throttled) {
      // Cloudflare 对匿名快速隧道做限流（每天/每小时能建的数量有限）：指数退避，别每 5 秒重试一次把它惹更久
      rt.failCount = (rt.failCount || 0) + 1;
      delay = Math.min(30000 * Math.pow(2, rt.failCount - 1), 15 * 60000);
      rt.lastError = `Cloudflare 限流（快速隧道创建太频繁，第 ${rt.failCount} 次），${Math.round(delay / 1000)} 秒后自动重试`;
      log(`${tag}${rt.lastError}`, 'cloudflared');
    } else if (desired) {
      // 兜底：token 没配好、域名冲突、二进制坏了…… 连续失败 5 次就停下，别无声地每 5 秒刷日志
      rt.failCount = (rt.failCount || 0) + 1;
      rt.lastError = `进程退出 code=${code}`;
      if (rt.failCount >= 5) {
        rt.fatal = true;
        rt.lastError = `连续 ${rt.failCount} 次启动失败（code=${code}），已暂停自动重试。看看上面的日志，修好后点「启动」。`;
        log(`${tag}${rt.lastError}`, 'cloudflared');
        schedulePush();
        return;
      }
    } else {
      rt.failCount = 0;
      rt.lastError = null;
    }
    rt.throttled = false;
    schedulePush();
    const cur = tunnelById(id);
    if (desired && cur && cur.enabled) setTimeout(() => { const c2 = tunnelById(id); if (c2 && c2.enabled) startTunnel(id); }, delay);
  });
  setTimeout(() => { if (rt.proc && rt.status === 'starting') rt.status = 'running'; }, 8000);
}

function publicUrlOf(t) {
  if (!t) return null;
  if (t.mode === 'named') {
    const host = String(t.publicHostname || '').trim();
    return host ? (host.startsWith('http') ? host : `https://${host}`) : null;
  }
  return tunnelRt(t.id).url || null;
}

function startAll() {
  for (const t of state.tunnels) if (t.enabled) startTunnel(t.id);
}
function stopAll() {
  for (const t of state.tunnels) stopTunnel(t.id, true);
}
function runtimeOf(id) {
  const rt = tunnelRt(id);
  return {
    status: rt.status, pid: rt.pid, url: rt.url,
    publicUrl: publicUrlOf(tunnelById(id)) || null,
    startedAt: rt.startedAt, lastError: rt.lastError,
    reconnects: rt.reconnects || 0,
    fatal: !!rt.fatal,
    uptimeSec: rt.status === 'running' && rt.startedAt ? Math.round((Date.now() - rt.startedAt) / 1000) : 0,
  };
}

// ---------------------------------------------------------------- 测速（面板自带，不依赖外部脚本）
const BENCH_MAX_MB = 32;

/** 从 CF-Ray 头里取边缘机房代码（如 `8f2a...-AMS` → AMS），本机直连时为空。 */
function coloOf(req) {
  const m = String(req.headers['cf-ray'] || '').match(/-([A-Z]{3})$/i);
  return m ? m[1].toUpperCase() : '';
}

/** 生成 N MB 零字节流：浏览器在「当前页面同源」下载它，量出来的就是真实端到端带宽。 */
function sendBenchBlob(req, res, url) {
  const mb = Math.min(BENCH_MAX_MB, Math.max(1, Number(url.searchParams.get('mb')) || 5));
  const total = mb * 1024 * 1024;
  res.writeHead(200, {
    'Content-Type': 'application/octet-stream',
    'Content-Length': String(total),
    'Cache-Control': 'no-store, no-cache, must-revalidate',
    'X-Bench-Bytes': String(total),
  });
  const chunk = Buffer.alloc(128 * 1024, 0);
  let sent = 0;
  const pump = () => {
    while (sent < total) {
      const n = Math.min(chunk.length, total - sent);
      sent += n;
      if (!res.write(n === chunk.length ? chunk : chunk.subarray(0, n))) {
        res.once('drain', pump);
        return;
      }
    }
    res.end();
  };
  pump();
}

/** 本机 → Caddy 的回环延迟（不经隧道），给公网延迟做对照。 */
function benchLocalOnce(port) {
  return new Promise((resolve) => {
    const t0 = process.hrtime.bigint();
    const req = http.request({ host: '127.0.0.1', port, path: '/', method: 'GET', headers: { Host: 'localhost' } }, (res) => {
      const ttfb = Number(process.hrtime.bigint() - t0) / 1e6;
      res.resume();
      res.on('end', () => resolve({ ok: true, ttfbMs: Math.round(ttfb), totalMs: Math.round(Number(process.hrtime.bigint() - t0) / 1e6), status: res.statusCode }));
    });
    req.setTimeout(4000, () => { req.destroy(); resolve({ ok: false, error: 'timeout' }); });
    req.on('error', (e) => resolve({ ok: false, error: e.message }));
    req.end();
  });
}

function publicSettings() {
  const s = JSON.parse(JSON.stringify(state.settings));
  s.cf = { accountId: s.cf.accountId, zoneId: s.cf.zoneId, hasToken: !!s.cf.token };
  s.viewer = { user: (state.viewer && state.viewer.user) || '', hasPass: !!(state.viewer && state.viewer.pass) };
  s.notify = {
    format: s.notify.format,
    events: s.notify.events,
    hasUrl: !!s.notify.url,
    cooldownSec: s.notify.cooldownSec || 0,
    quietHours: s.notify.quietHours || '',
  };
  return s;
}

function tokenTunnelOf(t) {
  if (!t) return '';
  if (t.tokenTunnelId) return t.tokenTunnelId;
  const tk = normalizeTunnelToken(t.token || '');
  if (tk.ok && tk.tunnelId) { t.tokenTunnelId = tk.tunnelId; return tk.tunnelId; }
  return '';
}

function publicTunnels() {
  return state.tunnels.map((t) => ({
    id: t.id,
    name: t.name,
    enabled: !!t.enabled,
    mode: t.mode,
    origin: t.origin,
    publicHostname: t.publicHostname,
    protocol: t.protocol,
    loglevel: t.loglevel,
    metricsPort: t.metricsPort,
    extraArgs: t.extraArgs,
    tokenTunnelId: tokenTunnelOf(t),
    hasToken: !!t.token,
  }));
}
function applyTunnelFields(t, body, { allowToken = true } = {}) {
  if (typeof body.name === 'string') t.name = body.name.trim().slice(0, 40) || t.name;
  if (['quick', 'named'].includes(body.mode)) t.mode = body.mode;
  if (allowToken && typeof body.token === 'string' && body.token.trim()) {
    const tk = normalizeTunnelToken(body.token);
    if (!tk.ok) throw new Error(tk.error);
    t.token = tk.token;
    t.tokenTunnelId = tk.tunnelId;
    if (tk.stripped) log(`[${t.name}] 粘贴的是整条命令，已自动抠出其中的隧道 token（隧道 ${tk.tunnelId.slice(0, 8)}…）`, 'cloudflared');
  }
  if (allowToken && body.clearToken === true) t.token = '';
  if (typeof body.origin === 'string' && body.origin.trim()) {
    parseUpstream(body.origin);
    t.origin = body.origin.trim();
  }
  if (typeof body.publicHostname === 'string') t.publicHostname = body.publicHostname.trim().replace(/^https?:\/\//, '').replace(/\/$/, '');
  if (PROTOCOLS.includes(body.protocol)) t.protocol = body.protocol;
  if (LOGLEVELS.includes(body.loglevel)) t.loglevel = body.loglevel;
  if (typeof body.metricsPort === 'string') t.metricsPort = body.metricsPort.replace(/\D/g, '').slice(0, 5);
  if (typeof body.extraArgs === 'string') t.extraArgs = body.extraArgs.slice(0, 500);
  if (typeof body.enabled === 'boolean') t.enabled = body.enabled;
  return t;
}

// ---------------------------------------------------------------- HTTP 工具
function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
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

function authOk(req) {
  return checkAuth(req).ok;
}

/** 面板登录：区分「没带凭证」和「带错了」，后者要计失败次数（防暴力破解）。 */
function checkAuth(req) {
  const { user, pass } = state.panel || {};
  const viewer = state.viewer || {};
  if (!user) return { ok: true, tried: false, readonly: false };
  const h = req.headers.authorization || '';
  if (!h.startsWith('Basic ')) return { ok: false, tried: false, readonly: false };
  const [u, p] = Buffer.from(h.slice(6), 'base64').toString('utf8').split(':');
  if (u === user && p === pass) return { ok: true, tried: true, readonly: false };
  if (viewer.user && u === viewer.user && p === viewer.pass) return { ok: true, tried: true, readonly: true };
  return { ok: false, tried: true, readonly: false };
}

// 登录失败计数：同一 IP 10 分钟内错 8 次，锁 10 分钟。
// 面板一旦挂到公网（隧道 / 反代），Basic 认证没有内置锁，等于可以无限猜。
const authFails = new Map(); // ip -> { count, firstAt, until }
const AUTH_FAIL_LIMIT = 8;
const AUTH_FAIL_WINDOW = 10 * 60 * 1000;
const AUTH_BLOCK_MS = 10 * 60 * 1000;

/** 取真实客户端 IP：优先 X-Forwarded-For 首段（经 Caddy/Cloudflare 转发时），否则用 socket 地址。 */
function clientIpOf(req) {
  const xf = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  if (xf) return xf;
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

function authBlockedFor(req) {
  const ip = clientIpOf(req);
  const st = authFails.get(ip);
  if (st && st.until > Date.now()) return Math.ceil((st.until - Date.now()) / 1000);
  return 0;
}

function noteAuthFail(req) {
  const ip = clientIpOf(req);
  const now = Date.now();
  const st = authFails.get(ip) || { count: 0, firstAt: now, until: 0 };
  if (now - st.firstAt > AUTH_FAIL_WINDOW) { st.count = 0; st.firstAt = now; }
  st.count += 1;
  if (st.count >= AUTH_FAIL_LIMIT && st.until < now) {
    st.until = now + AUTH_BLOCK_MS;
    log(`面板登录连续失败 ${st.count} 次（${ip}），已锁定 ${AUTH_BLOCK_MS / 60000} 分钟`, 'panel');
  }
  authFails.set(ip, st);
}

function clearAuthFail(req) { authFails.delete(clientIpOf(req)); }

/** 校验并归一化前端提交的路由数组。plaintext 口令在这里转成 bcrypt 哈希。 */
function validateRoutes(list, prevRoutes = []) {
  if (!Array.isArray(list)) throw new Error('routes 必须是数组');
  const out = [];
  for (const [idx, r] of list.entries()) {
    const up = String(r.upstream || '').trim();
    if (!up) throw new Error(`第 ${idx + 1} 条规则缺少上游地址`);
    parseUpstream(up);
    if (r.backupUpstream) parseUpstream(r.backupUpstream);
    parseHeaderLines(r.headersReq);
    parseHeaderLines(r.headersRes);
    parseCidrs(r.ipAllow);
    let p = String(r.path || '').trim();
    if (p && !p.startsWith('/')) p = '/' + p;
    if (p.includes('*') && !p.endsWith('*')) throw new Error(`第 ${idx + 1} 条：路径通配符只支持结尾，如 /files/*`);

    const method = String(r.matchMethod || '')
      .split(',')
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean);
    for (const m of method) if (!METHODS.includes(m)) throw new Error(`不支持的方法: ${m}`);

    const prev = prevRoutes.find((x) => x.id === r.id) || {};
    const prevAuth = prev.basicAuth || { user: '', hash: '' };
    let auth = { user: String((r.basicAuth && r.basicAuth.user) || '').trim(), hash: prevAuth.hash || '' };
    const newPass = r.basicAuth && typeof r.basicAuth.password === 'string' ? r.basicAuth.password : '';
    if (auth.user && newPass) auth.hash = bcrypt.hashSync(newPass, 10);
    if (auth.user && !auth.hash) throw new Error(`第 ${idx + 1} 条：开启了基础认证但没有设置密码`);
    if (!auth.user) auth = { user: '', hash: '' };

    out.push({
      id: r.id || rid(),
      name: String(r.name || '').slice(0, 80),
      enabled: r.enabled !== false,
      tunnelId: String(r.tunnelId || '').slice(0, 40),
      host: String(r.host || '').slice(0, 300),
      path: p.slice(0, 200),
      matchMethod: method.join(','),
      ipAllow: String(r.ipAllow || '').slice(0, 300),
      strip: !!r.strip,
      upstream: up.slice(0, 300),
      backupUpstream: String(r.backupUpstream || '').slice(0, 300),
      lbTryDuration: Math.max(0, Math.min(120, Number(r.lbTryDuration) || 0)),
      lbPolicy: LB_POLICIES.includes(r.lbPolicy) ? r.lbPolicy : 'round_robin',
      headersReq: String(r.headersReq || '').slice(0, 2000),
      headersRes: String(r.headersRes || '').slice(0, 2000),
      timeoutSec: Math.max(0, Math.min(3600, Number(r.timeoutSec) || 0)),
      basicAuth: auth,
      note: String(r.note || '').slice(0, 300),
    });
  }
  return out;
}

function publicRoute(r) {
  return Object.assign({}, r, { basicAuth: { user: (r.basicAuth && r.basicAuth.user) || '', hasPassword: !!((r.basicAuth && r.basicAuth.hash)) } });
}

// ---------------------------------------------------------------- 上游自检
/** TCP 探一次上游端口，再按需发一个 HTTP 请求看状态码。给面板「测一下」用。 */
async function probeUpstream(raw) {
  let u;
  try {
    u = new URL(String(raw || '').trim());
  } catch {
    return { ok: false, error: '上游地址不合法，应为 http://127.0.0.1:8096 这种形式' };
  }
  if (!/^https?:$/.test(u.protocol)) return { ok: false, error: '只支持 http / https 上游' };
  const host = u.hostname;
  const port = Number(u.port || (u.protocol === 'https:' ? 443 : 80));
  const t0 = Date.now();
  const tcp = await new Promise((resolve) => {
    const sock = net.connect({ host, port });
    const finish = (v) => { try { sock.destroy(); } catch {} resolve(v); };
    sock.setTimeout(2500, () => finish({ ok: false, error: '连接超时（2.5s 没响应）' }));
    sock.once('connect', () => finish({ ok: true }));
    sock.once('error', (e) => finish({
      ok: false,
      error: e.code === 'ECONNREFUSED' ? `端口 ${port} 没人监听（connection refused）`
        : e.code === 'ENOTFOUND' ? `域名解析失败：${host}`
        : e.code === 'EHOSTUNREACH' || e.code === 'ENETUNREACH' ? '主机不可达'
        : e.message,
    }));
  });
  const tcpMs = Date.now() - t0;
  if (!tcp.ok) return { ok: false, tcpMs, port, error: tcp.error };
  try {
    const r = await fetch(u.toString(), {
      method: 'GET', redirect: 'manual',
      headers: { 'User-Agent': 'cf-tunnel-panel-probe' },
      signal: AbortSignal.timeout(4000),
    });
    const totalMs = Date.now() - t0;
    return {
      ok: r.status < 500, tcpMs, totalMs, port, status: r.status,
      note: r.status >= 500 ? 'TCP 通，但上游返回 5xx —— 服务可能没起好' : '',
    };
  } catch (e) {
    return { ok: true, tcpMs, totalMs: Date.now() - t0, port, status: 0, note: 'TCP 通，但 HTTP 请求失败：' + e.message };
  }
}

// ---------------------------------------------------------------- 访问统计
/** 读 Caddy access log 的最后若干行，解析成面板能直接展示的表格 + 汇总。 */
/** 按小时聚合 access.log：总数 / 2xx / 4xx-5xx，给概览页画趋势图。 */
function trafficByHour(hours = 12) {
  const now = Date.now();
  const start = now - hours * 3600 * 1000;
  const buckets = new Map();
  for (let i = 0; i < hours; i += 1) {
    const t = start + i * 3600 * 1000;
    const key = new Date(t).setMinutes(0, 0, 0);
    buckets.set(key, { t: key, total: 0, ok: 0, err: 0 });
  }
  let text = '';
  try {
    const st = fs.statSync(ACCESS_LOG_FILE);
    const from = Math.max(0, st.size - 2 * 1024 * 1024);
    const fd = fs.openSync(ACCESS_LOG_FILE, 'r');
    const buf = Buffer.alloc(st.size - from);
    fs.readSync(fd, buf, 0, buf.length, from);
    fs.closeSync(fd);
    text = buf.toString('utf8');
  } catch { return { available: false, hours, buckets: [] }; }
  for (const line of text.split('\n')) {
    if (!line.trim() || !line.includes('http.log.access')) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    // Caddy 的 ts 是 Unix 秒（浮点），不是 ISO 字符串
    const ts = typeof o.ts === 'number' ? o.ts * 1000 : Date.parse(String(o.ts || ''));
    if (!Number.isFinite(ts) || ts < start) continue;
    const key = new Date(ts).setMinutes(0, 0, 0);
    const b = buckets.get(key);
    if (!b) continue;
    b.total += 1;
    const code = Number((o.status || 0));
    if (code >= 400) b.err += 1; else b.ok += 1;
  }
  return { available: true, hours, buckets: [...buckets.values()] };
}

/** 面板自身占用情况：状态文件、备份数、日志大小、内存。 */
function systemInfo() {
  const sizeOf = (f) => { try { return fs.statSync(f).size; } catch { return 0; } };
  let backups = 0;
  try { backups = fs.readdirSync(BACKUP_DIR).filter((f) => f.endsWith('.json')).length; } catch {}
  return {
    version: VERSION,
    node: process.version,
    uptimeSec: Math.round(process.uptime()),
    startedAt: Date.now() - Math.round(process.uptime() * 1000),
    dataDir: DATA_DIR,
    stateBytes: sizeOf(STATE_FILE),
    backupCount: backups,
    logBytes: sizeOf(ACCESS_LOG_FILE),
    caddyLogBytes: sizeOf(ACCESS_LOG_FILE),
    memMB: Math.round(process.memoryUsage().rss / 1048576),
    host: os.hostname(),
    platform: `${os.type()} ${os.release()} ${os.arch()}`,
  };
}

function readAccess(limit = 100) {
  let raw = '';
  try {
    const st = fs.statSync(ACCESS_LOG_FILE);
    const maxBytes = 512 * 1024;
    const start = Math.max(0, st.size - maxBytes);
    const fd = fs.openSync(ACCESS_LOG_FILE, 'r');
    const buf = Buffer.alloc(Math.min(maxBytes, st.size - start));
    fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);
    raw = buf.toString('utf8');
  } catch {
    return { ok: true, available: false, file: ACCESS_LOG_FILE, rows: [], summary: null,
      note: '还没有访问日志（Caddy 需重启一次以启用 access log，或暂时没有流量）' };
  }
  const lines = raw.split('\n').filter((l) => l.trim().startsWith('{'));
  const rows = [];
  for (const line of lines) {
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    // 只收 HTTP 访问日志；同一文件里还混着 admin / tls 等其它 logger 的行
    if (!String(o.logger || '').includes('http.log.access')) continue;
    const req = o.request || {};
    rows.push({
      ts: o.ts ? new Date(o.ts * 1000).toISOString() : '',
      host: req.host || '',
      method: req.method || '',
      uri: req.uri || '',
      status: Number(o.status) || 0,
      durMs: o.duration ? Math.round(o.duration * 1000) : 0,
      size: Number(o.size) || 0,
      ip: req.remote_ip || '',
      ua: (req.headers && req.headers['User-Agent'] && req.headers['User-Agent'][0]) || '',
    });
  }
  const tail = rows.slice(-limit).reverse();
  const byStatus = {};
  const byPath = {};
  const byHost = {};
  for (const r of tail) {
    const c = r.status >= 500 ? '5xx' : r.status >= 400 ? '4xx' : r.status >= 300 ? '3xx' : r.status >= 200 ? '2xx' : '其他';
    byStatus[c] = (byStatus[c] || 0) + 1;
    const key = (r.uri || '/').split('?')[0];
    byPath[key] = (byPath[key] || 0) + 1;
    byHost[r.host || '(无 Host)'] = (byHost[r.host || '(无 Host)'] || 0) + 1;
  }
  const top = (obj, n = 6) => Object.entries(obj).sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => ({ k, v }));
  return {
    ok: true, available: true, file: ACCESS_LOG_FILE, rows: tail,
    summary: { total: tail.length, byStatus, topPaths: top(byPath), topHosts: top(byHost) },
  };
}

// ---------------------------------------------------------------- 模拟匹配
/** 用面板自己的规则表模拟一次「这个路径会命中哪条规则」，不经过 Caddy。 */
function simulateMatch(pathname, host, method) {
  let pn = String(pathname || '/').trim();
  if (!pn.startsWith('/')) pn = '/' + pn;
  const h = String(host || '').trim().toLowerCase();
  const m = String(method || 'GET').trim().toUpperCase();
  const list = state.routes.map((r, idx) => ({ r, idx })).filter((x) => x.r.enabled && x.r.upstream);
  for (let i = 0; i < list.length; i++) {
    const r = list[i].r;
    let hosts = String(r.host || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
    if (!hosts.length && r.tunnelId) {
      const fh = tunnelHostOf(r.tunnelId);
      if (fh) hosts = [fh.toLowerCase()];
      // 出口当前没有公网域名（没起/被删）时，Caddy 里这条规则根本不会下发 —— 模拟也要跳过，
      // 否则会把"专属规则"当成"任意域名都匹配"，和真实行为不符。
      else continue;
    }
    if (hosts.length) {
      if (!h) return { ok: true, matched: false, needHost: true, hosts, note: '这条规则限定了域名，请填写要模拟的域名' };
      const okHost = hosts.some((x) => (x.startsWith('*.') ? h.endsWith(x.slice(1)) : x === h));
      if (!okHost) continue;
    }
    if (r.matchMethod) {
      const ms = String(r.matchMethod).split(',').map((x) => x.trim().toUpperCase()).filter(Boolean);
      if (ms.length && !ms.includes(m)) continue;
    }
    const rp = String(r.path || '');
    const prefix = rp.endsWith('*') ? rp.slice(0, -1) : rp.replace(/\/+$/, '');
    if (prefix && !pn.startsWith(prefix)) continue;
    const t = r.tunnelId ? tunnelById(r.tunnelId) : null;
    return {
      ok: true, matched: true, index: i + 1, ofIndex: list[i].idx, total: list.length,
      rule: { id: r.id, name: r.name, path: r.path, host: r.host, upstream: r.upstream, backupUpstream: r.backupUpstream,
        strip: !!r.strip, basicAuth: !!(r.basicAuth && r.basicAuth.user), ipAllow: r.ipAllow || '',
        matchMethod: r.matchMethod || '', timeoutSec: r.timeoutSec || 0, note: r.note || '' },
      scope: t ? `出口：${t.name || t.id}` : '全局',
      note: '',
    };
  }
  return { ok: true, matched: false, index: 0, total: list.length,
    note: '没有任何规则命中 —— 会落到自定义 404（这条路径在 Caddy 里被拒绝了）' };
}

/** 每条规则用自己的路径+域名跑一遍模拟，找出被前面规则挡住的（永远不会生效的）。 */
function shadowReport() {
  const out = [];
  state.routes.forEach((r, idx) => {
    if (!r.enabled || !r.upstream) return;
    // 绑定到某个出口、而那个出口当前还没有公网域名时，这条规则压根没下发给 Caddy，
    // 它只会出现在 skipped 里，不能算「被谁拦住」（否则会误报）。
    if (r.tunnelId && !tunnelHostOf(r.tunnelId)) return;
    if (!String(r.host || '').trim() && r.tunnelId && !tunnelHostOf(r.tunnelId)) return;
    const host = String(r.host || '').split(',')[0].trim() || (r.tunnelId ? tunnelHostOf(r.tunnelId) : '') || '';
    const res = simulateMatch(r.path || '/', host, String(r.matchMethod || 'GET').split(',')[0] || 'GET');
    if (res.needHost) return;
    if (!res.matched) { out.push({ index: idx, id: r.id, name: r.name, path: r.path, reason: '没有命中任何规则' }); return; }
    if (res.ofIndex !== idx) {
      const by = state.routes[res.ofIndex] || {};
      out.push({ index: idx, id: r.id, name: r.name, path: r.path, byIndex: res.ofIndex,
        byName: by.name || by.path || '前面的规则', reason: `被「${by.name || by.path}」拦住` });
    }
  });
  return out;
}

// ---------------------------------------------------------------- 上游健康（定时轻量 TCP 探测）
const upstreamHealth = new Map();

function upstreamTarget(raw) {
  try {
    const u = new URL(String(raw || '').trim());
    if (!/^https?:$/.test(u.protocol)) return null;
    return { url: u.origin + u.pathname.replace(/\/+$/, ''), host: u.hostname, port: Number(u.port || (u.protocol === 'https:' ? 443 : 80)) };
  } catch { return null; }
}

function tcpProbeOnce(host, port, timeout = 900) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const sock = net.connect({ host, port });
    const fin = (ok, error) => { try { sock.destroy(); } catch {} resolve({ ok, error: error || null, ms: Date.now() - t0 }); };
    sock.setTimeout(timeout, () => fin(false, 'timeout'));
    sock.once('connect', () => fin(true));
    sock.once('error', (e) => fin(false, e.code === 'ECONNREFUSED' ? 'connection refused' : e.code || e.message));
  });
}

async function refreshUpstreamHealth() {
  const targets = new Map();
  for (const r of state.routes) {
    if (r.enabled === false) continue;
    for (const raw of [r.upstream, r.backupUpstream]) {
      const t = upstreamTarget(raw);
      if (t && !targets.has(t.url)) targets.set(t.url, t);
    }
  }
  for (const [url, t] of targets) {
    const res = await tcpProbeOnce(t.host, t.port);
    upstreamHealth.set(url, { url, ok: res.ok, ms: res.ms, error: res.error, at: Date.now() });
  }
  for (const url of Array.from(upstreamHealth.keys())) if (!targets.has(url)) upstreamHealth.delete(url);
}

/** 规则上游可能带路径前缀，匹配时按 origin+path 前缀宽松比对。 */
function healthOf(raw) {
  const t = upstreamTarget(raw);
  if (!t) return null;
  if (upstreamHealth.has(t.url)) return upstreamHealth.get(t.url);
  for (const [url, v] of upstreamHealth) if (t.url.startsWith(url)) return v;
  return null;
}

// ---------------------------------------------------------------- 运行同步
/** 恢复/导入配置后让运行时跟上：新增的启动、删掉的停掉、参数变了的重启。 */
function syncTunnels(prevTunnels = []) {
  const sig = (x) => JSON.stringify([x.mode, x.token, x.origin, x.publicHostname, x.protocol, x.loglevel, x.metricsPort, x.extraArgs, x.enabled]);
  const prevMap = new Map(prevTunnels.map((t) => [t.id, t]));
  const restarted = [];
  for (const id of Array.from(runtimes.keys())) if (!tunnelById(id)) stopTunnel(id, true);
  for (const t of state.tunnels) {
    const prev = prevMap.get(t.id);
    const rt = tunnelRt(t.id);
    if (!prev) { if (t.enabled) startTunnel(t.id); continue; }
    if (sig(prev) !== sig(t)) {
      restarted.push(t.name || t.id);
      stopTunnel(t.id, true);
      if (t.enabled) startTunnel(t.id);
    } else if (t.enabled && rt.status === 'stopped') startTunnel(t.id);
  }
  return restarted;
}

// ---------------------------------------------------------------- 路由
// ---------------------------------------------------------------- 维护页 / 通知
function maintPage(body) {
  const esc = String(body).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>维护中</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0f172a;color:#e2e8f0;
font:16px/1.7 system-ui,-apple-system,"PingFang SC","Microsoft Yahei",sans-serif;padding:24px}
.box{max-width:560px;text-align:center}.ic{font-size:44px;margin-bottom:8px}
h1{font-size:20px;margin:0 0 10px}p{color:#94a3b8;white-space:pre-wrap;margin:0}</style>
<div class="box"><div class="ic">🛠️</div><h1>站点维护中</h1><p>${esc}</p></div>`;
}

/** 是否落在静默时段（支持跨零点，如 23:00-07:00；可逗号分隔多段）。 */
function inQuietHours(spec, now = new Date()) {
  const raw = String(spec || '').trim();
  if (!raw) return false;
  const minutes = now.getHours() * 60 + now.getMinutes();
  const toMin = (t) => {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(t).trim());
    return m ? (Number(m[1]) % 24) * 60 + Number(m[2]) : NaN;
  };
  return raw.split(',').some((seg) => {
    const parts = seg.split('-');
    if (parts.length !== 2) return false;
    const a = toMin(parts[0]);
    const b = toMin(parts[1]);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
    return a <= b ? (minutes >= a && minutes < b) : (minutes >= a || minutes < b);
  });
}

const lastNotify = new Map(); // event -> 上次发送时间戳（冷却用）
const notifyHistory = [];     // 最近 50 条通知结果，面板里能看到「发过什么、成没成」

function recordNotify(event, title, status, extra = '') {
  notifyHistory.push({ t: Date.now(), event, title, status, extra: String(extra || '') });
  if (notifyHistory.length > 50) notifyHistory.splice(0, notifyHistory.length - 50);
}

async function notify(event, title, text, opts = {}) {
  const n = state.settings.notify || {};
  if (!n.url) return false;
  const ev = n.events || {};
  if (ev[event] === false) return false;
  if (!opts.force) {
    if (inQuietHours(n.quietHours)) {
      log(`通知被静默时段拦下（${event}，当前静默 ${n.quietHours}）`, 'panel');
      recordNotify(event, title, 'skipped', '静默时段');
      return false;
    }
    const cdMs = Math.max(0, Number(n.cooldownSec || 0) * 1000);
    const last = lastNotify.get(event) || 0;
    if (cdMs > 0 && Date.now() - last < cdMs) {
      log(`通知冷却中（${event}，距上次 ${Math.round((Date.now() - last) / 1000)}s < ${n.cooldownSec}s）`, 'panel');
      recordNotify(event, title, 'skipped', '冷却中');
      return false;
    }
    lastNotify.set(event, Date.now());
  }
  const line = `${title}\n${text}`;
  try {
    let url = String(n.url).trim();
    let body = JSON.stringify({ title, text: line, event, ts: new Date().toISOString(), host: os.hostname() });
    const headers = { 'Content-Type': 'application/json' };
    if (n.format === 'dingtalk') body = JSON.stringify({ msgtype: 'text', text: { content: line } });
    else if (n.format === 'feishu') body = JSON.stringify({ msg_type: 'text', content: { text: line } });
    else if (n.format === 'bark') { url = url.replace(/\/+$/, '') + '/' + encodeURIComponent(title) + '/' + encodeURIComponent(text); body = '{}'; }
    const r = await fetch(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(8000) });
    log(`通知已发送（${event}）HTTP ${r.status}`, 'panel');
    recordNotify(event, title, r.ok ? 'ok' : 'fail', `HTTP ${r.status}`);
    return r.ok;
  } catch (e) {
    log(`通知发送失败（${event}）：${e.message}`, 'panel');
    recordNotify(event, title, 'fail', e.message);
    return false;
  }
}

// 出口状态/域名变化 → 通知（5 秒采样一次，不改动引擎）
const seenRt = new Map();
let seenCaddyOk = true;
const HISTORY_MAX = 240;       // 每分钟一个点，240 点 = 4 小时
const rtHistory = [];          // [{t, running, total, caddyOk, req}]
let histTick = 0;

// 最近一分钟的请求数（只读日志尾部 96KB，够一分钟用）
function requestsLastMinute() {
  try {
    const st = fs.statSync(ACCESS_LOG_FILE);
    const span = Math.min(96 * 1024, st.size);
    const fd = fs.openSync(ACCESS_LOG_FILE, 'r');
    const buf = Buffer.alloc(span);
    fs.readSync(fd, buf, 0, span, Math.max(0, st.size - span));
    fs.closeSync(fd);
    const since = Date.now() - 60000;
    let n = 0;
    for (const line of buf.toString('utf8').split('\n')) {
      if (!line.trim().startsWith('{')) continue;
      let o; try { o = JSON.parse(line); } catch { continue; }
      if (!String(o.logger || '').includes('http.log.access')) continue;
      const ts = typeof o.ts === 'number' ? o.ts * 1000 : Date.parse(String(o.ts || ''));
      if (Number.isFinite(ts) && ts >= since) n += 1;
    }
    return n;
  } catch { return null; }
}

function sampleHistory() {
  const running = state.tunnels.filter((t) => (tunnelRt(t.id) || {}).status === 'running').length;
  rtHistory.push({ t: Date.now(), running, total: state.tunnels.length, caddyOk: caddy.ok ? 1 : 0, req: requestsLastMinute() });
  if (rtHistory.length > HISTORY_MAX) rtHistory.splice(0, rtHistory.length - HISTORY_MAX);
}

function startMonitor() {
  setInterval(() => {
    histTick += 1;
    if (histTick % 12 === 0) sampleHistory();
    for (const t of state.tunnels) {
      const rt = tunnelRt(t.id);
      const cur = { status: rt.status, url: rt.url };
      const prev = seenRt.get(t.id);
      if (prev) {
        if (cur.status !== prev.status && (cur.status === 'error' || (prev.status === 'running' && cur.status === 'stopped'))) {
          notify('tunnelDown', `出口「${t.name}」${cur.status === 'error' ? '异常' : '已停止'}`,
            `${rt.lastError || '进程不在了'}\n模式：${t.mode}\n主机：${os.hostname()}`);
        }
        if (cur.url && prev.url && cur.url !== prev.url) {
          notify('urlChange', `出口「${t.name}」换了公网域名`, `旧：${prev.url}\n新：${cur.url}`);
        }
      }
      seenRt.set(t.id, cur);
    }
    if (seenCaddyOk && !caddy.ok) notify('caddyFail', 'Caddy 配置下发失败', String(caddy.error || '未知错误'));
    seenCaddyOk = caddy.ok;
  }, 5000).unref();
}

// ---------------------------------------------------------------- 一次性分享链接
function shareUrl(token) {
  const base = state.tunnels.map(publicUrlOf).filter(Boolean)[0];
  return base ? `${base.replace(/\/+$/, '')}/s/${token}` : `/s/${token}`;
}

function shareJanitor() {
  setInterval(() => {
    const now = Date.now();
    const before = (state.shares || []).length;
    state.shares = (state.shares || []).filter((s) => s.expiresAt > now);
    if (state.shares.length !== before) {
      saveState('share-expire');
      log(`已清理 ${before - state.shares.length} 条过期分享链接`, 'panel');
      pushCaddy().catch(() => {});
    }
  }, 15000).unref();
}

// ---------------------------------------------------------------- Docker 容器
function dockerApi(pathname) {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath: '/var/run/docker.sock', path: pathname, method: 'GET', timeout: 5000 }, (res) => {
      let d = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (d += c));
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`docker API ${res.statusCode}: ${d.slice(0, 160)}`));
        try { resolve(JSON.parse(d)); } catch (e) { reject(new Error('docker API 返回的不是 JSON')); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('docker API 超时')));
    req.end();
  });
}

// 猜哪个端口更像 Web 界面：避开 ssh/数据库/管理端口，优先 80/443/8080/8000/3000/5000 一类
function pickWebPort(list) {
  const bad = new Set([22, 21, 25, 139, 445, 2019, 2022, 2121, 3306, 5432, 6379, 27017, 5672, 9092, 6789, 37291]);
  const good = new Set([80, 443, 3000, 5000, 8000, 8008, 8080, 8081, 8082, 8090, 8443, 9000]);
  const score = (p) => (good.has(p) ? 0 : bad.has(p) ? 3 : p > 1024 && p < 10000 ? 1 : 2);
  return [...list].sort((a, b) => score(a) - score(b) || a - b)[0];
}

async function dockerContainers() {
  let list;
  try {
    list = await dockerApi('/containers/json');
  } catch (e) {
    const hint = e.code === 'ENOENT' || /ENOENT/.test(e.message)
      ? '容器里没有 /var/run/docker.sock（在 docker-compose.yml 的 panel 服务加一行挂载）'
      : e.message;
    return { available: false, error: hint, containers: [] };
  }
  const details = await Promise.all(list.map(async (c) => {
    try { return await dockerApi(`/containers/${c.Id}/json`); } catch { return null; }
  }));
  const containers = list.map((c, idx) => {
    const det = details[idx] || {};
    const hostNet = ((det.HostConfig || {}).NetworkMode === 'host');
    const exposed = Object.keys((det.Config || {}).ExposedPorts || {}).map((x) => Number(String(x).split('/')[0])).filter(Boolean);

    const name = ((c.Names && c.Names[0]) || '').replace(/^\//, '');
    const ports = (c.Ports || []).map((x) => ({ private: x.PrivatePort, public: x.PublicPort, type: x.Type, ip: x.IP }));
    const pub = ports.find((x) => x.type === 'tcp' && x.public);
    const priv = ports.find((x) => x.type === 'tcp' && x.private);
    let upstream = '';
    if (pub) upstream = `http://127.0.0.1:${pub.public}`;
    // host 网络（本栈和很多家庭服务都这么跑）：没有端口映射，容器内端口就是宿主机端口
    if (!upstream && hostNet && exposed.length) upstream = `http://127.0.0.1:${pickWebPort(exposed)}`;
    if (!upstream && priv) {
      const nets = (c.NetworkSettings && c.NetworkSettings.Networks) || {};
      const ip = Object.values(nets).map((n) => n && n.IPAddress).filter(Boolean)[0];
      if (ip) upstream = `http://${ip}:${priv.private}`;
    }
    const allPorts = ports.filter((x) => x.type === 'tcp').map((x) => (x.public ? `${x.public}→${x.private}` : `${x.private}`));
    if (!allPorts.length && exposed.length) allPorts.push(...exposed.map((p) => `${p}(host)`));
    return {
      id: String(c.Id || '').slice(0, 12), name: name || '(未命名)', image: c.Image, state: c.State, status: c.Status,
      ports: allPorts, hostNetwork: hostNet,
      upstream, created: c.Created,
    };
  }).sort((a, b) => (a.state === 'running' ? -1 : 1) - (b.state === 'running' ? -1 : 1) || a.name.localeCompare(b.name));
  return { available: true, containers };
}

// ---------------------------------------------------------------- 面板内 curl 测试器
async function curlSelf(target) {
  const listen = String(state.settings.caddyListen || ':8080');
  const port = listen.split(':').pop() || '8080';
  let p = String(target || '/').trim();
  if (!p.startsWith('/')) p = '/' + p;
  const host = new URL(`http://x${p}`).searchParams.get('__host') || '';
  const started = Date.now();
  try {
    const r = await fetch(`http://127.0.0.1:${port}${p}`, {
      redirect: 'manual',
      headers: host ? { Host: host } : {},
      signal: AbortSignal.timeout(10000),
    });
    const buf = Buffer.from(await r.arrayBuffer());
    const headers = {};
    r.headers.forEach((v, k) => { headers[k] = v; });
    return {
      ok: true, url: `http://127.0.0.1:${port}${p}`, status: r.status,
      ms: Date.now() - started, bytes: buf.length, headers,
      preview: buf.toString('utf8', 0, 600).replace(/\s+/g, ' ').trim(),
    };
  } catch (e) {
    return { ok: false, url: `http://127.0.0.1:${port}${p}`, error: e.message, ms: Date.now() - started };
  }
}

/** 走本机 Caddy 做一次 WebSocket 握手，判断这条规则到底能不能升级成功。 */
function wsProbe(target, hostHeader, timeoutMs = 4000) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(target); } catch (e) { return resolve({ ok: false, error: '路径不合法' }); }
    const t0 = Date.now();
    const key = crypto.randomBytes(16).toString('base64');
    const req = http.request({
      host: u.hostname, port: u.port || 80, path: u.pathname + u.search, method: 'GET',
      headers: {
        Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': key,
        Host: hostHeader || u.host,
      },
    });
    req.setTimeout(timeoutMs, () => { req.destroy(); resolve({ ok: false, error: `超时（${timeoutMs}ms 内没有响应升级）` }); });
    req.on('upgrade', (res, socket) => {
      socket.destroy();
      resolve({ ok: true, status: 101, ms: Date.now() - t0 });
    });
    req.on('response', (res) => {
      res.resume();
      resolve({ ok: false, status: res.statusCode, ms: Date.now() - t0, error: `没有升级成 WebSocket（HTTP ${res.statusCode}，多半是上游不是 WS 服务或规则路径不对）` });
    });
    req.on('error', (e) => resolve({ ok: false, error: e.message }));
    req.end();
  });
}

/** 把某份备份的规则和当前规则对比，返回增/删/改。 */
function diffRoutes(backupRoutes, currentRoutes) {
  const key = (r) => `${r.path || '/'}|${r.tunnelId || ''}|${r.host || ''}`;
  const bm = new Map((backupRoutes || []).map((r) => [r.id, r]));
  const cm = new Map((currentRoutes || []).map((r) => [r.id, r]));
  const skip = new Set(['id']);
  const added = [];
  const removed = [];
  const changed = [];
  for (const [id, r] of cm) {
    const b = bm.get(id);
    if (!b) { added.push({ id, name: r.name, path: r.path, key: key(r) }); continue; }
    const fields = [];
    for (const k of new Set([...Object.keys(b), ...Object.keys(r)])) {
      if (skip.has(k)) continue;
      const a = JSON.stringify(b[k] === undefined ? null : b[k]);
      const c = JSON.stringify(r[k] === undefined ? null : r[k]);
      if (a !== c) fields.push(k);
    }
    if (fields.length) changed.push({ id, name: r.name, path: r.path, fields });
  }
  for (const [id, b] of bm) {
    if (!cm.has(id)) removed.push({ id, name: b.name, path: b.path, key: key(b) });
  }
  return { added, removed, changed };
}


// ---------------------------------------------------------------- 徽章 / metrics
function badgeSvg(label, value, ok) {
  const color = ok ? '#16a34a' : '#dc2626';
  const lw = 8 + label.length * 6.6, vw = 12 + String(value).length * 6.6;
  const w = Math.round(lw + vw);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="20" role="img" aria-label="${label}: ${value}">
<rect width="${w}" height="20" rx="3" fill="#555"/><rect x="${lw}" width="${vw}" height="20" rx="3" fill="${color}"/>
<rect x="${lw}" width="4" height="20" fill="${color}"/><g fill="#fff" font-family="DejaVu Sans,Verdana,sans-serif" font-size="11">
<text x="6" y="14">${label}</text><text x="${lw + 6}" y="14">${value}</text></g></svg>`;
}

function metricsText() {
  const lines = [];
  const run = state.tunnels.filter((t) => tunnelRt(t.id).status === 'running').length;
  lines.push('# HELP cf_tunnel_panel_up 面板本身是否在线');
  lines.push('# TYPE cf_tunnel_panel_up gauge');
  lines.push('cf_tunnel_panel_up 1');
  lines.push('# HELP cf_tunnel_running 正在运行的隧道出口数');
  lines.push('# TYPE cf_tunnel_running gauge');
  lines.push(`cf_tunnel_running ${run}`);
  lines.push('# HELP cf_tunnel_routes 生效的代理规则数');
  lines.push('# TYPE cf_tunnel_routes gauge');
  lines.push(`cf_tunnel_routes ${caddy.routeCount || 0}`);
  lines.push('# HELP cf_caddy_ok Caddy 配置是否下发成功');
  lines.push('# TYPE cf_caddy_ok gauge');
  lines.push('cf_caddy_ok ' + (caddy.ok ? 1 : 0));
  lines.push('# HELP cf_tunnel_up 单个出口是否在线（1=在线）');
  lines.push('# TYPE cf_tunnel_up gauge');
  for (const t of state.tunnels) {
    const rt = tunnelRt(t.id);
    lines.push(`cf_tunnel_up{id="${t.id}",name="${String(t.name).replace(/"/g, '')}"} ${rt.status === 'running' ? 1 : 0}`);
  }
  const acc = readAccess(200);
  if (acc.available) {
    lines.push('# HELP cf_tunnel_requests_total 访问日志里的请求数（按状态码分组）');
    lines.push('# TYPE cf_tunnel_requests_total counter');
    for (const [k, v] of Object.entries((acc.summary && acc.summary.byStatus) || {})) lines.push(`cf_tunnel_requests_total{status="${k}"} ${v}`);
  }
  return lines.join('\n') + '\n';
}

// ---------------------------------------------------------------- Cloudflare API
async function cfApi(pathname, { method = 'GET', body } = {}) {
  const cf = state.settings.cf || {};
  if (!cf.token) throw new Error('还没填 Cloudflare API Token（设置卡「Cloudflare API」里填）');
  const r = await fetch(`https://api.cloudflare.com/client/v4${pathname}`, {
    method,
    headers: { Authorization: `Bearer ${cf.token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000),
  });
  const j = await r.json().catch(() => null);
  if (!j) throw new Error(`Cloudflare API 返回的不是 JSON（HTTP ${r.status}）`);
  if (!r.ok || j.success === false) {
    const msg = (j.errors || []).map((e) => e.message).join('；') || `HTTP ${r.status}`;
    throw new Error(`Cloudflare API 失败：${msg}`);
  }
  return j.result;
}

const uiHtml = () => fs.readFileSync(UI_FILE, 'utf8');

function readPage(file) {
  try {
    return fs.readFileSync(path.join(PAGE_DIR, file + '.html'), 'utf8');
  } catch {
    return `<div class="content"><div class="card"><div class="bd"><div class="hint err">页面 ${file} 缺失，请检查 src/web/pages/</div></div></div></div>`;
  }
}

// 整页外壳：左侧导航 + 顶部标题栏 + 页面主体
function pageShell(active, body) {
  const title = state.settings.panelTitle || 'Cloudflare 隧道面板';
  const nav = PAGES.map((pg) => {
    const on = pg.path === active ? ' active' : '';
    return `<a class="${on ? 'active' : ''}" href="${pg.path}"><span class="ico">${pg.ico}</span><span>${pg.title}</span></a>`;
  }).join('');
  const activePage = PAGES.find((x) => x.path === active) || PAGES[0];
  return `<!doctype html>
<html lang="zh-CN" data-theme="dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${activePage.title} · ${title}</title>
<link rel="stylesheet" href="/assets/app.css">
<link rel="icon" href="/badge.svg" type="image/svg+xml">
</head>
<body>
<a class="skip-link" href="#main">跳到主内容</a>
<div class="shell">
  <aside class="side" aria-label="侧边导航">
    <div class="brand"><span class="logo" aria-hidden="true">CF</span><div><div class="nm">${title}</div><div class="ver">v${VERSION}</div></div></div>
    <nav class="nav" aria-label="页面导航">${nav}</nav>
    <div class="side-foot">
      <div class="row"><span class="dot" id="healthDot" aria-hidden="true"></span><span class="muted" id="healthText" role="status">检测中…</span></div>
      <div class="row"><button class="sm ghost" id="btnTheme" title="切换深色 / 浅色" aria-label="切换深色或浅色主题">🌙</button>
      <button class="sm ghost" id="btnPalette" title="命令面板（Ctrl+K）" aria-label="打开命令面板">⌘K</button>
      <a class="sm ghost" href="/legacy" target="_blank" rel="noreferrer" title="旧版单页面">旧版</a></div>
      <div class="muted" style="font-size:11px">© <span id="year"></span> cf-tunnel-panel</div>
    </div>
  </aside>
  <main class="main" id="main">
${body}
  </main>
</div>
<script src="/assets/app.js"></script>
<script src="/assets/${activePage.file}.js"></script>
</body>
</html>`;
}

// 文本响应：带 ETag（命中 304）+ gzip，省流量也省得每次重传
const rlHits = new Map();

/** /api 的粗粒度限流：同一来源每分钟超过 1200 次直接 429（防误点也能防暴力枚举）。 */
function rateLimited(ip) {
  const now = Date.now();
  const b = rlHits.get(ip) || { n: 0, reset: now + 60000 };
  if (now > b.reset) { b.n = 0; b.reset = now + 60000; }
  b.n += 1;
  rlHits.set(ip, b);
  if (rlHits.size > 800) for (const [k, v] of rlHits) if (v.reset < now) rlHits.delete(k);
  return b.n > 1200;
}

const SEC_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'SAMEORIGIN',
};

function serveText(req, res, body, type, cache = 'no-cache') {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8');
  const etag = 'W/"' + buf.length.toString(16) + '-' + crypto.createHash('sha1').update(buf).digest('hex').slice(0, 12) + '"';
  const headers = { 'Content-Type': type, 'Cache-Control': cache, ETag: etag, Vary: 'Accept-Encoding', ...SEC_HEADERS };
  if (/^text\/html/.test(type)) {
    headers['Content-Security-Policy'] = "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'";
  }
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, headers);
    return res.end();
  }
  const ae = String(req.headers['accept-encoding'] || '');
  if (buf.length > 512 && /\bgzip\b/.test(ae) && /text|json|javascript|svg/.test(type)) {
    const gz = zlib.gzipSync(buf, { level: 6 });
    headers['Content-Encoding'] = 'gzip';
    headers['Content-Length'] = gz.length;
    res.writeHead(200, headers);
    return res.end(gz);
  }
  headers['Content-Length'] = buf.length;
  res.writeHead(200, headers);
  return res.end(buf);
}

async function handler(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const p = url.pathname;

  if (p === '/healthz') {
    const running = state.tunnels.filter((t) => tunnelRt(t.id).status === 'running').length;
    return sendJson(res, 200, {
      ok: true,
      tunnels: { total: state.tunnels.length, running },
      tunnel: running > 0 ? 'running' : state.tunnels.length ? 'stopped' : 'none',
      version: VERSION,
    });
  }
  // 状态徽章：故意放在鉴权之前，方便 README / 监控页直接贴 <img src=".../badge.svg">
  if (p === '/badge.svg') {
    const run = state.tunnels.filter((t) => tunnelRt(t.id).status === 'running').length;
    const svg = badgeSvg('cloudflared', `${run}/${state.tunnels.length} up`, run > 0);
    res.writeHead(200, { 'Content-Type': 'image/svg+xml; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(svg);
  }
  // 监控端点：免登录，方便 Prometheus 直接抓（内容只有聚合计数，不含 token/规则细节）
  if (p === '/metrics') {
    res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(metricsText());
  }

  const auth = checkAuth(req);
  // 只读账号：能看不能改
  if (auth.ok && auth.readonly && req.method !== 'GET' && req.method !== 'HEAD') {
    return sendJson(res, 403, { ok: false, error: '当前是只读账号，不能修改任何配置' });
  }
  if (!auth.ok) {
    const wait = authBlockedFor(req);
    if (wait > 0) {
      res.writeHead(429, { 'Retry-After': String(wait), 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end(`登录失败次数过多，${Math.ceil(wait / 60)} 分钟后再试`);
    }
    if (auth.tried) {
      noteAuthFail(req);
      const st = authFails.get(clientIpOf(req)) || {};
      const left = Math.max(0, AUTH_FAIL_LIMIT - (st.count || 0));
      log(`面板登录失败（${clientIpOf(req)}，本窗口还剩 ${left} 次机会）`, 'panel');
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="cf-tunnel-panel"', 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end(left > 0 ? `用户名或密码不对（还剩 ${left} 次机会）` : '错误次数过多，已临时锁定');
    }
    res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="cf-tunnel-panel"' });
    return res.end('需要登录');
  }
  if (auth.tried) clearAuthFail(req);

  // 前端静态资源
  if (p === '/__bench/ping') {
    return sendJson(res, 200, { ok: true, colo: coloOf(req), t: Date.now() });
  }
  if (p === '/__bench/blob') {
    return sendBenchBlob(req, res, url);
  }
  if (p === '/api/bench/local' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const n = Math.min(20, Math.max(1, Number(body && body.n) || 5));
      const port = Number(process.env.CADDY_PORT || '8080');
      const out = [];
      for (let i = 0; i < n; i += 1) out.push(await benchLocalOnce(port));
      const good = out.filter((x) => x.ok).map((x) => x.ttfbMs).sort((a, b) => a - b);
      return sendJson(res, 200, {
        ok: good.length > 0,
        port,
        samples: out,
        ttfbMs: good.length ? { min: good[0], median: good[Math.floor(good.length / 2)], max: good[good.length - 1] } : null,
      });
    } catch (e) {
      return sendJson(res, 400, { ok: false, error: e.message });
    }
  }

  if (p.startsWith('/assets/')) {
    const name = path.basename(p.slice('/assets/'.length));
    const file = path.join(ASSET_DIR, name);
    if (fs.existsSync(file) && fs.statSync(file).isFile()) {
      const type = ASSET_TYPES[path.extname(name).toLowerCase()] || 'application/octet-stream';
      return serveText(req, res, fs.readFileSync(file), type);
    }
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('404');
  }

  // 新版多页面
  const page = PAGES.find((x) => x.path === p || x.path === p.replace(/\/$/, ''));
  if (page) {
    return serveText(req, res, pageShell(page.path, readPage(page.file)), 'text/html; charset=utf-8', 'no-store');
  }

  // 旧版单页（保留以便随时回退）
  if (p === '/legacy' || p === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    try {
      return res.end(uiHtml());
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('旧版页面已移除');
    }
  }

  if (p === '/api/state' && req.method === 'GET') {
    return sendJson(res, 200, {
      version: VERSION,
      state: {
        settings: publicSettings(),
        tunnels: publicTunnels(),
        routes: state.routes.map(publicRoute),
        panel: { authEnabled: !!state.panel.user, user: state.panel.user || '' },
      },
      runtime: {
        tunnels: state.tunnels.map((t) => {
          const rt = tunnelRt(t.id);
          return {
            id: t.id, name: t.name, status: rt.status, pid: rt.pid, url: rt.url,
            startedAt: rt.startedAt, lastError: rt.lastError, publicUrl: publicUrlOf(t),
            reconnects: rt.reconnects || 0,
            uptimeSec: rt.status === 'running' && rt.startedAt ? Math.round((Date.now() - rt.startedAt) / 1000) : 0,
          };
        }),
        caddy: { ok: caddy.ok, error: caddy.error, lastPush: caddy.lastPush, routeCount: caddy.routeCount, listen: state.settings.caddyListen, skipped: lastSkipped, shadowed: shadowReport() },
        upstreams: Array.from(upstreamHealth.values()),
        publicUrl: (state.tunnels.map(publicUrlOf).filter(Boolean)[0]) || null,
        host: os.hostname(),
        lanIps: Object.values(os.networkInterfaces()).flat().filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i.address),
        uptimeSec: Math.round(process.uptime()),
      },
    });
  }

  if (p === '/api/caddy/config' && req.method === 'GET') {
    try {
      return sendJson(res, 200, { ok: true, config: buildCaddyConfig() });
    } catch (e) {
      return sendJson(res, 200, { ok: false, error: e.message });
    }
  }

  if (p === '/api/rules/test' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      return sendJson(res, 200, await probeUpstream(body.upstream));
    } catch (e) {
      return sendJson(res, 400, { ok: false, error: e.message });
    }
  }

  if (p === '/api/match' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      return sendJson(res, 200, simulateMatch(body.path, body.host, body.method));
    } catch (e) {
      return sendJson(res, 400, { ok: false, error: e.message });
    }
  }

  if (p === '/api/access' && req.method === 'GET') {
    const limit = Math.max(1, Math.min(500, Number(url.searchParams.get('limit') || 100)));
    return sendJson(res, 200, readAccess(limit));
  }

  if (p === '/api/routes' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      state.routes = validateRoutes(body.routes, state.routes);
      saveState('routes');
      await pushCaddy();
      return sendJson(res, 200, { ok: true, routes: state.routes.map(publicRoute), caddy });
    } catch (e) {
      return sendJson(res, 400, { ok: false, error: e.message });
    }
  }

  if (p === '/api/settings' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      if (typeof body.caddyListen === 'string' && body.caddyListen.trim()) {
        const v = body.caddyListen.trim();
        if (!/^(:\d+|[\d.]+:\d+)$/.test(v)) throw new Error('监听地址格式应为 :8080 或 127.0.0.1:8080');
        state.settings.caddyListen = v;
      }
      if (typeof body.notFoundBody === 'string') state.settings.notFoundBody = body.notFoundBody.slice(0, 2000);
      if (typeof body.panelTitle === 'string') state.settings.panelTitle = body.panelTitle.slice(0, 60);

      if (body.maintenance && typeof body.maintenance === 'object') {
        const m = body.maintenance;
        state.settings.maintenance = {
          on: !!m.on,
          body: String(m.body === undefined ? state.settings.maintenance.body : m.body).slice(0, 2000),
          retryAfter: Math.max(1, Math.min(86400, Number(m.retryAfter) || 300)),
        };
      }
      if (body.security && typeof body.security === 'object') {
        const sec = body.security;
        const deny = String(sec.ipDeny || '').slice(0, 2000);
        parseCidrs(deny); // 校验，不合法直接抛
        state.settings.security = {
          ipDeny: deny,
          rateLimit: {
            enabled: !!(sec.rateLimit && sec.rateLimit.enabled),
            rps: Math.max(0, Math.min(100000, Number((sec.rateLimit || {}).rps) || 0)),
            burst: Math.max(0, Math.min(100000, Number((sec.rateLimit || {}).burst) || 0)),
          },
        };
      }
      if (body.notify && typeof body.notify === 'object') {
        const n = body.notify;
        const given = String(n.url || '').trim();
        if (given && !/^https?:\/\//i.test(given)) throw new Error('通知地址必须是 http:// 或 https:// 开头');
        // 空字符串 = 不改（前端拿到的是脱敏值）；要清空请传 clearUrl: true
        const url = n.clearUrl === true ? '' : (given || state.settings.notify.url || '');
        const quiet = String(n.quietHours === undefined ? (state.settings.notify.quietHours || '') : n.quietHours).trim();
        if (quiet && !/^\d{1,2}:\d{2}-\d{1,2}:\d{2}(,\s*\d{1,2}:\d{2}-\d{1,2}:\d{2})*$/.test(quiet)) {
          throw new Error('静默时段格式应为 23:00-07:00（多段用逗号分隔）');
        }
        const cool = n.cooldownSec === undefined ? (state.settings.notify.cooldownSec || 0) : n.cooldownSec;
        state.settings.notify = {
          url,
          format: ['generic', 'dingtalk', 'feishu', 'bark'].includes(n.format) ? n.format : 'generic',
          events: {
            tunnelDown: n.events ? n.events.tunnelDown !== false : true,
            urlChange: n.events ? n.events.urlChange !== false : true,
            caddyFail: n.events ? n.events.caddyFail !== false : true,
          },
          cooldownSec: Math.max(0, Math.min(86400, Number(cool) || 0)),
          quietHours: quiet,
        };
      }
      if (body.cf && typeof body.cf === 'object') {
        state.settings.cf = {
          token: String(body.cf.token === undefined ? (state.settings.cf || {}).token : body.cf.token).slice(0, 200).trim(),
          accountId: String(body.cf.accountId === undefined ? (state.settings.cf || {}).accountId : body.cf.accountId).slice(0, 64).trim(),
          zoneId: String(body.cf.zoneId === undefined ? (state.settings.cf || {}).zoneId : body.cf.zoneId).slice(0, 64).trim(),
        };
      }
      saveState('settings');
      await pushCaddy();
      return sendJson(res, 200, { ok: true, settings: publicSettings(), caddy });
    } catch (e) {
      return sendJson(res, 400, { ok: false, error: e.message });
    }
  }

  // ---- 多隧道出口 CRUD
  if (p === '/api/tunnels' && req.method === 'GET') {
    return sendJson(res, 200, { ok: true, tunnels: publicTunnels().map((t) => ({ ...t, ...runtimeOf(t.id) })) });
  }
  if (p === '/api/tunnels' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      if (state.tunnels.length >= 8) throw new Error('最多 8 个隧道出口，够用了吧');
      const t = applyTunnelFields(newTunnel(), body);
      state.tunnels.push(t);
      saveState('tunnel-add');
      if (t.enabled) startTunnel(t.id);
      return sendJson(res, 200, { ok: true, id: t.id, tunnels: publicTunnels().map((x) => ({ ...x, ...runtimeOf(x.id) })) });
    } catch (e) {
      return sendJson(res, 400, { ok: false, error: e.message });
    }
  }

  if (p === '/api/tunnels/start-all' && req.method === 'POST') { startAll(); return sendJson(res, 200, { ok: true }); }
  if (p === '/api/tunnels/stop-all' && req.method === 'POST') { stopAll(); return sendJson(res, 200, { ok: true }); }

  const tm = p.match(/^\/api\/tunnels\/([\w-]+)(?:\/(start|stop|restart|delete))?$/);
  if (tm && req.method === 'POST') {
    const t = tunnelById(tm[1]);
    if (!t) return sendJson(res, 404, { ok: false, error: '这个隧道出口不存在（可能已被删除）' });
    const action = tm[2];
    if (action === 'delete') {
      stopTunnel(t.id, true);
      state.tunnels = state.tunnels.filter((x) => x.id !== t.id);
      if (!state.tunnels.length) state.tunnels = [newTunnel({ id: 'main', name: '主隧道出口' })];
      runtimes.delete(t.id);
      saveState('tunnel-del');
      return sendJson(res, 200, { ok: true, tunnels: publicTunnels() });
    }
    if (action === 'start') { startTunnel(t.id); return sendJson(res, 200, { ok: true, status: tunnelRt(t.id).status }); }
    if (action === 'stop') { stopTunnel(t.id); return sendJson(res, 200, { ok: true, status: tunnelRt(t.id).status }); }
    if (action === 'restart') { startTunnel(t.id); return sendJson(res, 200, { ok: true, status: tunnelRt(t.id).status }); }
    try {
      const body = await readBody(req);
      applyTunnelFields(t, body);
      saveState('tunnel');
      startTunnel(t.id);
      return sendJson(res, 200, { ok: true, id: t.id, status: tunnelRt(t.id).status, tunnels: publicTunnels() });
    } catch (e) {
      return sendJson(res, 400, { ok: false, error: e.message });
    }
  }

  // 旧接口（单隧道时代）保留，作用于第一个出口，方便老脚本/书签继续用
  if (p === '/api/tunnel' && req.method === 'POST') {
    const t0 = firstTunnel();
    const body = await readBody(req);
    applyTunnelFields(t0, body);
    saveState('tunnel');
    startTunnel(t0.id);
    return sendJson(res, 200, { ok: true, tunnel: { status: tunnelRt(t0.id).status, mode: t0.mode } });
  }
  if (p === '/api/tunnel/start' && req.method === 'POST') { startAll(); return sendJson(res, 200, { ok: true }); }
  if (p === '/api/tunnel/stop' && req.method === 'POST') { stopAll(); return sendJson(res, 200, { ok: true }); }

  if (p === '/api/caddy/push' && req.method === 'POST') { const c = await pushCaddy(); return sendJson(res, 200, { ok: c.ok, caddy: c }); }

  if (p === '/api/panel-auth' && req.method === 'POST') {
    const body = await readBody(req);
    state.panel.user = String(body.user || '').trim();
    state.panel.pass = String(body.pass || '');
    saveState('panel-auth');
    return sendJson(res, 200, { ok: true, authEnabled: !!state.panel.user });
  }

  if (p === '/api/qr' && req.method === 'GET') {
    const text = url.searchParams.get('text') || state.tunnels.map(publicUrlOf).filter(Boolean)[0] || '';
    if (!text) return sendJson(res, 400, { ok: false, error: '没有可编码的内容' });
    try {
      return sendJson(res, 200, { ok: true, text, dataUrl: await QRCode.toDataURL(text, { margin: 1, width: 360, errorCorrectionLevel: 'M' }) });
    } catch (e) {
      return sendJson(res, 500, { ok: false, error: e.message });
    }
  }

  if (p === '/api/logs' && req.method === 'GET') {
    const after = Number(url.searchParams.get('after') || 0);
    return sendJson(res, 200, { logs: logs.filter((l) => l.seq > after), last: logSeq });
  }

  if (p === '/api/logs/stream') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write('retry: 3000\n\n');
    for (const l of logs.slice(-80)) res.write(`data: ${JSON.stringify(l)}\n\n`);
    sseClients.add(res);
    const ka = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 20000);
    req.on('close', () => { clearInterval(ka); sseClients.delete(res); });
    return;
  }

  // 导出/导入：整份配置（可脱敏）
  if (p === '/api/export' && req.method === 'GET') {
    const full = url.searchParams.get('full') === '1';
    const copy = JSON.parse(JSON.stringify(state));
    if (!full) {
      (copy.tunnels || []).forEach((t) => { t.token = ''; });
      copy.panel.pass = '';
    }
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="cf-tunnel-panel-${Date.now()}.json"`,
    });
    return res.end(JSON.stringify(copy, null, 2));
  }

  if (p === '/api/import' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      if (!body || typeof body !== 'object') throw new Error('导入内容必须是 JSON 对象');
      const merged = deepDefault(body, defaultState());
      merged.routes = validateRoutes(merged.routes || [], state.routes);
      // 导入不该抹掉密钥：导出默认会去掉 token / CF API token / 通知地址，
      // 如果导入的文件里这些字段是空的，就沿用当前配置里的值（同 id 的隧道逐个合并）。
      const prevTunnels = new Map((state.tunnels || []).map((t) => [t.id, t]));
      merged.tunnels = (merged.tunnels || []).map((t) => {
        const old = prevTunnels.get(t.id);
        if (old && !t.token && old.token) t.token = old.token;
        return t;
      });
      if (merged.settings && merged.settings.cf && !merged.settings.cf.token && state.settings.cf.token) {
        merged.settings.cf.token = state.settings.cf.token;
      }
      if (merged.settings && merged.settings.notify && !merged.settings.notify.url && state.settings.notify.url) {
        merged.settings.notify.url = state.settings.notify.url;
      }
      // 面板/只读密码同样不能被脱敏导出抹掉：用户同名且文件里密码为空 → 沿用当前密码
      if (merged.panel) {
        if (!merged.panel.user && state.panel.user) merged.panel = state.panel;
        else if (!merged.panel.pass && state.panel.pass && merged.panel.user === state.panel.user) merged.panel.pass = state.panel.pass;
      }
      if (merged.viewer) {
        if (!merged.viewer.pass && state.viewer && state.viewer.pass && merged.viewer.user === state.viewer.user) {
          merged.viewer.pass = state.viewer.pass;
        }
        if (!merged.viewer.user) merged.viewer = { user: '', pass: '' };
      }
      state = merged;
      saveState('import');
      await pushCaddy();
      normalizeTunnels();
      startAll();
      return sendJson(res, 200, { ok: true, routeCount: state.routes.length });
    } catch (e) {
      return sendJson(res, 400, { ok: false, error: e.message });
    }
  }

  if (p === '/api/backups/diff' && req.method === 'GET') {
    try {
      const name = String(url.searchParams.get('a') || '').trim();
      if (!/^[\w.\-]+\.json$/.test(path.basename(name))) throw new Error('备份文件名不合法');
      const file = path.join(BACKUP_DIR, path.basename(name));
      if (!fs.existsSync(file)) throw new Error('找不到这份备份');
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      migrateState(parsed);
      const oldState = deepDefault(parsed, defaultState());
      const d = diffRoutes(oldState.routes, state.routes);
      return sendJson(res, 200, { ok: true, against: path.basename(name), currentRoutes: state.routes.length, backupRoutes: oldState.routes.length, ...d });
    } catch (e) {
      return sendJson(res, 400, { ok: false, error: e.message });
    }
  }

  if (p === '/api/backups' && req.method === 'GET') {
    try {
      const files = fs.readdirSync(BACKUP_DIR).sort().reverse().slice(0, 20);
      return sendJson(res, 200, { ok: true, files });
    } catch {
      return sendJson(res, 200, { ok: true, files: [] });
    }
  }

  // 一键回滚到某份滚动备份
  if (p === '/api/backups/restore' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const name = path.basename(String(body.file || ''));
      if (!/^[\w.\-]+\.json$/.test(name)) throw new Error('备份文件名不合法');
      const file = path.join(BACKUP_DIR, name);
      if (!fs.existsSync(file)) throw new Error('备份不存在：' + name);
      const prevTunnels = JSON.parse(JSON.stringify(state.tunnels));
      const obj = JSON.parse(fs.readFileSync(file, 'utf8'));
      migrateState(obj);
      const next = deepDefault(obj, defaultState());
      next.routes = validateRoutes(next.routes || [], state.routes);
      next.version = 3;
      state = next;
      normalizeTunnels();
      saveState('restore');
      await pushCaddy();
      const restarted = syncTunnels(prevTunnels);
      log(`已回滚到备份 ${name}（${state.routes.length} 条规则${restarted.length ? '，重启出口：' + restarted.join('、') : ''}）`, 'panel');
      return sendJson(res, 200, { ok: true, file: name, routeCount: state.routes.length, restarted });
    } catch (e) {
      return sendJson(res, 400, { ok: false, error: e.message });
    }
  }

  // ---- Docker 容器（一键加规则）
  if (p === '/api/docker/containers' && req.method === 'GET') {
    return sendJson(res, 200, await dockerContainers());
  }

  // ---- 通知测试
  if (p === '/api/viewer' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const user = String(body.user || '').trim();
      const pass = String(body.pass || '');
      if (user && !/^[\w.@-]{1,40}$/.test(user)) throw new Error('只读账号名只能用字母数字和 . _ - @');
      if (user && pass && pass.length < 6) throw new Error('只读密码至少 6 位');
      if (!user) state.viewer = { user: '', pass: '' };
      else {
        state.viewer = { user, pass: pass || (state.viewer && state.viewer.pass) || '' };
        if (!state.viewer.pass) throw new Error('只读账号还要给一个密码');
      }
      saveState('viewer');
      log(user ? `已设置只读账号 ${user}` : '已关闭只读账号', 'panel');
      return sendJson(res, 200, { ok: true, viewer: { user: state.viewer.user, hasPass: !!state.viewer.pass } });
    } catch (e) {
      return sendJson(res, 400, { ok: false, error: e.message });
    }
  }

  if (p === '/api/notify/test' && req.method === 'POST') {
    const okSent = await notify('test', '面板通知测试', `${state.tunnels.length} 个出口，${state.routes.length} 条规则`);
    return sendJson(res, 200, { ok: okSent, configured: !!state.settings.notify.url });
  }

  // ---- 一次性分享链接
  if (p === '/api/shares' && req.method === 'GET') {
    return sendJson(res, 200, {
      shares: (state.shares || []).map((s) => ({ ...s, url: shareUrl(s.token), leftSec: Math.max(0, Math.round((s.expiresAt - Date.now()) / 1000)) })),
    });
  }
  if (p === '/api/shares' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const up = String(body.upstream || '').trim();
      if (!up) throw new Error('上游地址不能为空');
      parseUpstream(up);
      const minutes = Math.max(1, Math.min(10080, Number(body.minutes) || 30));
      const s = {
        id: rid(), token: crypto.randomBytes(9).toString('base64url'),
        name: String(body.name || '临时分享').slice(0, 60), upstream: up,
        createdAt: Date.now(), expiresAt: Date.now() + minutes * 60000,
      };
      state.shares = [...(state.shares || []), s];
      saveState('share-add');
      await pushCaddy();
      log(`已生成分享链接 ${s.name} → ${up}（${minutes} 分钟）`, 'panel');
      return sendJson(res, 200, { ok: true, share: { ...s, url: shareUrl(s.token) }, caddy });
    } catch (e) {
      return sendJson(res, 400, { ok: false, error: e.message });
    }
  }
  const sm = p.match(/^\/api\/shares\/([\w-]+)\/delete$/);
  if (sm && req.method === 'POST') {
    const before = (state.shares || []).length;
    state.shares = (state.shares || []).filter((s) => s.id !== sm[1]);
    if (state.shares.length === before) return sendJson(res, 404, { ok: false, error: '这条分享链接不存在' });
    saveState('share-del');
    await pushCaddy();
    return sendJson(res, 200, { ok: true, caddy });
  }

  // ---- 面板内 curl 测试器（只打本机 Caddy，安全）
  if (p === '/api/ws-test' && req.method === 'POST') {
    const body = await readBody(req);
    const caddyPort = (String((state.settings || {}).caddyListen || ':8080').split(':').pop() || '8080');
    const target = `http://127.0.0.1:${caddyPort}${body.path || '/'}`;
    const r = await wsProbe(target, body.host ? String(body.host).trim() : `127.0.0.1:${caddyPort}`);
    log(`WS 自测 ${body.path || '/'} → ${r.ok ? '可升级（101）' : r.error}`, 'panel');
    return sendJson(res, 200, { ok: !!r.ok, target, ...r });
  }

  if (p === '/api/curl' && req.method === 'POST') {
    const body = await readBody(req);
    return sendJson(res, 200, await curlSelf(body.path || '/'));
  }

  // ---- 日志下载
  if (p === '/api/logs/download' && req.method === 'GET') {
    const text = logs.map((l) => `[${new Date(l.t || Date.now()).toISOString()}] (${l.source}) ${l.line}`).join('\n');
    res.writeHead(200, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Disposition': `attachment; filename="cf-tunnel-panel-log-${Date.now()}.txt"`,
    });
    return res.end(text);
  }

  // ---- Prometheus metrics
  if (p === '/metrics' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(metricsText());
  }

  // ---- Cloudflare API
  if (p === '/api/cf/tunnels' && req.method === 'GET') {
    try {
      const cf = state.settings.cf || {};
      if (!cf.accountId) throw new Error('还没填 Account ID（设置卡「Cloudflare API」里填）');
      const list = await cfApi(`/accounts/${cf.accountId}/cfd_tunnel?is_deleted=false`);
      return sendJson(res, 200, {
        ok: true,
        tunnels: (list || []).map((t) => ({ id: t.id, name: t.name, status: t.status, createdAt: t.created_at, connections: (t.connections || []).length })),
      });
    } catch (e) {
      return sendJson(res, 400, { ok: false, error: e.message });
    }
  }
  if (p === '/api/cf/tunnels' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const cf = state.settings.cf || {};
      if (!cf.accountId) throw new Error('还没填 Account ID');
      const name = String(body.name || '').trim();
      if (!/^[\w.-]{1,60}$/.test(name)) throw new Error('隧道名只能包含字母数字和 . _ -，最长 60');
      const tun = await cfApi(`/accounts/${cf.accountId}/cfd_tunnel`, { method: 'POST', body: { name, config_src: 'cloudflare' } });
      const token = await cfApi(`/accounts/${cf.accountId}/cfd_tunnel/${tun.id}/token`).catch(() => '');
      let dns = null;
      const hostname = String(body.hostname || '').trim();
      if (hostname && cf.zoneId) {
        dns = await cfApi(`/zones/${cf.zoneId}/dns_records`, {
          method: 'POST',
          body: { type: 'CNAME', name: hostname, content: `${tun.id}.cfargotunnel.com`, proxied: true, comment: 'created by cf-tunnel-panel' },
        }).catch((e) => ({ error: e.message }));
      }
      let localId = null;
      if (body.addLocal && token) {
        const t = applyTunnelFields(newTunnel(), { name, mode: 'named', token, publicHostname: hostname });
        state.tunnels.push(t);
        saveState('cf-tunnel-add');
        if (t.enabled) startTunnel(t.id);
        localId = t.id;
      }
      return sendJson(res, 200, { ok: true, tunnel: tun, token: token ? '已获取' : '获取失败（可在 Cloudflare 后台复制）', dns, localId });
    } catch (e) {
      return sendJson(res, 400, { ok: false, error: e.message });
    }
  }
  const cdm = p.match(/^\/api\/cf\/tunnels\/([\w-]+)\/delete$/);
  // --- Cloudflare API 增强：验证 token / 账号域名发现 / 隧道详情 / DNS 记录 ---
  if (p === '/api/traffic') {
    const hours = Math.min(72, Math.max(1, Number(url.searchParams.get('hours')) || 12));
    return sendJson(res, 200, { ok: true, ...trafficByHour(hours) });
  }
  if (p === '/api/history') return sendJson(res, 200, { ok: true, points: rtHistory, max: HISTORY_MAX });
  if (p === '/api/notify/history') return sendJson(res, 200, { ok: true, items: notifyHistory.slice().reverse() });
  if (p === '/api/system') return sendJson(res, 200, { ok: true, ...systemInfo() });

  if (p === '/api/cf/verify' && req.method === 'GET') {
    try {
      const cf = state.settings.cf || {};
      if (!cf.token) throw new Error('还没填 Cloudflare API Token（设置卡「Cloudflare API」里填）');
      const out = { ok: true, token: '', accounts: [], zones: [] };
      let verifyErr = '';
      try { await cfApi('/user/tokens/verify'); out.token = '有效'; }
      catch (e) { verifyErr = e.message; }
      try { out.accounts = (await cfApi('/accounts?per_page=50') || []).map((a) => ({ id: a.id, name: a.name })); } catch {}
      try { out.zones = (await cfApi('/zones?per_page=50') || []).map((z) => ({ id: z.id, name: z.name, status: z.status })); } catch {}
      if (!out.token) {
        out.token = (out.accounts.length || out.zones.length)
          ? '有效（这个 token 不能调 /user/tokens/verify，但账号和域名都读到了，够用）'
          : '无效：' + verifyErr;
      }
      if (!out.accounts.length && !out.zones.length) out.ok = false;
      out.suggest = {
        accountId: (cf.accountId || (out.accounts[0] && out.accounts[0].id) || ''),
        zoneId: (cf.zoneId || (out.zones[0] && out.zones[0].id) || ''),
      };
      return sendJson(res, 200, out);
    } catch (e) {
      return sendJson(res, 400, { ok: false, error: e.message });
    }
  }
  {
    const m = p.match(/^\/api\/cf\/tunnels\/([\w-]+)$/);
    if (m && req.method === 'GET') {
      try {
        const cf = state.settings.cf || {};
        if (!cf.accountId) throw new Error('还没填 Account ID');
        const t = await cfApi(`/accounts/${cf.accountId}/cfd_tunnel/${m[1]}`);
        return sendJson(res, 200, {
          ok: true,
          tunnel: {
            id: t.id,
            name: t.name,
            status: t.status,
            createdAt: t.created_at,
            connections: (t.connections || []).map((c) => ({ colo: c.colo_name, id: c.id, client: c.client_version, opened: c.opened_at })),
          },
        });
      } catch (e) { return sendJson(res, 400, { ok: false, error: e.message }); }
    }
    const mt = p.match(/^\/api\/cf\/tunnels\/([\w-]+)\/token$/);
    if (mt && req.method === 'POST') {
      try {
        const cf = state.settings.cf || {};
        if (!cf.accountId) throw new Error('还没填 Account ID');
        const token = await cfApi(`/accounts/${cf.accountId}/cfd_tunnel/${mt[1]}/token`);
        return sendJson(res, 200, { ok: true, token });
      } catch (e) { return sendJson(res, 400, { ok: false, error: e.message }); }
    }
  }
  if (p === '/api/cf/dns' && req.method === 'GET') {
    try {
      const cf = state.settings.cf || {};
      if (!cf.zoneId) throw new Error('还没填 Zone ID（设置卡里点「验证 token」可以自动带出来）');
      const name = url.searchParams.get('name') || '';
      const q = `/zones/${cf.zoneId}/dns_records?per_page=100` + (name ? `&name=${encodeURIComponent(name)}` : '');
      const list = await cfApi(q);
      return sendJson(res, 200, { ok: true, records: (list || []).map((r) => ({ id: r.id, type: r.type, name: r.name, content: r.content, proxied: r.proxied, ttl: r.ttl })) });
    } catch (e) { return sendJson(res, 400, { ok: false, error: e.message }); }
  }
  if (p === '/api/cf/dns' && req.method === 'POST') {
    try {
      const cf = state.settings.cf || {};
      if (!cf.zoneId) throw new Error('还没填 Zone ID');
      const body = await readBody(req);
      const type = String(body.type || 'CNAME').toUpperCase();
      const name = String(body.name || '').trim();
      const content = String(body.content || '').trim();
      if (!/^[A-Z]{1,6}$/.test(type)) throw new Error('记录类型不合法');
      if (!name) throw new Error('要填主机名（例如 panel.example.com）');
      if (!content) throw new Error('要填目标（隧道就是 <隧道ID>.cfargotunnel.com）');
      const rec = await cfApi(`/zones/${cf.zoneId}/dns_records`, {
        method: 'POST',
        body: { type, name, content, proxied: body.proxied !== false, comment: 'created by cf-tunnel-panel' },
      });
      log(`已创建 DNS 记录 ${type} ${name} → ${content}`, 'panel');
      return sendJson(res, 200, { ok: true, record: { id: rec.id, type: rec.type, name: rec.name, content: rec.content } });
    } catch (e) { return sendJson(res, 400, { ok: false, error: e.message }); }
  }
  {
    const md = p.match(/^\/api\/cf\/dns\/([\w-]+)\/delete$/);
    if (md && req.method === 'POST') {
      try {
        const cf = state.settings.cf || {};
        if (!cf.zoneId) throw new Error('还没填 Zone ID');
        await cfApi(`/zones/${cf.zoneId}/dns_records/${md[1]}`, { method: 'DELETE' });
        log(`已删除 DNS 记录 ${md[1]}`, 'panel');
        return sendJson(res, 200, { ok: true });
      } catch (e) { return sendJson(res, 400, { ok: false, error: e.message }); }
    }
  }

  if (cdm && req.method === 'POST') {
    try {
      const cf = state.settings.cf || {};
      if (!cf.accountId) throw new Error('还没填 Account ID');
      await cfApi(`/accounts/${cf.accountId}/cfd_tunnel/${cdm[1]}`, { method: 'DELETE' });
      return sendJson(res, 200, { ok: true });
    } catch (e) {
      return sendJson(res, 400, { ok: false, error: e.message });
    }
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('not found');
}

// ---------------------------------------------------------------- 启动
loadState();
const onReq = (req, res) => {
  const ip = (req.socket && req.socket.remoteAddress) || 'unknown';
  if (String(req.url || '').startsWith('/api/') && rateLimited(ip)) {
    res.writeHead(429, { 'Content-Type': 'application/json; charset=utf-8', 'Retry-After': '10' });
    return res.end('{"ok":false,"error":"请求太频繁，稍后再试"}');
  }
  handler(req, res).catch((e) => {
    log(`请求处理异常 ${req.method} ${req.url}: ${e.stack || e.message}`, 'panel');
    try { sendJson(res, 500, { ok: false, error: e.message }); } catch {}
  });
};
// 面板 HTTPS：挂载证书后设 PANEL_TLS_CERT / PANEL_TLS_KEY 即可（见 README §10）
const tlsOpts = (() => {
  const c = process.env.PANEL_TLS_CERT, k = process.env.PANEL_TLS_KEY;
  if (!c || !k) return null;
  try { return { cert: fs.readFileSync(c), key: fs.readFileSync(k) }; }
  catch (e) { log(`面板 HTTPS 证书读取失败（${e.message}），退回 HTTP`, 'panel'); return null; }
})();
const server = tlsOpts ? https.createServer(tlsOpts, onReq) : http.createServer(onReq);

server.listen(PORT, '0.0.0.0', async () => {
  log(`面板已启动 v${VERSION}: ${tlsOpts ? 'https' : 'http'}://0.0.0.0:${PORT}（数据目录 ${DATA_DIR}）`, 'panel');
  await pushCaddy();
  startAll();
  startMonitor();
  refreshUpstreamHealth().catch(() => {});
  setInterval(() => { refreshUpstreamHealth().catch(() => {}); }, 60000).unref();
  shareJanitor();
});

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => { stopAll(); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 3000); });
}
process.on('uncaughtException', (e) => log(`未捕获异常: ${e.stack || e.message}`, 'panel'));
