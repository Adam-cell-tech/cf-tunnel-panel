'use strict';
/**
 * 一键体检：把「面板到底哪里不对」一次性查出来。
 *
 * 为什么要有：出问题时，线索分散在四个地方 —— 面板自己的 /healthz、Caddy 的 admin
 * 接口、每个出口的 cloudflared 进程、以及外部依赖（Prometheus / Grafana）。
 * 以前要靠人一个个 curl；现在一个按钮，每条都给「结论 + 证据 + 怎么办」。
 *
 * 设计取舍：
 * - 全部并行、单个超时 3 秒，最慢一次体检 ≈ 3 秒（有一个卡住也不会拖死整页）
 * - 任何一条抛错都只影响它自己，不吞掉其它结论
 * - 状态只有三档：ok / warn / fail（warn = 能用但有隐患，fail = 这条链路断了）
 */

const fs = require('fs');
const path = require('path');
const { CADDY_ADMIN, DATA_DIR, STATE_FILE, pkgVersion } = require('./paths');

const TIMEOUT = 3000;

async function fetchText(url, ms = TIMEOUT, headers = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, { headers, signal: ctrl.signal, redirect: 'manual' });
    const text = await r.text().catch(() => '');
    return { status: r.status, text };
  } finally {
    clearTimeout(timer);
  }
}

const kb = (n) => {
  if (n >= 1 << 30) return `${(n / (1 << 30)).toFixed(1)} GB`;
  if (n >= 1 << 20) return `${(n / (1 << 20)).toFixed(1)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} B`;
};
const short = (x) => String(x || '').slice(0, 8);
const trimUrl = (u) => String(u || '').trim().replace(/\/+$/, '');

/** 单条检查的统一外壳：计时 + 兜住异常 */
async function step(id, name, fn) {
  const t0 = Date.now();
  try {
    const out = (await fn()) || {};
    return { id, name, status: out.status || 'ok', detail: out.detail || '', hint: out.hint || '', ms: Date.now() - t0 };
  } catch (e) {
    const msg = e && e.name === 'AbortError' ? `超时（${TIMEOUT}ms 没响应）` : (e && e.message) || String(e);
    return { id, name, status: 'fail', detail: msg, hint: '', ms: Date.now() - t0 };
  }
}

/**
 * @param {object} state   当前 state（含 settings / tunnels / routes）
 * @param {object} ctx     { runtime, version, code, imageCode, drift, role }
 */
async function runChecks(state, ctx = {}) {
  const s = state || {};
  const settings = s.settings || {};
  const runtime = ctx.runtime || {};
  const checks = [];

  // 1) 版本与代码指纹：docker cp 部署过的老坑
  checks.push(await step('version', '版本与代码一致', async () => {
    const drift = ctx.drift === true;
    return {
      status: drift ? 'warn' : 'ok',
      detail: `${ctx.version || pkgVersion()} · 代码 ${short(ctx.code)}${ctx.imageCode || ctx.build ? ` · 镜像 ${short(ctx.imageCode || ctx.build)}` : ''}`,
      hint: drift ? '运行中的代码和镜像里打包的不一样（很可能是 docker cp 临时改过）。重新构建镜像再滚动升级即可消除。' : '',
    };
  }));

  // 2) 实例角色
  checks.push(await step('role', '实例角色', async () => {
    const role = ctx.role || 'leader';
    return {
      status: role === 'standby' ? 'warn' : 'ok',
      detail: role === 'standby' ? '只读备份实例（写操作会 409）' : '主实例（leader，负责下发配置）',
      hint: role === 'standby' ? '这是滚动升级期间的正常状态。如果一直停在 standby，说明主实例的租约没释放。' : '',
    };
  }));

  // 3) Caddy 管理接口
  checks.push(await step('caddy', 'Caddy 管理接口', async () => {
    // Caddy 的 admin 接口会校验 Origin，必须带（和 pusher.js 下发时同一个值）
    const r = await fetchText(`${CADDY_ADMIN}/config/`, TIMEOUT, { Origin: CADDY_ADMIN });
    if (r.status >= 200 && r.status < 300) return { status: 'ok', detail: `${CADDY_ADMIN} 有响应（HTTP ${r.status}）` };
    return {
      status: 'fail',
      detail: `HTTP ${r.status}`,
      hint: 'Caddy 容器可能没起来，或 admin 端口不是 20190。看 `docker ps | grep caddy`。',
    };
  }));

  // 4) 已载入的路由数
  checks.push(await step('routes', '规则数一致', async () => {
    const loaded = runtime.caddy ? runtime.caddy.routeCount : null;
    const local = (s.routes || []).filter((x) => !x.disabled).length;
    const caddyOk = !!(runtime.caddy && runtime.caddy.ok);
    if (!caddyOk) return { status: 'fail', detail: '最后一次下发失败', hint: (runtime.caddy && runtime.caddy.error) || '看「规则」页顶部提示' };
    if (loaded === null || loaded === undefined) return { status: 'warn', detail: '拿不到 Caddy 的规则数' };
    return {
      status: loaded === local ? 'ok' : 'warn',
      detail: `本地 ${local} 条 · Caddy 里 ${loaded} 条`,
      hint: loaded === local ? '' : '两边不一致说明最后一次下发没完全生效；点「规则」页的「下发到 Caddy」重试。',
    };
  }));

  // 5) 遮蔽检测（path:/ 吃掉同域名其它路径那个坑）
  checks.push(await step('shadow', '规则遮蔽', async () => {
    const list = (runtime.caddy && runtime.caddy.shadowed) || [];
    if (!list.length) return { status: 'ok', detail: '没有规则被同域名的更宽规则吃掉' };
    return {
      status: 'warn',
      detail: `${list.length} 条被遮蔽`,
      hint: list.slice(0, 3).map((x) => `${x.path || x.host} 被 ${x.by || '?'} 覆盖`).join('；'),
    };
  }));

  // 6) 出口：进程状态 + 公网可访问性（最多查 5 个，免得一次体检拖太久）
  const exits = (s.tunnels || []).filter((t) => t.mode === 'named');
  for (const t of exits.slice(0, 5)) {
    checks.push(await step(`exit-${t.id}`, `出口：${t.name || t.id}`, async () => {
      const rt = runtime.tunnels && runtime.tunnels[t.id];
      const st = rt ? rt.status : 'stopped';
      const url = (rt && (rt.publicUrl || rt.url)) || '';
      if (st !== 'running') {
        return { status: 'fail', detail: `进程没在跑（${st}）`, hint: '在「隧道出口」页点「启动」；反复退出看日志里的 cloudflared 报错。' };
      }
      if (!url) return { status: 'warn', detail: '在跑，但没有公网地址' };
      const r = await fetchText(url, TIMEOUT);
      const healthy = r.status < 500;
      return {
        status: healthy ? 'ok' : 'warn',
        detail: `${url} → HTTP ${r.status}`,
        hint: healthy ? '' : 'cloudflared 在跑但对端返回 5xx；多半是背后那个上游服务挂了，或 Cloudflare 侧的 ingress 没指到这里。',
      };
    }));
  }

  // 7) Prometheus
  const prom = trimUrl((settings.monitoring || {}).promUrl);
  checks.push(await step('prometheus', 'Prometheus', async () => {
    if (!prom) return { status: 'warn', detail: '没配地址', hint: '设置 → 监控嵌入 → Prometheus 地址' };
    const r = await fetchText(`${prom}/-/ready`);
    return {
      status: r.status === 200 ? 'ok' : 'fail',
      detail: `${prom} → HTTP ${r.status}`,
      hint: r.status === 200 ? '' : 'Prometheus 容器没起来，或地址写错（端口默认 9090）。',
    };
  }));

  // 7b) Prometheus 有没有真的抓到面板（ready 只是它自己活着）
  checks.push(await step('scrape', 'Prometheus 抓到面板', async () => {
    if (!prom) return { status: 'warn', detail: '没配 Prometheus 地址' };
    const r = await fetchText(`${prom}/api/v1/targets`);
    let list = [];
    try { list = (JSON.parse(r.text).data.activeTargets) || []; } catch { return { status: 'warn', detail: '拿不到 targets（接口格式变了？）' }; }
    const up = list.filter((t) => t.health === 'up').length;
    const down = list.filter((t) => t.health !== 'up');
    // 双槽位部署：滚动升级时总有一色停着，它的 target 必然 down，不算故障
    const SLOT = /:(8090|8095)\b/;
    const realDown = down.filter((t) => !SLOT.test(t.scrapeUrl || t.labels.instance || ''));
    return {
      status: realDown.length ? 'fail' : up ? 'ok' : 'warn',
      detail: `${up}/${list.length} 在抓${down.length && !realDown.length ? `（另 ${down.length} 个是停着的备份槽位）` : ''}`,
      hint: realDown.length
        ? `抓不到：${realDown.map((t) => t.scrapeUrl).slice(0, 3).join('、')}`
        : up ? '' : '一个目标都没抓到，看 prometheus.yml 的 targets 与面板端口。',
    };
  }));

  // 8) Grafana
  const gf = settings.grafana || {};
  checks.push(await step('grafana', 'Grafana', async () => {
    if (!gf.enabled) return { status: 'warn', detail: '没启用嵌入', hint: '设置 → 监控嵌入 → 打开「嵌入 Grafana」' };
    const base = trimUrl(gf.url);
    if (!base) return { status: 'warn', detail: '没配地址' };
    const r = await fetchText(`${base}/api/health`);
    let db = '';
    try { db = (JSON.parse(r.text) || {}).database || ''; } catch { /* 不是 JSON 就只看状态码 */ }
    const healthy = r.status === 200 && (!db || db === 'ok');
    return {
      status: healthy ? 'ok' : 'fail',
      detail: `${base} → HTTP ${r.status}${db ? ` · 数据库 ${db}` : ''}`,
      hint: healthy ? '' : 'Grafana 没起来或数据库没就绪；`docker logs cfp-grafana` 看原因。',
    };
  }));

  // 9) 数据盘
  checks.push(await step('disk', '数据盘空间', async () => {
    const st = fs.statfsSync(DATA_DIR);
    const free = st.bavail * st.bsize;
    const total = st.blocks * st.bsize;
    const pct = total ? free / total : 1;
    const status = pct < 0.05 ? 'fail' : pct < 0.15 ? 'warn' : 'ok';
    return {
      status,
      detail: `剩余 ${kb(free)} / 共 ${kb(total)}（${Math.round(pct * 100)}%）`,
      hint: status === 'ok' ? '' : '审计与备份都写在数据盘上，满了会写不进去；清 audit/ 与 backups/ 里的老文件。',
    };
  }));

  // 10) 状态文件可写 + 新鲜度
  checks.push(await step('state', '状态文件', async () => {
    const st = fs.statSync(STATE_FILE);
    const ageMin = Math.round((Date.now() - st.mtimeMs) / 60000);
    fs.accessSync(STATE_FILE, fs.constants.W_OK);
    return {
      status: 'ok',
      detail: `${path.basename(STATE_FILE)} ${kb(st.size)} · ${ageMin} 分钟前改过`,
    };
  }));

  const fail = checks.filter((c) => c.status === 'fail').length;
  const warn = checks.filter((c) => c.status === 'warn').length;
  return { ok: fail === 0, fail, warn, total: checks.length, checkedAt: Date.now(), checks };
}

module.exports = { runChecks };
