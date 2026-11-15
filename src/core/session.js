'use strict';
/**
 * 会话式登录（cookie + 服务端会话表）
 *
 * 为什么要有：Basic 认证每个请求都带一次明文口令，浏览器记一辈子，而且**没法踢人**——
 * 手机丢了、笔记本借人了、把密码告诉过谁，你唯一的手段就是改密码（连带自己也被踢）。
 * 会话化之后：登录一次发一个 cookie，服务端有一张会话表，可以逐个撤销，
 * 也能看到"谁在什么 IP、什么设备上登录着、最后一次活动是什么时候"。
 *
 * 存在内存里（重启即全部失效），不落盘：会话不是配置，重启重登更安全。
 */

const crypto = require('crypto');

const COOKIE = 'cfp_sid';
const TTL_MS = 7 * 24 * 3600 * 1000;      // 7 天
const IDLE_MS = 12 * 3600 * 1000;         // 12 小时无活动也失效
const MAX_SESSIONS = 50;

/** id -> { id, user, role, ip, ua, createdAt, lastSeenAt, expiresAt } */
const sessions = new Map();

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

function prune() {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (s.expiresAt <= now || now - s.lastSeenAt > IDLE_MS) sessions.delete(id);
  }
}

function create({ user, role = 'admin', ip = '', ua = '' }) {
  prune();
  if (sessions.size >= MAX_SESSIONS) {
    // 满了就踢最久没活动的那个，避免无限增长
    const oldest = [...sessions.values()].sort((a, b) => a.lastSeenAt - b.lastSeenAt)[0];
    if (oldest) sessions.delete(oldest.id);
  }
  const id = crypto.randomBytes(24).toString('hex');
  const now = Date.now();
  const s = { id, user: String(user || ''), role: role === 'viewer' ? 'viewer' : 'admin', ip: String(ip || ''), ua: String(ua || '').slice(0, 160), createdAt: now, lastSeenAt: now, expiresAt: now + TTL_MS };
  sessions.set(id, s);
  return s;
}

function get(id) {
  if (!id) return null;
  const s = sessions.get(String(id));
  if (!s) return null;
  const now = Date.now();
  if (s.expiresAt <= now || now - s.lastSeenAt > IDLE_MS) { sessions.delete(s.id); return null; }
  return s;
}

function touch(id) {
  const s = sessions.get(String(id));
  if (!s) return null;
  s.lastSeenAt = Date.now();
  s.expiresAt = Date.now() + TTL_MS;
  return s;
}

function fromReq(req) {
  const id = parseCookies(req)[COOKIE];
  return get(id);
}

function revoke(id) {
  const s = sessions.get(String(id));
  if (!s) return false;
  sessions.delete(s.id);
  return true;
}

/** 保留 keepId（当前会话），其余全踢；返回踢掉的数量 */
function revokeOthers(keepId) {
  let n = 0;
  for (const id of [...sessions.keys()]) {
    if (id === keepId) continue;
    sessions.delete(id);
    n += 1;
  }
  return n;
}

function list(currentId) {
  prune();
  return [...sessions.values()]
    .sort((a, b) => b.lastSeenAt - a.lastSeenAt)
    .map((s) => ({
      id: s.id.slice(0, 8),
      fullId: s.id,
      user: s.user,
      role: s.role,
      ip: s.ip,
      ua: s.ua,
      createdAt: s.createdAt,
      lastSeenAt: s.lastSeenAt,
      current: s.id === currentId,
    }));
}

/** 按 8 位短 id 找完整 id（前端只显示短 id） */
function resolveId(shortId) {
  const s = String(shortId || '');
  if (!s) return null;
  if (sessions.has(s)) return s;
  for (const id of sessions.keys()) if (id.slice(0, 8) === s) return id;
  return null;
}

function cookieHeader(id, { secure = false } = {}) {
  const parts = [`${COOKIE}=${id}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${Math.floor(TTL_MS / 1000)}`];
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

module.exports = { COOKIE, TTL_MS, IDLE_MS, sessions, parseCookies, create, get, touch, fromReq, revoke, revokeOthers, list, resolveId, cookieHeader, clearCookieHeader, isSecure, prune };
