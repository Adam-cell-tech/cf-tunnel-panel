'use strict';
/**
 * Caddy 配置下发（防抖 + 失败记录）
 * 从 src/server.js 按职责拆出（v0.9.0），仅做搬运，行为不变。
 */

const http=require('http'); const https=require('https');

const { CADDY_ADMIN } = require('./paths');
const { log } = require('./util');
const { buildCaddyConfig, caddy } = require('./caddy');
let pushTimer = null;
// 规则按出口域名收窄，所以出口上线/掉线/换域名后必须重新下发一次
function schedulePush(delay = 500) {
  if (pushTimer) return;
  pushTimer = setTimeout(() => {
    pushTimer = null;
    pushCaddy().catch(() => {});
  }, delay);
  if (pushTimer.unref) pushTimer.unref();
}

// Cloudflare 公布的边缘节点 IP 段（https://www.cloudflare.com/ips/）。
// 隧道进来的流量对端是这些节点，真实访客 IP 在 CF-Connecting-IP 头里；
// 要按真实访客做 IP 白名单/黑名单，必须先让 Caddy 信任这些代理段。
// 段表会变（Cloudflare 偶尔新增），可用环境变量 CLOUDFLARE_IPS 覆盖（逗号分隔）。
async function pushCaddy() {
  let cfg;
  try {
    cfg = buildCaddyConfig();
  } catch (e) {
    caddy.ok = false;
    caddy.error = '生成配置失败: ' + e.message;
    log(caddy.error, 'caddy');
    return caddy;
  }
  try {
    const res = await fetch(`${CADDY_ADMIN}/load`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: CADDY_ADMIN },
      body: JSON.stringify(cfg),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    caddy.ok = true;
    caddy.error = null;
    caddy.lastPush = Date.now();
    caddy.routeCount = cfg.apps.http.servers.main.routes.length - 1;
    log(`已下发 ${caddy.routeCount} 条代理规则到 Caddy（监听 ${state.settings.caddyListen}）`, 'caddy');
  } catch (e) {
    caddy.ok = false;
    caddy.error = e.message;
    log(`Caddy 配置下发失败: ${e.message}`, 'caddy');
  }
  return caddy;
}

// ---------------------------------------------------------------- cloudflared（多隧道出口）
// 每个出口 = 一条独立的 cloudflared 进程，互不影响。典型用法：
//   ① 快速隧道试跑 + 命名隧道长期并存
//   ② 多个命名隧道（不同 Cloudflare 账号 / 不同域名 / 不同机房）
// 它们在 Caddy 这一层汇合：默认都指向 http://127.0.0.1:8080，再由面板规则分流。

const _state = require('./state');
const state = _state.stateProxy;

module.exports = { pushCaddy, pushTimer, schedulePush };
