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
const { readAccess, sampleHistory, securityAttempts } = require('./insight');
const audit = require('./audit');
const { notify } = require('./notify');
let seenCaddyOk = true;
let histTick = 0;
let lastSpike = 0;      // 上次 5xx 告警时间（防刷屏）
let lastLoginAlert = 0;
let lastScanAlert = 0;
const prevTunnelStatus = new Map();   // 出口 id -> 上一次看到的状态（用来发现「恢复了」） // 采样节拍：每 12 次（12×5s=60s）落一个点
function startMonitor() {
  setInterval(() => {
    histTick += 1;
    // 出口恢复：上一次是 stopped/error/starting，这一次 running → 告诉用户一声
    try {
      for (const t of state.tunnels || []) {
        const rt = tunnelRt(t.id) || {};
        const now = rt.status || 'stopped';
        const before = prevTunnelStatus.get(t.id);
        if (before && before !== 'running' && now === 'running' && t.enabled) {
          notify('tunnelUp', `出口「${t.name}」已恢复`,
            `${t.name} 重新上线（此前状态：${before}）\n地址：${publicUrlOf(t) || '(等待分配)'}\n主机：${os.hostname()}`);
        }
        prevTunnelStatus.set(t.id, now);
      }
    } catch { /* 巡检不能因为一个出口报错就停摆 */ }
    // 每 5 分钟体检一次：5xx 尖峰 + 登录失败集中，命中就发通知（notify 自带冷却/静默）
    if (histTick % 60 === 0) {
      try {
        const now = Date.now();
        const acc = readAccess(600);
        const rows = (acc && acc.rows) || [];
        const recent = rows.filter((r) => now - (r.at || 0) < 5 * 60 * 1000);
        const bad = recent.filter((r) => Number(r.status) >= 500);
        if (recent.length >= 20 && bad.length / recent.length >= 0.1 && now - lastSpike > 15 * 60 * 1000) {
          lastSpike = now;
          notify('errorSpike', '面板：5 分钟内 5xx 比例偏高',
            `${bad.length}/${recent.length} 个请求是 5xx（${Math.round((bad.length / recent.length) * 100)}%）\n主机：${os.hostname()}`);
        }
        // 公网有人扫 /db /term 这类服务：单 IP 10 分钟内 401/403 超过 20 次就提醒一次
        const sec = securityAttempts(10 / 60, 2000);
        const worst = (sec.byIp || [])[0];
        if (worst && worst.count >= 20 && now - lastScanAlert > 30 * 60 * 1000) {
          lastScanAlert = now;
          notify('authScan', '面板：有 IP 在反复试探受保护服务',
            `${worst.ip} 在 10 分钟内被拒 ${worst.count} 次\n打的规则：${(worst.rules || []).join('、') || '未命中规则'}\n可以在「代理规则」里给该路径加 IP 白名单或基础认证。`);
        }
        const fails = (audit.list({ limit: 200 }).rows || []).filter((a) => a.action === '登录失败' && now - (a.at || 0) < 10 * 60 * 1000);
        if (fails.length >= 5 && now - lastLoginAlert > 15 * 60 * 1000) {
          lastLoginAlert = now;
          const ips = [...new Set(fails.map((f) => f.ip))].slice(0, 3).join('、');
          notify('loginFail', '面板：10 分钟内多次登录失败',
            `${fails.length} 次失败，来源：${ips}\n如果不是你自己，建议改口令并开只读账号。`);
        }
      } catch {}
    }
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
