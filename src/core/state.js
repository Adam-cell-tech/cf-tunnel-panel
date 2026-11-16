'use strict';
/**
 * 状态存储：默认结构、迁移、校验、落盘与备份
 * 从 src/server.js 按职责拆出（v0.9.0），仅做搬运，行为不变。
 */

const http=require('http');
  const fs=require('fs');
const path=require('path');
 const bcrypt=require('bcryptjs');

const { BACKUP_DIR, DATA_DIR, LOGLEVELS, PROTOCOLS, STATE_FILE } = require('./paths');
const { log, parseCidrs, parseHeaderLines, parseUpstream, rid } = require('./util');
let state = defaultState();

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
        secret: '',       // 钉钉/飞书「加签」密钥（可选），只在 URL 里有 sign 校验时才需要
        events: { tunnelDown: true, tunnelUp: true, urlChange: true, caddyFail: true, sessionIp: true, errorSpike: true, loginFail: true, authScan: true },
        cooldownSec: 300,  // 同一事件多少秒内不重复提醒（0 = 不冷却）
        quietHours: '',    // 静默时段，如 "23:00-07:00"，可逗号分隔多段
        // 自定义文案模板（留空 = 用默认）：可用占位符 {event} {title} {text} {host} {time} {running}/{total}
        template: { title: '', text: '' },
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
    operator: { user: '', pass: '' },
    totp: { enabled: false, secret: '', pending: '', recovery: [] },
  };
}

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


// ---------------------------------------------------------------- 单实例锁
// 两个面板同时跑会互相覆盖 state.json，更糟的是其中一方可能把 Caddy 配置推成别人的版本
// （CI 起第二个实例时就真发生过：线上路由被冲成 bootstrap 的 2 条）。
// 锁文件里记 pid + 启动时间；判断"进程还活着"时同时核对 /proc/<pid>/cmdline，
// 避免容器重启后 pid 被复用导致误判（容器里 PID 1 永远是 node，最容易踩）。
let lockFile = '';

function pidLooksLikePanel(pid) {
  try {
    const cmd = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8');
    return cmd.includes('server.js');
  } catch {
    return false;
  }
}

function acquireLock(file) {
  lockFile = file;
  try {
    const prev = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (prev && prev.pid && prev.pid !== process.pid && pidLooksLikePanel(prev.pid)) {
      return { ok: false, holder: prev };
    }
  } catch {}
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ pid: process.pid, at: Date.now(), host: require('os').hostname() }), { mode: 0o600 });
  } catch (e) {
    return { ok: false, holder: { error: e.message } };
  }
  const release = () => { try { fs.unlinkSync(lockFile); } catch {} };
  process.on('exit', release);
  return { ok: true };
}

// ---------------------------------------------------------------- 日志
function validateRoutes(list, prevRoutes = []) {
  if (!Array.isArray(list)) throw new Error('routes 必须是数组');
  const out = [];
  for (const [idx, r] of list.entries()) {
    const up = String(r.upstream || '').trim();
    if (!up) throw new Error(`第 ${idx + 1} 条规则缺少上游地址`);
    // 上游必须是「host:port」或「带协议的完整地址」；只写个名字（如 not-a-url）Caddy 也连不上
    if (!/^https?:\/\/[^\s/]+/i.test(up) && !/^[\w.\-\[\]:]+:\d+$/.test(up)) {
      throw new Error(`第 ${idx + 1} 条：上游要写成 host:port 或 http://host:port，收到「${up.slice(0, 40)}」`);
    }
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
function publicSettings() {
  const s = JSON.parse(JSON.stringify(state.settings));
  s.cf = { accountId: s.cf.accountId, zoneId: s.cf.zoneId, hasToken: !!s.cf.token };
  s.viewer = { user: (state.viewer && state.viewer.user) || '', hasPass: !!(state.viewer && state.viewer.pass) };
  s.operator = { user: (state.operator && state.operator.user) || '', hasPass: !!(state.operator && state.operator.pass) };
  s.totp = { enabled: !!(state.totp && state.totp.enabled), recoveryLeft: ((state.totp && state.totp.recovery) || []).length };
  delete s.totp.secret;
  s.notify = {
    format: s.notify.format,
    events: s.notify.events,
    hasUrl: !!s.notify.url,
    hasSecret: !!s.notify.secret,
    cooldownSec: s.notify.cooldownSec || 0,
    quietHours: s.notify.quietHours || '',
    template: { title: (s.notify.template && s.notify.template.title) || '', text: (s.notify.template && s.notify.template.text) || '' },
  };
  return s;
}

/**
 * 跨模块只读/可写代理：其他模块 require 后当作 `state` 直接用，
 * 读写都落到本模块内部的同一个对象上（避免把 state 复制成多份）。
 */
const stateProxy = new Proxy({}, {
  get: (_, k) => state[k],
  set: (_, k, v) => { state[k] = v; return true; },
  has: (_, k) => k in state,
  ownKeys: () => Reflect.ownKeys(state),
  getOwnPropertyDescriptor: (_, k) => {
    const d = Reflect.getOwnPropertyDescriptor(state, k);
    return d ? { ...d, configurable: true } : undefined;
  },
  deleteProperty: (_, k) => { delete state[k]; return true; },
});

const { LB_POLICIES, METHODS } = require('./paths');

/**
 * 整体替换状态（导入/回滚用）。必须走这个函数，否则别的模块的 stateProxy 会看到旧对象。
 */
function setState(next) { state = next; }

module.exports = { acquireLock, stateProxy, setState, deepDefault, defaultOrigin, defaultState, loadState, migrateState, newTunnel, normalizeTunnels, publicRoute, publicSettings, saveState, state, validateRoutes };