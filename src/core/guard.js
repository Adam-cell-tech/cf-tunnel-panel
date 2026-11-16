'use strict';
// 保存前的「危险配置」检查。
// 目标不是阻止高级用法，而是拦住两种会让人当场失联的写法：
//  1) 有一条 path: '/' 的兜底规则排在了中间 —— 它会把后面所有规则吃掉
//     （今天真实发生过：面板自己的 '/' 规则排在第一位，把 /site /demo 全转发给了面板 → 401/530）
//  2) 新规则集里没有任何一条把面板自己暴露出去 —— 保存完就再也进不来

function normHost(h) {
  return String(h || '').trim().toLowerCase();
}

function hostsOverlap(a, b) {
  const ha = normHost(a.host);
  const hb = normHost(b.host);
  if (!ha || !hb) return true; // 空 host = 匹配所有域名
  const sa = ha.split(',').map((s) => s.trim()).filter(Boolean);
  const sb = hb.split(',').map((s) => s.trim()).filter(Boolean);
  return sa.some((x) => sb.includes(x));
}

function pathCovers(a, b) {
  const pa = String(a.path || '/').trim() || '/';
  const pb = String(b.path || '/').trim() || '/';
  if (pa === pb) return true;
  if (pa === '/') return true;
  if (pa.endsWith('*')) return pb.startsWith(pa.slice(0, -1));
  if (pb === pa) return true;
  return pb.startsWith(pa) && (pb.length === pa.length || pb[pa.length] === '/');
}

/** 找出「被前面的规则吃掉」的规则 */
function shadowIssues(routes) {
  const list = Array.isArray(routes) ? routes : [];
  const issues = [];
  for (let j = 1; j < list.length; j += 1) {
    const later = list[j];
    if (later && later.enabled === false) continue;
    for (let i = 0; i < j; i += 1) {
      const prev = list[i];
      if (!prev || prev.enabled === false) continue;
      if (!hostsOverlap(prev, later)) continue;
      if (!pathCovers(prev, later)) continue;
      // /db 与 /db 这种同路径重复也算被吃掉（第一条永远胜出）
      issues.push({
        index: j,
        id: later.id,
        name: later.name || later.path,
        path: later.path,
        byIndex: i,
        byId: prev.id,
        byName: prev.name || prev.path || '/',
        reason: `被前面的「${prev.name || prev.path || '/'}」（第 ${i + 1} 条）拦住，永远收不到流量`,
      });
      break;
    }
  }
  return issues;
}

/** 面板自身是否还能被访问到（按上游端口判断） */
function panelExposed(routes, panelPort) {
  const port = String(panelPort || '');
  if (!port) return true;
  return (Array.isArray(routes) ? routes : []).some((r) => {
    if (!r || r.enabled === false) return false;
    const up = String(r.upstream || '');
    const m = up.match(/:(\d+)(?:[/?]|$)/);
    return !!m && m[1] === port;
  });
}

/**
 * 汇总检查结果。
 * @param {Array} routes 待保存的规则
 * @param {{panelPort?: string|number}} opts
 * @returns {{issues: Array, blocked: boolean}}
 */
function inspect(routes, opts = {}) {
  const issues = shadowIssues(routes).map((x) => ({ ...x, kind: 'shadow' }));
  // 「面板入口」只在「本来能进、改完就进不去」时拦 —— 否则像 CI 里那种
  // 根本不把面板挂在 Caddy 上的场景会被误判（真机上也一样：首次搭还没配面板入口时不该拦）
  const wasExposed = opts.prevRoutes ? panelExposed(opts.prevRoutes, opts.panelPort) : true;
  if (opts.panelPort && wasExposed && !panelExposed(routes, opts.panelPort)) {
    issues.push({
      kind: 'panel',
      index: -1,
      name: '面板自身',
      reason: `新规则里没有任何一条把上游指向面板端口 ${opts.panelPort}，保存后你可能再也打不开面板`,
    });
  }
  return { issues, blocked: issues.length > 0 };
}

module.exports = { inspect, shadowIssues, panelExposed, pathCovers, hostsOverlap };
