'use strict';
/**
 * 面板鉴权（Basic / 只读账号 / 防爆破）
 * 从 src/server.js 按职责拆出（v0.9.0），仅做搬运，行为不变。
 */

const path=require('path');
 const bcrypt=require('bcryptjs');

const { log } = require('./util');
const session = require('./session');
const totp = require('./totp');
const secret = require('./secret');
const crypto = require('crypto');
const audit = require('./audit');
const { notify } = require('./notify');
const _state = require('./state');
const state = _state.stateProxy;
function authOk(req) {
  return checkAuth(req).ok;
}

/** 面板登录：区分「没带凭证」和「带错了」，后者要计失败次数（防暴力破解）。
 *  认证优先级：① 会话 cookie（浏览器正常登录）→ ② Basic（curl / 脚本 / Prometheus）。 */
function checkAuth(req) {
  const { user, pass } = state.panel || {};
  const viewer = state.viewer || {};
  if (!user) return { ok: true, tried: false, readonly: false, who: '(未设口令)', via: 'none' };
  const sess = session.fromReq(req);
  if (sess) {
    session.touch(sess.rawId || sess.id);
    // 同一个会话突然换 IP：cookie 被复制到别处、或者手机切了网络。
    // 不拦（拦了正常用户换 Wi-Fi 就进不来），但记审计 + 推一条通知，让你知道有人手里有你的 cookie。
    const ipNow = clientIpOf(req);
    if (ipNow && sess.ip && sess.ip !== ipNow && ipNow !== 'unknown') {
      const prev = sess.ip;
      sess.ip = ipNow;
      sess.prevIp = prev;
      sess.ipChangedAt = Date.now();
      audit.record({ actor: `${sess.user}（会话）`, ip: ipNow, method: req.method, path: String(req.url || ''), status: 200, action: '会话来源 IP 变更', target: `${prev} → ${ipNow}` });
      log(`会话 ${String(sess.rawId || sess.key || '').slice(0, 8)} 的来源 IP 变化：${prev} → ${ipNow}`, 'panel');
      notify('sessionIp', '面板会话换了 IP', `账号：${sess.user}\n原 IP：${prev}\n新 IP：${ipNow}\n时间：${new Date().toLocaleString('zh-CN')}\n\n如果不是你本人切换网络，说明这个 cookie 被复制走了，去「设置 → 登录会话」把它踢掉。`).catch(() => {});
    }
    const role = sess.role || 'admin';
    const ro = role === 'viewer';
    const roleTag = role === 'viewer' ? '只读·会话' : role === 'operator' ? '运维·会话' : '会话';
    return { ok: true, tried: false, readonly: ro, role, who: `${sess.user}（${roleTag}）`, via: 'session', sid: sess.rawId || sess.id || sess.key, session: sess };
  }
  const h = req.headers.authorization || '';
  if (!h.startsWith('Basic ')) return { ok: false, tried: false, readonly: false, who: '(未登录)', via: 'none' };
  const [u, p] = Buffer.from(h.slice(6), 'base64').toString('utf8').split(':');
  const oper = state.operator || {};
  if (u === user && verifyBasicCached(u, p, pass)) return { ok: true, tried: true, readonly: false, role: 'admin', who: u, via: 'basic' };
  if (oper.user && u === oper.user && verifyBasicCached(u, p, oper.pass)) return { ok: true, tried: true, readonly: false, role: 'operator', who: `${u}（运维）`, via: 'basic' };
  if (viewer.user && u === viewer.user && verifyBasicCached(u, p, viewer.pass)) return { ok: true, tried: true, readonly: true, role: 'viewer', who: `${u}（只读）`, via: 'basic' };
  return { ok: false, tried: true, readonly: false, role: null, who: `${u || '(空)'}（口令错误）`, via: 'basic' };
}

/**
 * 登录第一段：账号 + 口令。
 * - 口令错 → 返回 null
 * - 开了 TOTP → 不发会话，返回 { needTotp:true, challenge }，前端再要一次验证码
 * - 没开 → 直接建会话
 */
const CH_KEY = crypto.randomBytes(32);
const CH_TTL = 5 * 60 * 1000;

function issueChallenge(user, role) {
  const payload = Buffer.from(JSON.stringify({ u: user, r: role, e: Date.now() + CH_TTL, n: crypto.randomBytes(6).toString('hex') })).toString('base64url');
  const sig = crypto.createHmac('sha256', CH_KEY).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

function readChallenge(token) {
  const [payload, sig] = String(token || '').split('.');
  if (!payload || !sig) return null;
  const want = crypto.createHmac('sha256', CH_KEY).update(payload).digest('base64url');
  if (want.length !== sig.length || !crypto.timingSafeEqual(Buffer.from(want), Buffer.from(sig))) return null;
  try {
    const o = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!o || !o.u || !o.r || !(o.e > Date.now())) return null;
    return o;
  } catch { return null; }
}

function login({ user, pass, ip = '', ua = '', remember = false }) {
  const admin = state.panel || {};
  const oper = state.operator || {};
  const viewer = state.viewer || {};
  const u = String(user || '');
  const p = String(pass || '');
  let role = '';
  if (admin.user && u === admin.user && secret.verify(admin.pass, p)) role = 'admin';
  else if (oper.user && u === oper.user && secret.verify(oper.pass, p)) role = 'operator';
  else if (viewer.user && u === viewer.user && secret.verify(viewer.pass, p)) role = 'viewer';
  if (!role) return null;
  if (state.totp && state.totp.enabled && state.totp.secret) {
    return { needTotp: true, role, user: u, challenge: issueChallenge(u, role) };
  }
  return session.create({ user: u, role, ip, ua, remember: !!remember });
}

/**
 * 登录第二段：验证码（或恢复码）→ 建会话。
 * 恢复码用掉即删（一次性），磁盘上只存 sha256。
 */
function completeTotp({ challenge, code, ip = '', ua = '', remember = false }) {
  const ch = readChallenge(challenge);
  if (!ch) return { ok: false, error: '验证已过期，请重新登录' };
  const conf = state.totp || {};
  const raw = String(code || '').trim();
  let passed = false;
  let usedRecovery = false;
  if (/^\d{6}$/.test(raw.replace(/\s/g, ''))) {
    passed = totp.verify(conf.secret, raw) !== null;
  } else if (raw) {
    const h = totp.hashRecovery(raw);
    const arr = Array.isArray(conf.recovery) ? conf.recovery : [];
    const i = arr.indexOf(h);
    if (i >= 0) { arr.splice(i, 1); conf.recovery = arr; passed = true; usedRecovery = true; }
  }
  if (!passed) return { ok: false, error: '验证码不对（注意手机时间要和服务器一致）' };
  const s = session.create({ user: ch.u, role: ch.r, ip, ua, remember: !!remember });
  return { ok: true, session: s, usedRecovery };
}

// Basic 认证每次请求都要跑一次 bcrypt（本机 aarch64 上 10 轮约 170ms），
// 会把页面加载拖慢一个数量级。这里缓存「已验证通过的 (用户,口令,哈希)」10 分钟：
// 只对成功结果缓存（错口令照常走 bcrypt + 失败计数），改口令时整表清空。
const basicPassCache = new Map(); // key -> expiresAt
const BASIC_CACHE_MS = 10 * 60 * 1000;

function basicCacheKey(u, p, stored) {
  return crypto.createHash('sha256').update(`${u}\u0000${p}\u0000${stored}`).digest('hex');
}

/** 校验 Basic 口令：先查缓存，未命中才跑 bcrypt 并把成功结果记下来。 */
function verifyBasicCached(u, p, stored) {
  if (!stored) return false;
  const key = basicCacheKey(u, p, String(stored));
  const exp = basicPassCache.get(key);
  if (exp && exp > Date.now()) return true;
  const okNow = secret.verify(stored, p);
  if (okNow) {
    if (basicPassCache.size > 200) basicPassCache.clear();
    basicPassCache.set(key, Date.now() + BASIC_CACHE_MS);
  }
  return okNow;
}

/** 口令变更后调用：旧口令的缓存必须立刻失效。 */
function clearBasicCache() {
  basicPassCache.clear();
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

module.exports = {
  login, completeTotp, checkAuth, authOk, clearAuthFail, noteAuthFail, authBlockedFor, clientIpOf, clearBasicCache, authFails, AUTH_FAIL_LIMIT, AUTH_FAIL_WINDOW, AUTH_BLOCK_MS
};
