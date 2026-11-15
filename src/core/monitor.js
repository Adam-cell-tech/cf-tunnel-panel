'use strict';
/**
 * 后台巡检（出口状态采样、分享链接清理）
 * 从 src/server.js 按职责拆出（v0.9.0），仅做搬运，行为不变。
 */

 const os=require('os');

const { log } = require('./util');
const _state = require('./state');
const state = _state.stateProxy;
const { saveState } = require('./state');
const { publicUrlOf, tunnelRt } = require('./registry');
const { caddy } = require('./caddy');
const { pushCaddy } = require('./pusher');
const { sampleHistory } = require('./insight');
const { notify } = require('./notify');
let seenCaddyOk = true;
let histTick = 0; // 采样节拍：每 12 次（12×5s=60s）落一个点
function startMonitor() {
  setInterval(() => {
    histTick += 1;
    if (histTick % 12 === 0) sampleHistory();
    for (const t of state.tunnels) {
      const rt = tunnelRt(t.id);
      const cur = { status: rt.status, url: rt.url };
      const prev = seenRt.get(t.id);
      if (prev) {
        if (cur.status !== prev.status && (cur.status === 'error' || (prev.status === 'running' && cur.status === 'stopped'))) {
          notify('tunnelDown', `出口「${t.name}」${cur.status === 'error' ? '异常' : '已停止'}`,
            `${rt.lastError || '进程不在了'}\n模式：${t.mode}\n主机：${os.hostname()}`);
        }
        if (cur.url && prev.url && cur.url !== prev.url) {
          notify('urlChange', `出口「${t.name}」换了公网域名`, `旧：${prev.url}\n新：${cur.url}`);
        }
      }
      seenRt.set(t.id, cur);
    }
    if (seenCaddyOk && !caddy.ok) notify('caddyFail', 'Caddy 配置下发失败', String(caddy.error || '未知错误'));
    seenCaddyOk = caddy.ok;
  }, 5000).unref();
}

// ---------------------------------------------------------------- 一次性分享链接
function shareUrl(token) {
  const base = state.tunnels.map(publicUrlOf).filter(Boolean)[0];
  return base ? `${base.replace(/\/+$/, '')}/s/${token}` : `/s/${token}`;
}

function shareJanitor() {
  setInterval(() => {
    const now = Date.now();
    const before = (state.shares || []).length;
    state.shares = (state.shares || []).filter((s) => s.expiresAt > now);
    if (state.shares.length !== before) {
      saveState('share-expire');
      log(`已清理 ${before - state.shares.length} 条过期分享链接`, 'panel');
      pushCaddy().catch(() => {});
    }
  }, 15000).unref();
}

// ---------------------------------------------------------------- Docker 容器

const seenRt = new Map(); // tunnelId -> 上次采样的状态

module.exports = { seenCaddyOk, shareJanitor, shareUrl, startMonitor };
