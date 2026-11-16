'use strict';
/**
 * cf-tunnel-panel —— 可视化 cloudflared 隧道 + Caddy 反向代理面板
 *
 * 这个文件现在只做三件事：
 *   1) 把 src/core/* 的模块装配起来（依赖注入式，模块之间不互相抓全局）；
 *   2) 定义 HTTP 路由 handler（唯一的路由表）；
 *   3) 启动进程（loadState → pushCaddy → startAll → startMonitor）。
 *
 * 各模块分工见 README §12「代码结构」。
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

const _audit = require('./core/audit');
const { record: auditRecord, list: auditList, stats: auditStats, byHour: auditByHour, actionOf } = _audit;

const _paths = require('./core/paths');
const { ACCESS_LOG_FILE, ASSET_DIR, ASSET_TYPES, BACKUP_DIR, CADDY_ADMIN, CADDY_LOG_DIR, CLOUDFLARED, CLOUDFLARE_DEFAULT_RANGES, DATA_DIR, LB_POLICIES, LOGLEVELS, LOG_MAX, METHODS, PAGES, PAGE_DIR, PORT, PROTOCOLS, STATE_FILE, VERSION, WEB_DIR, accessLogPathForCaddy, pkgVersion } = _paths;

const _util = require('./core/util');
const { SEC_HEADERS, log, logSeq, logs, parseCidrs, parseHeaderLines, parseUpstream, rateLimited, readBody, rid, rlHits, sendJson, sseClients } = _util;

const _state = require('./core/state');
const { acquireLock } = _state;
const { stateProxy, setState, deepDefault, defaultOrigin, defaultState, loadState, migrateState, newTunnel, normalizeTunnels, publicRoute, publicSettings, saveState, validateRoutes } = _state;
// 注意：必须是 stateProxy（指向模块内部同一个对象），直接把 state 解构出来会拿到
// loadState() 之前那个默认对象，导致 /api/state 看到的路由/出口数量和真实的不一致。
const state = stateProxy;

const _registry = require('./core/registry');
const { firstTunnel, publicUrlOf, runtimes, tunnelById, tunnelRt } = _registry;

const _auth = require('./core/auth');
const { clearBasicCache, AUTH_BLOCK_MS, AUTH_FAIL_LIMIT, AUTH_FAIL_WINDOW, authBlockedFor, authFails, authOk, checkAuth, clearAuthFail, clientIpOf, noteAuthFail, login , completeTotp } = _auth;

const _session = require('./core/session');
const session = _session;

const secret = require('./core/secret');
const ident = require('./core/ident');
const totp = require('./core/totp');
const perm = require('./core/perm');

const _caddy = require('./core/caddy');
const { buildCaddyConfig, buildMatch, buildRouteHandlers, caddy, cloudflareRanges, lastSkipped, maintPage, tunnelHostOf } = _caddy;

const _pusher = require('./core/pusher');
const { pushCaddy, pushTimer, schedulePush } = _pusher;

const _tunnels = require('./core/tunnels');
const { QUICK_RE, applyTunnelFields, normalizeTunnelToken, publicTunnels, runtimeOf, startAll, startTunnel, stopAll, stopTunnel, syncTunnels, tokenTunnelOf, tunnelArgs } = _tunnels;

const _insight = require('./core/insight');
const { upstreamHealth, HISTORY_MAX, badgeSvg, diffRoutes, healthOf, histTick, metricsText, readAccess, refreshUpstreamHealth, requestsLastMinute, rtHistory, sampleHistory, securityAttempts, shadowReport, simulateMatch, systemInfo, tcpProbeOnce, trafficByHour, trafficByPath, upstreamTarget } = _insight;

const _bench = require('./core/bench');
const { BENCH_MAX_MB, benchLocalOnce, coloOf, sendBenchBlob } = _bench;

const _probe = require('./core/probe');
const { curlSelf, probeUpstream, wsProbe } = _probe;

const _integrations = require('./core/integrations');
const { cfApi, dockerApi, dockerContainers, pickWebPort } = _integrations;

const _notify = require('./core/notify');
const { inQuietHours, notify, notifyHistory, recordNotify } = _notify;

const _i18n = require('./core/i18n');
const { langOf } = _i18n;

const _web = require('./core/web');
const { pageShell, readPage, serveText, loginPage } = _web;

const _monitor = require('./core/monitor');
const { seenCaddyOk, shareJanitor, shareUrl, startMonitor } = _monitor;

async function handler(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const p = url.pathname;

  if (p === '/healthz') {
    const running = state.tunnels.filter((t) => tunnelRt(t.id).status === 'running').length;
    let build = {};
    try { build = ident.buildInfo(); } catch { build = {}; }
    return sendJson(res, 200, {
      ok: true,
      tunnels: { total: state.tunnels.length, running },
      tunnel: running > 0 ? 'running' : state.tunnels.length ? 'stopped' : 'none',
      version: VERSION,
      // 代码指纹：drift=true 说明容器里是 docker cp 热替换的代码，跟镜像不一致
      code: build.code || null,
      imageCode: build.build || null,
      sha: build.sha || null,
      drift: !!build.drift,
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

  // ---------- 登录页与会话接口（必须在鉴权门之前）----------
  const wantsPage = req.method === 'GET' && (p === '/' || PAGES.some((x) => x.path === p || x.path === p.replace(/\/$/, '')));
  if (p === '/login' && req.method === 'GET') {
    const cur = session.fromReq(req);
    if (cur) { res.writeHead(302, { Location: url.searchParams.get('next') || '/' }); return res.end(); }
    return serveText(req, res, loginPage({ next: url.searchParams.get('next') || '/', error: url.searchParams.get('e') || '', lang: langOf(req) }), 'text/html; charset=utf-8', 'no-store');
  }
  if (p === '/api/login' && req.method === 'POST') {
    const wait = authBlockedFor(req);
    if (wait > 0) return sendJson(res, 429, { ok: false, error: `尝试次数过多，${Math.ceil(wait / 60)} 分钟后再试`, retryAfter: wait });
    let body = {};
    try { body = await readBody(req); } catch { body = {}; }
    const ip = clientIpOf(req);
    const ua = req.headers['user-agent'] || '';

    // 第二段：口令已过，等验证码（或恢复码）
    if (body.challenge) {
      const r = completeTotp({ challenge: body.challenge, code: body.code, ip, ua, remember: !!body.remember });
      if (!r.ok) {
        noteAuthFail(req);
        log(`二次验证失败（${ip}）：${r.error}`, 'panel');
        auditRecord({ actor: `(二次验证)`, ip, method: 'POST', path: '/api/login', status: 401, action: '二次验证失败', target: String(r.error || ''), ok: false });
        return sendJson(res, 401, { ok: false, error: r.error });
      }
      clearAuthFail(req);
      auditRecord({ actor: r.session.user, ip, method: 'POST', path: '/api/login', status: 200, action: r.usedRecovery ? '登录成功（恢复码）' : '登录成功（二次验证）', target: r.session.role });
      res.setHeader('Set-Cookie', session.cookieHeader(r.session.rawId || r.session.id || '', { secure: session.isSecure(req), remember: !!body.remember }));
      return sendJson(res, 200, { ok: true, user: r.session.user, role: r.session.role, usedRecovery: !!r.usedRecovery });
    }

    const s2 = login({ user: body.user, pass: body.pass, ip, ua, remember: !!body.remember });
    if (!s2) {
      noteAuthFail(req);
      const st = authFails.get(ip) || {};
      const left = Math.max(0, AUTH_FAIL_LIMIT - (st.count || 0));
      log(`面板登录失败（${ip}，本窗口还剩 ${left} 次机会）`, 'panel');
      auditRecord({ actor: `${String(body.user || '(空)')}（口令错误）`, ip, method: 'POST', path: '/api/login', status: 401, action: '登录失败', target: String(body.user || ''), ok: false });
      return sendJson(res, 401, { ok: false, error: left > 0 ? `用户名或密码不对（还剩 ${left} 次机会）` : '错误次数过多，已临时锁定', left });
    }
    if (s2.needTotp) {
      log(`口令通过，等二次验证码（${ip}，${s2.user}）`, 'panel');
      return sendJson(res, 200, { ok: false, needTotp: true, challenge: s2.challenge, role: s2.role });
    }
    clearAuthFail(req);
    log(`面板登录成功（${ip}，${s2.user}${s2.role === 'viewer' ? ' 只读' : s2.role === 'operator' ? ' 运维' : ''}）`, 'panel');
    auditRecord({ actor: s2.user, ip, method: 'POST', path: '/api/login', status: 200, action: '登录成功', target: s2.role });
    res.setHeader('Set-Cookie', session.cookieHeader(s2.rawId || s2.id || '', { secure: session.isSecure(req), remember: !!(body && body.remember) }));
    return sendJson(res, 200, { ok: true, user: s2.user, role: s2.role });
  }
  if (p === '/api/logout' && req.method === 'POST') {
    const s = session.fromReq(req);
    if (s) session.revoke(s.rawId || s.key);
    res.setHeader('Set-Cookie', session.clearCookieHeader());
    return sendJson(res, 200, { ok: true });
  }

  // 静态资源不需要登录：登录页自己也要用 app.css，而且它们不含任何密钥。
  // 放在鉴权之前还有个好处：Cloudflare 能把这些 URL 当公开资源缓存。
  if (p.startsWith('/assets/') && (req.method === 'GET' || req.method === 'HEAD')) {
    const name = path.basename(p.slice('/assets/'.length));
    const file = path.join(ASSET_DIR, name);
    if (fs.existsSync(file) && fs.statSync(file).isFile()) {
      const type = ASSET_TYPES[path.extname(name).toLowerCase()] || 'application/octet-stream';
      // 页面引用资源时带 ?v=<代码指纹>：URL 随代码变化，可以放心给「一年 + immutable」
      const hashed = /[?&]v=/.test(req.url || '');
      const cc = hashed ? 'public, max-age=31536000, immutable' : 'public, max-age=300';
      const cdn = hashed ? 'public, max-age=31536000' : 'public, max-age=86400';
      return serveText(req, res, fs.readFileSync(file), type, cc,
        { 'CDN-Cache-Control': cdn, 'Cloudflare-CDN-Cache-Control': cdn });
    }
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('404');
  }

  const auth = checkAuth(req);
  req.__who = auth.who || '(未登录)';
  // 角色权限矩阵：admin 全通；operator 只能碰运维类写接口；viewer 只读
  if (auth.ok) {
    const gate = perm.check(auth.role || 'admin', req.method, p);
    if (!gate.ok) return sendJson(res, 403, { ok: false, error: gate.error, code: gate.code || 'forbidden' });
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
    if (wantsPage) {
      res.writeHead(302, { Location: `/login?next=${encodeURIComponent(p)}` });
      return res.end();
    }
    res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="cf-tunnel-panel"' });
    return res.end('需要登录');
  }
  if (auth.tried) clearAuthFail(req);

  // 会话登录的写操作要防 CSRF：cookie 是浏览器自动带的，第三方页面能发起跨站表单 POST。
  // SameSite=Lax 已经挡掉大部分，这里再要求同源标记，双保险。
  if (auth.via === 'session' && !/^(GET|HEAD|OPTIONS)$/.test(req.method)) {
    const site = String(req.headers['sec-fetch-site'] || '');
    const origin = String(req.headers.origin || '');
    const host = String(req.headers.host || '');
    const sameOrigin = site === 'same-origin' || (origin && host && origin.replace(/^https?:\/\//, '') === host);
    if (!sameOrigin && site) {
      auditRecord({ actor: auth.who, ip: clientIpOf(req), method: req.method, path: p, status: 403, action: '跨站请求被拦下', ok: false });
      return sendJson(res, 403, { ok: false, error: '跨站请求被拒绝（CSRF 防护）：请刷新页面后重试' });
    }
  }

  // 会话管理
  if (p === '/api/sessions' && req.method === 'GET') {
    return sendJson(res, 200, { ok: true, cookie: session.COOKIE, sessions: session.list(auth.sid), ttlDays: Math.round(session.TTL_MS / 86400000) });
  }
  if (p === '/api/sessions/revoke' && req.method === 'POST') {
    const body = await readBody(req).catch(() => ({}));
    const full = session.resolveKey(body && body.id);
    if (!full) return sendJson(res, 404, { ok: false, error: '这个会话已经不存在了（可能已过期或被踢）' });
    const isSelf = full === auth.sid;
    session.revoke(full);
    if (isSelf) res.setHeader('Set-Cookie', session.clearCookieHeader());
    return sendJson(res, 200, { ok: true, self: isSelf });
  }
  if (p === '/api/sessions/revoke-all' && req.method === 'POST') {
    const n = session.revokeAll();
    res.setHeader('Set-Cookie', session.clearCookieHeader());
    auditRecord({ actor: auth.who, ip: clientIpOf(req), method: 'POST', path: p, status: 200, action: '退出全部登录会话', target: `${n} 个` });
    return sendJson(res, 200, { ok: true, revoked: n });
  }
  if (p === '/api/sessions/revoke-others' && req.method === 'POST') {
    const n = session.revokeOthers(auth.sid);
    return sendJson(res, 200, { ok: true, revoked: n });
  }

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

  // 新版多页面
  const page = PAGES.find((x) => x.path === p || x.path === p.replace(/\/$/, ''));
  if (page) {
    return serveText(req, res, pageShell(page.path, readPage(page.file), langOf(req)), 'text/html; charset=utf-8',
      'no-store, no-transform', { 'Cloudflare-CDN-Cache-Control': 'no-store' });
  }

  // 旧版单页（保留以便随时回退）
  if (p === '/api/audit/trend' && req.method === 'GET') {
    return sendJson(res, 200, { ok: true, buckets: auditByHour(url.searchParams.get('hours') || 12) });
  }

  if (p === '/api/audit' && req.method === 'GET') {
    return sendJson(res, 200, { ...auditList({ limit: url.searchParams.get('limit'), q: url.searchParams.get('q') || '' }), stats: auditStats() });
  }

  if (p === '/api/state' && req.method === 'GET') {
    return sendJson(res, 200, {
      version: VERSION,
      state: {
        settings: publicSettings(),
        tunnels: publicTunnels(),
        routes: state.routes.map(publicRoute),
        panel: { authEnabled: !!state.panel.user, user: state.panel.user || '' },
        warm: state.warm || null,
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

  // 按规则聚合访问日志：谁在被访问、谁在报错、哪条慢
  if (p === '/api/routes/stats' && req.method === 'GET') {
    const url = new URL(req.url, 'http://x');
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 2000, 50), 8000);
    const d = readAccess(limit);
    const rows = (d && d.rows) || [];
    const acc = new Map(); // index -> {count, s2, s3, s4, s5, durs, bytes}
    const unmatched = { count: 0, s4: 0, s5: 0 };
    for (const r of rows) {
      const path = String(r.uri || '/').split('?')[0];
      const m = simulateMatch(path, r.host || '', r.method || 'GET');
      const idx = m && m.matched ? (m.ofIndex != null ? m.ofIndex : m.index - 1) : -1;
      const st = Number(r.status) || 0;
      if (idx < 0) {
        unmatched.count += 1;
        if (st >= 500) unmatched.s5 += 1; else if (st >= 400) unmatched.s4 += 1;
        continue;
      }
      let a = acc.get(idx);
      if (!a) { a = { count: 0, s1: 0, s2: 0, s3: 0, s4: 0, s5: 0, durs: [], bytes: 0 }; acc.set(idx, a); }
      a.count += 1;
      if (st >= 500) a.s5 += 1; else if (st >= 400) a.s4 += 1; else if (st >= 300) a.s3 += 1; else if (st >= 200) a.s2 += 1; else if (st >= 100) a.s1 += 1;
      if (r.durMs) a.durs.push(r.durMs);
      a.bytes += Number(r.size) || 0;
    }
    const pct = (arr, p) => {
      if (!arr.length) return 0;
      const q = arr.slice().sort((x, y) => x - y);
      return q[Math.min(q.length - 1, Math.max(0, Math.round((p / 100) * (q.length - 1))))];
    };
    const list = [...acc.entries()].map(([idx, a]) => {
      const rule = state.routes[idx] || {};
      return {
        index: idx, id: rule.id, name: rule.name || rule.path || '(未命名)', path: rule.path || '',
        host: rule.host || '', tunnelId: rule.tunnelId || '',
        count: a.count, ok: a.s2 + a.s3 + a.s1, err4: a.s4, err5: a.s5, upgraded: a.s1,
        errRate: a.count ? Math.round(((a.s4 + a.s5) / a.count) * 1000) / 10 : 0,
        p50: pct(a.durs, 50), p95: pct(a.durs, 95), max: a.durs.length ? Math.max(...a.durs) : 0,
        avg: a.durs.length ? Math.round(a.durs.reduce((x, y) => x + y, 0) / a.durs.length) : 0,
        bytes: a.bytes,
      };
    }).sort((a, b) => b.count - a.count);
    return sendJson(res, 200, {
      ok: true, available: !!d.available, sampled: rows.length, totalRoutes: state.routes.length,
      unmatched, routes: list, note: d.note || '',
    });
  }

  if (p === '/api/security/attempts' && req.method === 'GET') {
    const hours = Number(url.searchParams.get('hours') || 24);
    const limit = Number(url.searchParams.get('limit') || 3000);
    return sendJson(res, 200, securityAttempts(hours, limit));
  }

  if (p === '/api/access' && req.method === 'GET') {
    const limit = Math.max(1, Math.min(500, Number(url.searchParams.get('limit') || 100)));
    const d = readAccess(limit);
    // 给每行标上它命中的规则，前端才能「点日志跳到规则」
    const rows = ((d && d.rows) || []).map((r) => {
      const m = simulateMatch(String(r.uri || '/').split('?')[0], r.host || '', r.method || 'GET');
      const idx = m && m.matched ? (m.ofIndex != null ? m.ofIndex : m.index - 1) : -1;
      const rule = idx >= 0 ? state.routes[idx] : null;
      return rule ? Object.assign({}, r, { rule: { id: rule.id, name: rule.name } }) : r;
    });
    return sendJson(res, 200, Object.assign({}, d, { rows }));
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
        const prevN = state.settings.notify || {};
        const cool = n.cooldownSec === undefined ? (prevN.cooldownSec || 0) : n.cooldownSec;
        const fmt = ['generic', 'dingtalk', 'feishu', 'bark'].includes(n.format) ? n.format
          : (['generic', 'dingtalk', 'feishu', 'bark'].includes(prevN.format) ? prevN.format : 'generic');
        // 每种格式的地址长得完全不一样，填错了只会「静默不送达」，所以在保存时就挡住
        const shape = {
          dingtalk: [/^https:\/\/oapi\.dingtalk\.com\/robot\/send/i, '钉钉机器人地址形如 https://oapi.dingtalk.com/robot/send?access_token=…（在群设置 → 机器人 → 自定义 → Webhook 里复制）'],
          feishu: [/^https:\/\/(open\.feishu\.cn|open\.larksuite\.com)\/open-apis\/bot\/v2\/hook\//i, '飞书机器人地址形如 https://open.feishu.cn/open-apis/bot/v2/hook/xxxx（群设置 → 群机器人 → 添加 → 自定义机器人）'],
          bark: [/^https?:\/\/[^/]+\/./i, 'Bark 地址形如 https://api.day.app/你的Key（自建服务器就填你的域名/Key）'],
        }[fmt];
        if (url && shape && !shape[0].test(url)) throw new Error(`通知地址和「${fmt}」格式不匹配：${shape[1]}`);
        // 加签密钥：空 = 保留旧值；要清空传 clearSecret: true
        const secretGiven = String(n.secret || '').trim();
        const secret = n.clearSecret === true ? '' : (secretGiven || state.settings.notify.secret || '');
        state.settings.notify = {
          url,
          format: fmt,
          secret,
          events: n.events && typeof n.events === 'object'
            ? {
              tunnelDown: n.events.tunnelDown !== false,
              urlChange: n.events.urlChange !== false,
              caddyFail: n.events.caddyFail !== false,
              sessionIp: n.events.sessionIp !== false,
              errorSpike: n.events.errorSpike !== false,
              loginFail: n.events.loginFail !== false,
              authScan: n.events.authScan !== false,
            }
            : (prevN.events || { tunnelDown: true, urlChange: true, caddyFail: true, sessionIp: true }),
          cooldownSec: Math.max(0, Math.min(86400, Number(cool) || 0)),
          quietHours: quiet,
          template: {
            title: String((n.template && n.template.title) !== undefined ? n.template.title : ((prevN.template || {}).title || '')).slice(0, 120),
            text: String((n.template && n.template.text) !== undefined ? n.template.text : ((prevN.template || {}).text || '')).slice(0, 500),
          },
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

  // ---------- 运维账号（admin 专属，perm 已挡） ----------
  if (p === '/api/operator' && req.method === 'POST') {
    const body = await readBody(req);
    const oUser = String(body.user || '').trim();
    const oPass = String(body.pass || '');
    if (oUser && !/^[\w.@-]{1,40}$/.test(oUser)) return sendJson(res, 400, { ok: false, error: '账号只能是字母数字和 . _ @ -' });
    if (oUser && oPass && oPass.length < 6) return sendJson(res, 400, { ok: false, error: '运维账号密码至少 6 位' });
    state.operator.user = oUser;
    if (!oUser) state.operator.pass = '';
    else if (oPass) state.operator.pass = secret.hash(oPass);
    saveState('operator');
    clearBasicCache();
    const kicked = oUser ? session.revokeAll() : 0;
    if (kicked) res.setHeader('Set-Cookie', session.clearCookieHeader());
    log(oUser ? `运维账号已设置：${oUser}（旧会话已全部失效）` : '运维账号已关闭', 'panel');
    return sendJson(res, 200, { ok: true, operator: { user: oUser, hasPass: !!state.operator.pass }, revoked: kicked, relogin: kicked > 0 });
  }

  // ---------- 二次验证 TOTP（admin 专属） ----------
  if (p === '/api/totp/setup' && req.method === 'POST') {
    const s3 = totp.newSecret();
    state.totp.pending = s3;
    saveState('totp-setup');
    const otpauth = totp.otpauthUrl({ secret: s3, label: state.panel.user || 'admin', issuer: 'cf-tunnel-panel' });
    let qr = '';
    try { qr = await QRCode.toDataURL(otpauth, { margin: 1, width: 240 }); } catch { qr = ''; }
    log('已生成 TOTP 密钥，等待验证码确认', 'panel');
    return sendJson(res, 200, { ok: true, secret: s3, otpauth, qr });
  }
  if (p === '/api/totp/enable' && req.method === 'POST') {
    const body = await readBody(req);
    const pending = (state.totp && state.totp.pending) || '';
    if (!pending) return sendJson(res, 400, { ok: false, error: '先点「生成二维码」，用手机 App 扫一下' });
    if (totp.verify(pending, body.code) === null) return sendJson(res, 400, { ok: false, error: '验证码不对：确认手机时间准确，再输入当前 6 位数字' });
    const rec = totp.newRecovery(10);
    state.totp = { enabled: true, secret: pending, pending: '', recovery: rec.hashed };
    saveState('totp-enable');
    auditRecord({ actor: auth.who, ip: clientIpOf(req), method: 'POST', path: p, status: 200, action: '开启二次验证', target: 'TOTP' });
    log('二次验证已开启（下次登录需要 6 位验证码）', 'panel');
    return sendJson(res, 200, { ok: true, enabled: true, recoveryCodes: rec.plain });
  }
  if (p === '/api/totp/disable' && req.method === 'POST') {
    const body = await readBody(req);
    const conf = state.totp || {};
    let okCode = false;
    if (conf.secret && /^\d{6}$/.test(String(body.code || '').trim())) okCode = totp.verify(conf.secret, body.code) !== null;
    if (!okCode && body.code) {
      const h = totp.hashRecovery(body.code);
      okCode = ((conf.recovery || []).indexOf(h) >= 0);
    }
    if (!okCode) return sendJson(res, 400, { ok: false, error: '要关掉二次验证，得先输入一个当前验证码或恢复码' });
    state.totp = { enabled: false, secret: '', pending: '', recovery: [] };
    saveState('totp-disable');
    auditRecord({ actor: auth.who, ip: clientIpOf(req), method: 'POST', path: p, status: 200, action: '关闭二次验证', target: '' });
    log('二次验证已关闭', 'panel');
    return sendJson(res, 200, { ok: true, enabled: false });
  }

  if (p === '/api/totp/recovery' && req.method === 'POST') {
    const body = await readBody(req);
    const conf = state.totp || {};
    if (!conf.enabled || !conf.secret) return sendJson(res, 400, { ok: false, error: '二次验证还没开启' });
    const code = String(body.code || '').trim();
    let pass = false;
    if (/^\d{6}$/.test(code)) pass = totp.verify(conf.secret, code) !== null;
    if (!pass && code) pass = ((conf.recovery || []).indexOf(totp.hashRecovery(code)) >= 0);
    if (!pass) return sendJson(res, 400, { ok: false, error: '要重新生成恢复码，得先输入当前验证码或一个旧恢复码' });
    const pack = totp.newRecovery(10);
    state.totp.recovery = pack.hashed;
    saveState('totp-recovery');
    auditRecord({ actor: auth.who, ip: clientIpOf(req), method: 'POST', path: p, status: 200, action: '重新生成恢复码', target: '10 个' });
    log('已重新生成 10 个恢复码，旧的全部作废', 'panel');
    return sendJson(res, 200, { ok: true, recovery: pack.plain });
  }

  if (p === '/api/panel-auth' && req.method === 'POST') {
    const body = await readBody(req);
    const pUser = String(body.user || '').trim();
    const pPass = String(body.pass || '');
    if (pUser && pPass.length < 4) return sendJson(res, 400, { ok: false, error: '面板密码至少 4 位' });
    state.panel.user = pUser;
    // 口令只存 bcrypt 哈希：state.json、备份、导出里都不再出现明文
    state.panel.pass = pPass ? secret.hash(pPass) : '';
    saveState('panel-auth');
    clearBasicCache();
    // 改口令等于「我不相信现在所有还登着的设备」：全踢，让所有人重新登录。
    const kicked = state.panel.user ? session.revokeAll() : 0;
    if (kicked) {
      res.setHeader('Set-Cookie', session.clearCookieHeader());
      log(`面板口令已更新，已踢掉 ${kicked} 个登录会话`, 'panel');
      auditRecord({ actor: auth.who, ip: clientIpOf(req), method: 'POST', path: p, status: 200, action: '改面板口令并踢掉所有会话', target: `${kicked} 个` });
    }
    return sendJson(res, 200, { ok: true, authEnabled: !!state.panel.user, relogin: kicked > 0, revoked: kicked });
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
  // 配置即代码：把可公开的配置导成 YAML，方便进 git 做 diff / review
  if (p === '/api/export.yaml' && req.method === 'GET') {
    const scalar = (v) => (v === null || v === undefined ? 'null'
      : typeof v === 'number' || typeof v === 'boolean' ? String(v)
        : JSON.stringify(String(v)));
    const toYaml = (v, ind = 0) => {
      const pad = '  '.repeat(ind);
      if (v === null || v === undefined || typeof v !== 'object') return scalar(v);
      if (Array.isArray(v)) {
        if (!v.length) return '[]';
        return '\n' + v.map((x) => {
          if (x && typeof x === 'object' && !Array.isArray(x)) {
            const keys = Object.keys(x).filter((k) => x[k] !== undefined);
            const first = keys.slice(0, 1).map((k) => `${k}: ${toYaml(x[k], ind + 2)}`).join('');
            const rest = keys.slice(1).map((k) => {
              const val = toYaml(x[k], ind + 2);
              return pad + '  ' + k + ':' + (val.startsWith('\n') ? val : ' ' + val);
            });
            return [pad + '- ' + first, ...rest].join('\n');
          }
          return pad + '- ' + toYaml(x, ind + 1).replace(/^\n/, '');
        }).join('\n');
      }
      const keys = Object.keys(v).filter((k) => v[k] !== undefined);
      if (!keys.length) return '{}';
      return '\n' + keys.map((k) => {
        const val = toYaml(v[k], ind + 1);
        return pad + k + ':' + (val.startsWith('\n') ? val : ' ' + val);
      }).join('\n');
    };
    const dump = {
      version: 1,
      exportedAt: new Date().toISOString(),
      settings: publicSettings(),
      tunnels: publicTunnels().map((t) => ({ id: t.id, name: t.name, mode: t.mode, enabled: t.enabled, origin: t.origin, publicHostname: t.publicHostname, protocol: t.protocol, loglevel: t.loglevel, metricsPort: t.metricsPort })),
      routes: state.routes.map((r) => ({ id: r.id, name: r.name, path: r.path, host: r.host, upstream: r.upstream, strip: r.strip, tunnelId: r.tunnelId, methods: r.matchMethod, ipAllow: r.ipAllow, timeoutSec: r.timeoutSec, backupUpstream: r.backupUpstream, note: r.note })),
    };
    const body = '# cf-tunnel-panel 配置快照（不含任何密钥）\n' + toYaml(dump).replace(/^\n/, '');
    res.writeHead(200, { 'Content-Type': 'application/yaml; charset=utf-8', 'Content-Disposition': 'attachment; filename="cf-tunnel-panel.yaml"' });
    return res.end(body);
  }

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
      if (merged.settings && merged.settings.notify && !merged.settings.notify.secret && state.settings.notify.secret) {
        merged.settings.notify.secret = state.settings.notify.secret;
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
      setState(merged);
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
      setState(next);
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
        state.viewer = { user, pass: pass ? secret.hash(pass) : ((state.viewer && state.viewer.pass) || '') };
        if (!state.viewer.pass) throw new Error('只读账号还要给一个密码');
      }
      saveState('viewer');
      clearBasicCache();
      const kickedViewer = session.revokeAll();
      if (kickedViewer) res.setHeader('Set-Cookie', session.clearCookieHeader());
      log(user ? `已设置只读账号 ${user}` : '已关闭只读账号', 'panel');
      return sendJson(res, 200, { ok: true, viewer: { user: state.viewer.user, hasPass: !!state.viewer.pass }, relogin: kickedViewer > 0, revoked: kickedViewer });
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
  // ---- 命名隧道的「公共主机名」管理（Cloudflare 隧道配置 API，v0.12 新增）----
  // 以前这一步只能去 Cloudflare 后台点，面板只能提醒"只建 CNAME 会 1033"。
  // 现在直接读写 cf d_tunnel/{id}/configurations：加/删主机名 = 改 ingress 规则。
  const cfIngress = p.match(/^\/api\/cf\/tunnels\/([0-9a-fA-F-]{36})\/ingress$/);
  if (cfIngress && req.method === 'GET') {
    try {
      const cf = state.settings.cf || {};
      if (!cf.accountId) throw new Error('还没填 Account ID（设置 → Cloudflare API）');
      const r = await cfApi(`/accounts/${cf.accountId}/cfd_tunnel/${cfIngress[1]}/configurations`);
      const cfg = (r && r.config) || {};
      const ingress = (cfg.ingress || []).filter((x) => x && x.hostname);
      return sendJson(res, 200, { ok: true, ingress, raw: cfg });
    } catch (e) {
      return sendJson(res, 400, { ok: false, error: e.message });
    }
  }

  if (/^\/api\/cf\/tunnels\/[0-9a-fA-F-]{36}\/hostnames$/.test(p) && req.method === 'POST') {
    try {
      const tid = p.split('/')[4];
      const body = await readBody(req);
      const cf = state.settings.cf || {};
      if (!cf.accountId) throw new Error('还没填 Account ID（设置 → Cloudflare API）');
      const hostname = String(body.hostname || '').trim().toLowerCase();
      if (!/^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/.test(hostname)) throw new Error('域名格式不对，例如 app.example.com');
      const service = String(body.service || '').trim();
      if (!/^(https?:\/\/|ssh:\/\/|tcp:\/\/)[^\s]{1,300}$/i.test(service)) {
        throw new Error('上游要写成 http://127.0.0.1:8080 / ssh://localhost:22 这样的完整地址');
      }
      const cur = await cfApi(`/accounts/${cf.accountId}/cfd_tunnel/${tid}/configurations`);
      const cfg = Object.assign({}, (cur && cur.config) || {});
      const ingress = Array.isArray(cfg.ingress) && cfg.ingress.length ? cfg.ingress.slice() : [{ service: 'http_status:404' }];
      if (ingress.some((x) => x && String(x.hostname || '').toLowerCase() === hostname)) {
        throw new Error(`这条隧道已经有 ${hostname} 了；要改就删掉再加`);
      }
      // 兜底规则（没有 hostname 的那条）必须在最后，否则它会把后面的全吃掉
      let tail = ingress.filter((x) => !x.hostname);
      if (!tail.length) tail = [{ service: 'http_status:404' }];
      const head = ingress.filter((x) => x.hostname);
      const next = [...head, { hostname, service }, ...tail];
      cfg.ingress = next;
      await cfApi(`/accounts/${cf.accountId}/cfd_tunnel/${tid}/configurations`, { method: 'PUT', body: { config: cfg } });
      let dns = null;
      if (body.addDns !== false && cf.zoneId) {
        dns = await cfApi(`/zones/${cf.zoneId}/dns_records`, {
          method: 'POST',
          body: { type: 'CNAME', name: hostname, content: `${tid}.cfargotunnel.com`, proxied: true, comment: 'created by cf-tunnel-panel' },
        }).catch((e) => ({ error: e.message }));
      }
      log(`隧道 ${tid.slice(0, 8)} 新增公共主机名 ${hostname} → ${service}`, 'panel');
      auditRecord({ actor: auth.who, ip: clientIpOf(req), method: 'POST', path: p, status: 200, action: '新增隧道公共主机名', target: `${hostname} → ${service}` });
      return sendJson(res, 200, { ok: true, hostname, service, dns, ingress: head.concat({ hostname, service }) });
    } catch (e) {
      return sendJson(res, 400, { ok: false, error: e.message });
    }
  }

  if (/^\/api\/cf\/tunnels\/[0-9a-fA-F-]{36}\/hostnames\/delete$/.test(p) && req.method === 'POST') {
    try {
      const tid = p.split('/')[4];
      const body = await readBody(req);
      const cf = state.settings.cf || {};
      if (!cf.accountId) throw new Error('还没填 Account ID');
      const hostname = String(body.hostname || '').trim().toLowerCase();
      if (!hostname) throw new Error('要删哪个域名？');
      const cur = await cfApi(`/accounts/${cf.accountId}/cfd_tunnel/${tid}/configurations`);
      const cfg = Object.assign({}, (cur && cur.config) || {});
      const ingress = Array.isArray(cfg.ingress) ? cfg.ingress : [];
      const next = ingress.filter((x) => String(x.hostname || '').toLowerCase() !== hostname);
      cfg.ingress = next.length ? next : [{ service: 'http_status:404' }];
      await cfApi(`/accounts/${cf.accountId}/cfd_tunnel/${tid}/configurations`, { method: 'PUT', body: { config: cfg } });
      let dns = null;
      if (body.removeDns !== false && cf.zoneId) {
        const rec = await cfApi(`/zones/${cf.zoneId}/dns_records?name=${encodeURIComponent(hostname)}`).catch(() => null);
        const hit = rec && Array.isArray(rec) ? rec.find((r) => r.type === 'CNAME' && /cfargotunnel\.com$/.test(r.content)) : null;
        if (hit) dns = await cfApi(`/zones/${cf.zoneId}/dns_records/${hit.id}`, { method: 'DELETE' }).catch((e) => ({ error: e.message }));
      }
      log(`隧道 ${tid.slice(0, 8)} 删除公共主机名 ${hostname}`, 'panel');
      auditRecord({ actor: auth.who, ip: clientIpOf(req), method: 'POST', path: p, status: 200, action: '删除隧道公共主机名', target: hostname });
      return sendJson(res, 200, { ok: true, hostname, dns });
    } catch (e) {
      return sendJson(res, 400, { ok: false, error: e.message });
    }
  }

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
  // 按归属规则的流量趋势：哪个服务在吃流量
  if (p === '/api/traffic/paths') {
    const hours = Math.min(72, Math.max(1, Number(url.searchParams.get('hours')) || 12));
    const top = Math.min(8, Math.max(1, Number(url.searchParams.get('top')) || 4));
    return sendJson(res, 200, { ok: true, ...trafficByPath(hours, top) });
  }
  if (p === '/api/history') return sendJson(res, 200, { ok: true, points: rtHistory, max: HISTORY_MAX });
  if (p === '/api/notify/history') return sendJson(res, 200, { ok: true, items: notifyHistory.slice().reverse() });
  if (p === '/api/notify/resend' && req.method === 'POST') {
    let body = {};
    try { body = await readBody(req); } catch { body = {}; }
    const seqN = Number(body.seq || 0);
    const entry = notifyHistory.find((x) => x.seq === seqN) || notifyHistory[notifyHistory.length - 1];
    if (!entry) return sendJson(res, 400, { ok: false, error: '还没有任何通知记录可以重发' });
    const n = state.settings.notify || {};
    if (!n.url) return sendJson(res, 400, { ok: false, error: '还没配置通知地址（设置 → 掉线通知）' });
    const sent = await notify(entry.event, entry.title, entry.text || '', { force: true, ignoreDisabled: true });
    auditRecord({ actor: auth.who, ip: clientIpOf(req), method: 'POST', path: p, status: sent ? 200 : 502, action: '重发通知', target: `${entry.event} · ${entry.title}` });
    if (!sent) return sendJson(res, 502, { ok: false, error: '重发失败，看下面的「通知发送记录」里最新一条的原因' });
    return sendJson(res, 200, { ok: true, event: entry.event, title: entry.title });
  }

  if (p === '/api/system') return sendJson(res, 200, { ok: true, ...systemInfo() });

  // 清 Cloudflare 边缘缓存：不传 urls = 清空整个域名
  if (p === '/api/cf/cache/purge' && req.method === 'POST') {
    let body = {};
    try { body = await readBody(req); } catch { body = {}; }
    try {
      const zone = (state.settings.cf || {}).zoneId;
      if (!zone) throw new Error('还没填 Zone ID（设置 → Cloudflare API）');
      const urls = Array.isArray(body.urls) ? body.urls.filter((u) => /^https?:\/\//.test(String(u))).slice(0, 30) : [];
      const payload = urls.length ? { files: urls } : { purge_everything: true };
      const r = await cfApi(`/zones/${zone}/purge_cache`, { method: 'POST', body: payload });
      auditRecord({ actor: auth.who, ip: clientIpOf(req), method: 'POST', path: p, status: 200, action: '清理 Cloudflare 缓存', target: urls.length ? `${urls.length} 个 URL` : '整个域名' });
      log(urls.length ? `已清理 ${urls.length} 个 URL 的边缘缓存` : '已清空整个域名的边缘缓存', 'panel');
      return sendJson(res, 200, { ok: true, purged: urls.length ? urls.length : 'all', result: (r && r.result) || null });
    } catch (e) {
      return sendJson(res, 400, { ok: false, error: e.message });
    }
  }

  // 读 / 建「缓存静态资源」这条 Cache Rule（/assets/* 边缘缓存 1 天，其余不缓存）
  if (p === '/api/cf/cache/rule' && req.method === 'GET') {
    try {
      const zone = (state.settings.cf || {}).zoneId;
      if (!zone) throw new Error('还没填 Zone ID（设置 → Cloudflare API）');
      const r = await cfApi(`/zones/${zone}/rulesets/phases/http_request_cache_settings/entrypoint`);
      const rules = (((r && r.rules) || [])).map((x) => ({ id: x.id, description: x.description, enabled: x.enabled, expression: x.expression }));
      return sendJson(res, 200, { ok: true, rules });
    } catch (e) {
      return sendJson(res, 200, { ok: false, rules: [], error: e.message });
    }
  }
  if (p === '/api/cf/cache/rule' && req.method === 'POST') {
    let body = {};
    try { body = await readBody(req); } catch { body = {}; }
    try {
      const zone = (state.settings.cf || {}).zoneId;
      if (!zone) throw new Error('还没填 Zone ID（设置 → Cloudflare API）');
      const desc = 'cf-tunnel-panel: cache /assets/* at the edge';
      let cur = null;
      try { const g = await cfApi(`/zones/${zone}/rulesets/phases/http_request_cache_settings/entrypoint`); cur = g || null; } catch { cur = null; }
      const rules = ((cur && cur.rules) || []).filter((x) => x.description !== desc);
      if (body.enable !== false) {
        rules.push({
          description: desc,
          expression: '(starts_with(http.request.uri.path, "/assets/"))',
          action: 'set_cache_settings',
          action_parameters: { cache: true, edge_ttl: { mode: 'override_origin', default: 86400 }, browser_ttl: { mode: 'respect_origin' } },
          enabled: true,
        });
      }
      const r = cur
        ? await cfApi(`/zones/${zone}/rulesets/${cur.id}`, { method: 'PUT', body: { rules } })
        : await cfApi(`/zones/${zone}/rulesets/phases/http_request_cache_settings/entrypoint`, { method: 'PUT', body: { rules } });
      auditRecord({ actor: auth.who, ip: clientIpOf(req), method: 'POST', path: p, status: 200, action: body.enable === false ? '关闭静态资源缓存规则' : '开启静态资源缓存规则', target: zone });
      log(body.enable === false ? '已关闭静态资源缓存规则' : '已开启静态资源缓存规则（/assets/* 边缘 1 天）', 'panel');
      return sendJson(res, 200, { ok: true, rules: ((r && r.rules) || []).length });
    } catch (e) {
      return sendJson(res, 400, { ok: false, error: e.message + '（这个操作需要 Token 带 Zone → Cache Rules → Edit 权限，也可以在 Cloudflare 后台手动建）' });
    }
  }

  // 缓存预热：按当前代码指纹把关键资源在边缘拉一遍（清缓存后立刻有热数据）
  if (p === '/api/cf/cache/warm' && req.method === 'POST') {
    let body = {};
    try { body = await readBody(req); } catch { body = {}; }
    try {
      const named = publicTunnels().find((t) => t.mode === 'named' && t.publicHostname);
      const host = String(body.host || (named && named.publicHostname) || '').trim();
      if (!host) throw new Error('没有可用的公网域名：先在「隧道出口」里配一条命名隧道，或在请求里带 host');
      const base = /^https?:\/\//i.test(host) ? host.replace(/\/+$/, '') : `https://${host}`;
      const v = (() => { try { return (ident.buildInfo().code || 'dev').slice(0, 8); } catch { return 'dev'; } })();
      const def = ['/login', `/assets/app.css?v=${v}`, `/assets/app.js?v=${v}`, '/badge.svg'];
      const paths = (Array.isArray(body.paths) && body.paths.length ? body.paths : def).slice(0, 12)
        .map((x) => (String(x).startsWith('/') ? String(x) : '/' + String(x)));
      const out = [];
      for (const path0 of paths) {
        const t0 = Date.now();
        try {
          const r = await fetch(base + path0, { method: 'GET', headers: { 'Cache-Control': 'no-cache' }, signal: AbortSignal.timeout(10000) });
          await r.arrayBuffer();
          out.push({
            path: path0, status: r.status, ms: Date.now() - t0,
            cache: r.headers.get('cf-cache-status') || '', age: r.headers.get('age') || '',
            colo: (() => { const c = r.headers.get('cf-ray') || ''; const m = /-([A-Z]{3})$/i.exec(c); return m ? m[1].toUpperCase() : ''; })(),
          });
        } catch (e) {
          out.push({ path: path0, status: 0, ms: Date.now() - t0, error: e.message });
        }
      }
      const hit = out.filter((x) => x.cache === 'HIT').length;
      state.warm = { code: v, at: Date.now(), host: base, paths: out.length, hit };
      saveState('cache-warm');
      auditRecord({ actor: auth.who, ip: clientIpOf(req), method: 'POST', path: p, status: 200, action: '预热边缘缓存', target: `${host} · ${out.length} 个路径` });
      log(`缓存预热：${host} → ${out.length} 个路径，HIT ${hit} 个`, 'panel');
      return sendJson(res, 200, { ok: true, host: base, version: v, hit, total: out.length, results: out });
    } catch (e) {
      return sendJson(res, 400, { ok: false, error: e.message });
    }
  }

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

// 会话持久化：落盘的只是 cookie 值的哈希，「记住我」30 天，普通登录 7 天
const _restored = session.init(require('path').join(DATA_DIR, 'sessions.json'));

// 单实例：抢不到锁就退出，避免两个面板互相覆盖 state.json / 互相推 Caddy 配置
const lockInfo = acquireLock(require('path').join(DATA_DIR, '.state.lock'));
if (!lockInfo.ok) {
  const h = lockInfo.holder || {};
  console.error(`[fatal] 已有面板实例在运行（pid ${h.pid || '?'}，启动于 ${h.at ? new Date(h.at).toISOString() : '?'}）。`
    + ' 同一个数据目录只能跑一个面板；确实要强启请先删掉 data/.state.lock。');
  process.exit(1);
}

/**
 * 一次性把历史明文口令迁移成 bcrypt 哈希（v0.11.2 之前 state.json 里存的是明文）。
 * 只在发现明文时改写一次，之后 state.json / 备份 / 导出里都只有 $2b$ 串。
 */
function migrateSecrets() {
  let changed = false;
  if (state.panel && state.panel.pass && !secret.isHash(state.panel.pass)) {
    state.panel.pass = secret.hash(state.panel.pass);
    changed = true;
    log('面板口令已从明文迁移为 bcrypt 哈希', 'panel');
  }
  if (state.viewer && state.viewer.pass && !secret.isHash(state.viewer.pass)) {
    state.viewer.pass = secret.hash(state.viewer.pass);
    changed = true;
    log('只读口令已从明文迁移为 bcrypt 哈希', 'panel');
  }
  if (changed) saveState('migrate-secrets');
}
migrateSecrets();
const onReq = (req, res) => {
  const ip = (req.socket && req.socket.remoteAddress) || 'unknown';
  const t0 = Date.now();
  const path0 = String(req.url || '').split('?')[0];
  // 审计：只记"会被记性"的请求 —— 改东西的、和鉴权相关的、以及任何失败的 API 调用
  res.on('finish', () => {
    try {
      const skip = path0 === '/metrics' || path0 === '/badge.svg' || path0.startsWith('/assets/') ||
        path0.startsWith('/__bench/') || path0 === '/api/audit' || path0 === '/api/logs' || path0 === '/api/logs/stream';
      if (skip) return;
      const mutating = req.method !== 'GET' && req.method !== 'HEAD';
      const failed = res.statusCode >= 400 && path0.startsWith('/api');
      if (!mutating && !failed) return;
      auditRecord({
        at: t0, actor: req.__who || '(未登录)', ip: clientIpOf(req),
        method: req.method, path: path0, status: res.statusCode, ms: Date.now() - t0,
        action: res.statusCode < 400 ? actionOf(req.method, path0) : `${req.method} ${path0}（失败）`,
        ok: res.statusCode < 400,
      });
    } catch { /* 记账失败不影响请求 */ }
  });
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
