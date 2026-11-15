'use strict';
/**
 * 探测工具（上游 TCP+HTTP、链路自测、WebSocket 升级）
 * 从 src/server.js 按职责拆出（v0.9.0），仅做搬运，行为不变。
 */

const http=require('http'); const https=require('https'); const crypto=require('crypto');
const zlib=require('zlib'); const net=require('net'); const fs=require('fs');
const path=require('path'); const os=require('os'); const { spawn }=require('child_process');
const QRCode=require('qrcode'); const bcrypt=require('bcryptjs');

const _state = require('./state');
const state = _state.stateProxy;
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

module.exports = { curlSelf, probeUpstream, wsProbe };
