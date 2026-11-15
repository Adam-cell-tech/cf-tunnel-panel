'use strict';
/**
 * 面板鉴权（Basic / 只读账号 / 防爆破）
 * 从 src/server.js 按职责拆出（v0.9.0），仅做搬运，行为不变。
 */

const http=require('http'); const https=require('https'); const crypto=require('crypto');
const zlib=require('zlib'); const net=require('net'); const fs=require('fs');
const path=require('path'); const os=require('os'); const { spawn }=require('child_process');
const QRCode=require('qrcode'); const bcrypt=require('bcryptjs');

const { log } = require('./util');
const session = require('./session');
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
    session.touch(sess.id);
    const ro = sess.role === 'viewer';
    return { ok: true, tried: false, readonly: ro, who: `${sess.user}（${ro ? '只读·会话' : '会话'}）`, via: 'session', sid: sess.id, session: sess };
  }
  const h = req.headers.authorization || '';
  if (!h.startsWith('Basic ')) return { ok: false, tried: false, readonly: false, who: '(未登录)', via: 'none' };
  const [u, p] = Buffer.from(h.slice(6), 'base64').toString('utf8').split(':');
  if (u === user && p === pass) return { ok: true, tried: true, readonly: false, who: u, via: 'basic' };
  if (viewer.user && u === viewer.user && p === viewer.pass) return { ok: true, tried: true, readonly: true, who: `${u}（只读）`, via: 'basic' };
  return { ok: false, tried: true, readonly: false, who: `${u || '(空)'}（口令错误）`, via: 'basic' };
}

/** 用账号口令换一个会话（登录接口用）。返回 null 表示口令不对。 */
function login({ user, pass, ip = '', ua = '' }) {
  const admin = state.panel || {};
  const viewer = state.viewer || {};
  const u = String(user || '');
  const p = String(pass || '');
  if (admin.user && u === admin.user && p === admin.pass) return session.create({ user: u, role: 'admin', ip, ua });
  if (viewer.user && u === viewer.user && p === viewer.pass) return session.create({ user: u, role: 'viewer', ip, ua });
  return null;
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

module.exports = { AUTH_BLOCK_MS, AUTH_FAIL_LIMIT, AUTH_FAIL_WINDOW, authBlockedFor, authFails, authOk, checkAuth, clearAuthFail, clientIpOf, noteAuthFail, login };
