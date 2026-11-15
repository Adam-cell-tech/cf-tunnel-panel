'use strict';
/**
 * 通知（webhook 推送、冷却、静默时段、发送历史）
 * 从 src/server.js 按职责拆出（v0.9.0），仅做搬运，行为不变。
 */

  const crypto=require('crypto');

 const os=require('os');

const { log } = require('./util');
const _state = require('./state');
const state = _state.stateProxy;
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

function recordNotify(event, title, status, extra = '') {
  notifyHistory.push({ t: Date.now(), event, title, status, extra: String(extra || '') });
  if (notifyHistory.length > 50) notifyHistory.splice(0, notifyHistory.length - 50);
}

/** 钉钉 / 飞书的「加签」：base64(hmac_sha256(secret, `${ts}\n${secret}`)) */
function signWith(secret, ts) {
  return crypto.createHmac('sha256', String(secret)).update(`${ts}\n${secret}`).digest('base64');
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
    if (n.format === 'dingtalk') {
      // 钉钉加签走 query：&timestamp=<ms>&sign=<base64>
      if (n.secret) {
        const ts = Date.now();
        url += (url.includes('?') ? '&' : '?') + `timestamp=${ts}&sign=${encodeURIComponent(signWith(n.secret, ts))}`;
      }
      body = JSON.stringify({ msgtype: 'text', text: { content: line } });
    } else if (n.format === 'feishu') {
      // 飞书加签走 body：timestamp（秒）+ sign
      const payload = { msg_type: 'text', content: { text: line } };
      if (n.secret) {
        const ts = Math.floor(Date.now() / 1000);
        payload.timestamp = String(ts);
        payload.sign = signWith(n.secret, ts);
      }
      body = JSON.stringify(payload);
    }
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
const notifyHistory = [];     // 最近 50 条通知结果，面板里能看到「发过什么、成没成」

const lastNotify = new Map(); // event -> 上次发送时间

module.exports = { inQuietHours, notify, notifyHistory, recordNotify };
