'use strict';
/**
 * 通知（webhook 推送、冷却、静默时段、发送历史）
 * 从 src/server.js 按职责拆出（v0.9.0），仅做搬运，行为不变。
 */

  const crypto=require('crypto');

 const os=require('os');

const { log } = require('./util');
const history = require('./history');
const _state = require('./state');
const state = _state.stateProxy;
/**
 * 自定义文案：把 {event}/{title}/{text}/{host}/{time}/{running}/{total} 换成实际值。
 * 模板里没用到 {text} 时，正文会自动追加原内容，避免「自定义后看不到细节」。
 */
function applyTemplate(tpl, vars) {
  const raw = String(tpl || '');
  if (!raw) return '';
  const out = raw.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
  return out.replace(/\s+$/, '');
}

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

let notifySeq = 0;
function recordNotify(event, title, status, extra = '', text = '') {
  // v0.19.0：通知记录落盘（DATA_DIR/history/notify.jsonl），两台实例共享，重启也不丢
  history.appendNotify({ seq: Date.now(), t: Date.now(), event, title, status, extra, text });
}

/** 钉钉 / 飞书的「加签」：base64(hmac_sha256(secret, `${ts}\n${secret}`)) */
function signWith(secret, ts) {
  return crypto.createHmac('sha256', String(secret)).update(`${ts}\n${secret}`).digest('base64');
}

/**
 * 通道列表：新格式 settings.notify.channels[]，老的单通道字段（url/format/secret）
 * 在读取时虚拟成一条通道 —— 老配置不用迁移也能继续发。
 */
function channelList(includeDisabled = false) {
  const n = state.settings.notify || {};
  const arr = Array.isArray(n.channels) ? n.channels : [];
  const list = arr
    .filter((c) => c && typeof c === 'object' && String(c.url || '').trim())
    .map((c, i) => ({
      id: String(c.id || `c${i + 1}`),
      name: String(c.name || `通道 ${i + 1}`).slice(0, 40),
      format: String(c.format || 'generic'),
      url: String(c.url || '').trim(),
      secret: String(c.secret || ''),
      enabled: c.enabled !== false,
    }));
  if (list.length) return includeDisabled ? list : list.filter((c) => c.enabled);
  if (String(n.url || '').trim()) {
    const legacy = [{ id: 'legacy', name: '默认通道', format: String(n.format || 'generic'), url: String(n.url).trim(), secret: String(n.secret || ''), enabled: true }];
    return legacy;
  }
  return [];
}

/** 把一条通知真正发到一个通道（按 format 组装 payload / 加签） */
async function sendOne(ch, title, text, event) {
  const line = `${title}\n${text}`;
  let url = ch.url;
  let body = JSON.stringify({ title, text: line, event, ts: new Date().toISOString(), host: os.hostname() });
  const headers = { 'Content-Type': 'application/json' };
  if (ch.format === 'dingtalk') {
    if (ch.secret) {
      const ts = Date.now();
      url += (url.includes('?') ? '&' : '?') + `timestamp=${ts}&sign=${encodeURIComponent(signWith(ch.secret, ts))}`;
    }
    body = JSON.stringify({ msgtype: 'text', text: { content: line } });
  } else if (ch.format === 'feishu') {
    const payload = { msg_type: 'text', content: { text: line } };
    if (ch.secret) {
      const ts = Math.floor(Date.now() / 1000);
      payload.timestamp = String(ts);
      payload.sign = signWith(ch.secret, ts);
    }
    body = JSON.stringify(payload);
  } else if (ch.format === 'bark') {
    url = url.replace(/\/+$/, '') + '/' + encodeURIComponent(title) + '/' + encodeURIComponent(text);
    body = '{}';
  }
  const r = await fetch(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(8000) });
  return r;
}

async function notify(event, title, text, opts = {}) {
  const n = state.settings.notify || {};
  const channels = channelList();
  // 没配通道 ≠ 发送失败：手点「测试」时更不该把失败计数顶上去（会误触发 NotifyFailing 告警）
  if (!channels.length) {
    recordNotify(event, title, 'skipped', '没有启用任何通知通道', text);
    return false;
  }
  const ev = n.events || {};
  if (ev[event] === false && !opts.ignoreDisabled) return false;
  // opts.channelId：只发指定通道（「测试」按钮用）
  const targets = opts.channelId ? channels.filter((c) => c.id === opts.channelId) : channels;
  if (!targets.length) {
    recordNotify(event, title, 'skipped', '指定的通道不存在或已停用', text);
    return false;
  }
  if (!opts.force) {
    if (inQuietHours(n.quietHours)) {
      log(`通知被静默时段拦下（${event}，当前静默 ${n.quietHours}）`, 'panel');
      recordNotify(event, title, 'skipped', '静默时段', text);
      return false;
    }
    const cdMs = Math.max(0, Number(n.cooldownSec || 0) * 1000);
    const last = lastNotify.get(event) || 0;
    if (cdMs > 0 && Date.now() - last < cdMs) {
      log(`通知冷却中（${event}，距上次 ${Math.round((Date.now() - last) / 1000)}s < ${n.cooldownSec}s）`, 'panel');
      recordNotify(event, title, 'skipped', '冷却中', text);
      return false;
    }
    lastNotify.set(event, Date.now());
  }
  // 自定义模板（留空则保持默认：标题 + 换行 + 正文）
  const running = (state.tunnels || []).filter((t) => t.enabled).length;
  const vars = {
    event, title, text, host: os.hostname(),
    time: new Date().toLocaleString('zh-CN', { hour12: false }),
    running, total: (state.tunnels || []).length,
  };
  const tplTitle = applyTemplate(n.template && n.template.title, vars);
  const tplText = applyTemplate(n.template && n.template.text, vars);
  if (tplTitle) title = tplTitle;
  if (tplText) text = /\{text\}/.test(String((n.template || {}).text || '')) ? tplText : `${tplText}\n${text}`;

  let anyOk = false;
  for (const ch of targets) {
    try {
      const r = await sendOne(ch, title, text, event);
      log(`通知已发送（${event} → ${ch.name}）HTTP ${r.status}`, 'panel');
      recordNotify(event, title, r.ok ? 'ok' : 'fail', `${ch.name} · HTTP ${r.status}`, text);
      if (r.ok) anyOk = true;
    } catch (e) {
      log(`通知发送失败（${event} → ${ch.name}）：${e.message}`, 'panel');
      recordNotify(event, title, 'fail', `${ch.name} · ${e.message}`, text);
    }
  }
  return anyOk;
}

// 出口状态/域名变化 → 通知（5 秒采样一次，不改动引擎）
const notifyHistory = [];     // 最近 50 条通知结果，面板里能看到「发过什么、成没成」

const lastNotify = new Map(); // event -> 上次发送时间

module.exports = { applyTemplate, channelList, inQuietHours, notify, notifyHistory, recordNotify, sendOne, signWith };
