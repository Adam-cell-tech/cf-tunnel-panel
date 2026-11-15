'use strict';
/**
 * 出口注册表（runtime Map + 只读访问器）
 * 从 src/server.js 按职责拆出（v0.9.0），仅做搬运，行为不变。
 */

const http=require('http'); const https=require('https');

const _state = require('./state');
const state = _state.stateProxy;
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

function publicUrlOf(t) {
  if (!t) return null;
  if (t.mode === 'named') {
    const host = String(t.publicHostname || '').trim();
    return host ? (host.startsWith('http') ? host : `https://${host}`) : null;
  }
  return tunnelRt(t.id).url || null;
}

module.exports = { firstTunnel, publicUrlOf, runtimes, tunnelById, tunnelRt };
