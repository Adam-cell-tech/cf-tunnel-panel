'use strict';
/**
 * 会话式登录（cookie + 服务端会话表）
 *
 * 为什么要有：Basic 认证每个请求都带一次明文口令，浏览器记一辈子，而且**没法踢人**。
 * 会话化之后：登录一次发一个 cookie，服务端有一张会话表，可以逐个撤销，
 * 也能看到"谁在什么 IP、什么设备上登录着、最后一次活动是什么时候"。
 *
 * v0.12 起可选持久化（`session.init(file)`）：
 * - 落盘的只有 cookie 值的 SHA-256，拿到 sessions.json 也登不进来；
 * - 「记住我」= 30 天，普通登录 = 7 天 + 12 小时闲置失效；
 * - 重启后会话还在，不用每次改代码都重新登录。
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const COOKIE = 'cfp_sid';
const TTL_MS = 7 * 24 * 3600 * 1000;        // 普通登录：7 天
const REMEMBER_MS = 30 * 24 * 3600 * 1000;  // 记住我：30 天
const IDLE_MS = 12 * 3600 * 1000;           // 12 小时无活动也失效
const MAX_SESSIONS = 50;
const ROLES = ['admin', 'operator', 'viewer'];

/** key = sha256(cookie 值) -> { key, user, role, ip, ua, createdAt, lastSeenAt, expiresAt, ttl } */
const sessions = new Map();

let storeFile = '';
let saveTimer = null;

const KEY_RE = /^[a-f0-9]{64}$/;

function hashId(id) {
  return crypto.createHash('sha256').update(String(id || '')).digest('hex');
}

function parseCookies(req) {
  const out = {};
  const raw = String((req.headers && req.headers.cookie) || '');
  raw.split(';').forEach((part) => {
    const i = part.indexOf('=');
    if (i < 0) return;
    const k = part.slice(0, i).trim();
    if (!k) return;
    out[k] = decodeURIComponent(part.slice(i + 1).trim());
  });
  return out;
}

/** 从磁盘恢复会话（只恢复未过期的） */
function load() {
  if (!storeFile) return 0;
  try {
    const rows = JSON.parse(fs.readFileSync(storeFile, 'utf8'));
    const now = Date.now();
    let n = 0;
    for (const s of Array.isArray(rows) ? rows : []) {
      if (!s || !KEY_RE.test(s.key || '')) continue;
      if (!s.expiresAt || s.expiresAt <= now) continue;
      if (now - (s.lastSeenAt || 0) > IDLE_MS) continue;
      sessions.set(s.key, {
        key: s.key,
        user: String(s.user || ''),
        role: ROLES.includes(s.role) ? s.role : 'admin',
        ip: String(s.ip || ''),
        ua: String(s.ua || '').slice(0, 160),
        createdAt: s.createdAt || now,
        lastSeenAt: s.lastSeenAt || now,
        expiresAt: s.expiresAt,
        ttl: s.ttl === REMEMBER_MS ? REMEMBER_MS : TTL_MS,
        prevIp: s.prevIp || '',
        ipChangedAt: s.ipChangedAt || 0,
      });
      n += 1;
    }
    return n;
  } catch {
    return 0;
  }
}

/** 落盘（防抖 800ms；只写哈希，不写 cookie 原值） */
function persistNow() {
  if (!storeFile) return;
  try {
    const rows = [...sessions.values()].map((s) => ({
      key: s.key, user: s.user, role: s.role, ip: s.ip, ua: s.ua,
      createdAt: s.createdAt, lastSeenAt: s.lastSeenAt, expiresAt: s.expiresAt, ttl: s.ttl,
      prevIp: s.prevIp || '', ipChangedAt: s.ipChangedAt || 0,
    }));
    fs.mkdirSync(path.dirname(storeFile), { recursive: true });
    const tmp = `${storeFile}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(rows, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, storeFile);
  } catch {}
}

function persist() {
  if (!storeFile) return;
  if (saveTimer) return;
  saveTimer = setTimeout(() => { saveTimer = null; persistNow(); }, 800);
  if (saveTimer.unref) saveTimer.unref();
}

function init(file) {
  storeFile = file || '';
  const n = load();
  return n;
}

function prune() {
  const now = Date.now();
  let changed = false;
  for (const [k, s] of sessions) {
    if (s.expiresAt <= now || now - s.lastSeenAt > IDLE_MS) { sessions.delete(k); changed = true; }
  }
  if (changed) persist();
  return changed;
}

function create({ user, role = 'admin', ip = '', ua = '', remember = false }) {
  prune();
  if (sessions.size >= MAX_SESSIONS) {
    const oldest = [...sessions.values()].sort((a, b) => a.lastSeenAt - b.lastSeenAt)[0];
    if (oldest) sessions.delete(oldest.key);
  }
  const id = crypto.randomBytes(24).toString('hex');
  const now = Date.now();
  const ttl = remember ? REMEMBER_MS : TTL_MS;
  const s = {
    key: hashId(id),
    user: String(user || ''),
    role: ROLES.includes(role) ? role : 'admin',
    ip: String(ip || ''),
    ua: String(ua || '').slice(0, 160),
    createdAt: now,
    lastSeenAt: now,
    expiresAt: now + ttl,
    ttl,
  };
  sessions.set(s.key, s);
  persistNow();
  // 返回体带上明文 id（只有这一次机会，之后服务端只存哈希）
  return { ...s, id, token: id };
}

function get(id) {
  if (!id) return null;
  const s = sessions.get(hashId(id));
  if (!s) return null;
  s.rawId = String(id); // 只在内存里回挂原始 cookie 值，便于 touch/revoke；不落盘
  const now = Date.now();
  if (s.expiresAt <= now || now - s.lastSeenAt > IDLE_MS) { sessions.delete(s.key); persist(); return null; }
  return s;
}

function touch(id) {
  const s = get(id);
  if (!s) return null;
  s.lastSeenAt = Date.now();
  s.expiresAt = Date.now() + (s.ttl || TTL_MS);
  persist();
  return s;
}

function fromReq(req) {
  return get(parseCookies(req)[COOKIE]);
}

function revoke(shortOrFull) {
  const key = resolveKey(shortOrFull);
  if (!key) return false;
  sessions.delete(key);
  persist();
  return true;
}

/** 全踢（含自己）。改密码、或点「退出全部设备」时用。 */
function revokeAll() {
  const n = sessions.size;
  sessions.clear();
  persistNow();
  return n;
}

/** 保留当前会话，其余全踢；返回踢掉的数量 */
function revokeOthers(keepId) {
  const keepKey = keepId ? hashId(keepId) : '';
  let n = 0;
  for (const k of [...sessions.keys()]) {
    if (k === keepKey) continue;
    sessions.delete(k);
    n += 1;
  }
  if (n) persist();
  return n;
}

function list(currentId) {
  prune();
  const curKey = currentId ? hashId(currentId) : '';
  return [...sessions.values()]
    .sort((a, b) => b.lastSeenAt - a.lastSeenAt)
    .map((s) => ({
      id: s.key.slice(0, 8),
      user: s.user,
      role: s.role,
      ip: s.ip,
      ua: s.ua,
      createdAt: s.createdAt,
      lastSeenAt: s.lastSeenAt,
      expiresAt: s.expiresAt,
      remember: s.ttl === REMEMBER_MS,
      prevIp: s.prevIp || '',
      ipChangedAt: s.ipChangedAt || 0,
      current: s.key === curKey,
    }));
}

function resolveKey(shortOrKey) {
  const s = String(shortOrKey || '');
  if (!s) return null;
  // 三种输入都要认：完整 cookie 值（先哈希再查）、落盘的 key、界面上显示的 8 位短 id
  const h = hashId(s);
  if (sessions.has(h)) return h;
  if (KEY_RE.test(s) && sessions.has(s)) return s;
  for (const k of sessions.keys()) if (k.slice(0, 8) === s) return k;
  return null;
}

function cookieHeader(id, { secure = false, remember = false } = {}) {
  const maxAge = Math.floor((remember ? REMEMBER_MS : TTL_MS) / 1000);
  const parts = [`${COOKIE}=${id}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAge}`];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

function clearCookieHeader() {
  return `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

/** 请求是不是走 HTTPS（经过 Caddy/Cloudflare 时看转发头） */
function isSecure(req) {
  const proto = String((req.headers && req.headers['x-forwarded-proto']) || '').split(',')[0].trim();
  if (proto) return proto === 'https';
  return !!(req.socket && req.socket.encrypted);
}

module.exports = {
  COOKIE, TTL_MS, REMEMBER_MS, IDLE_MS, ROLES, sessions, init, load, persist, persistNow, hashId,
  parseCookies, create, get, touch, fromReq, revoke, revokeAll, revokeOthers, list, resolveKey,
  cookieHeader, clearCookieHeader, isSecure, prune,
};
