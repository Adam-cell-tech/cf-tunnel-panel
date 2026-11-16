'use strict';
// 配置即代码：把 state 投影成一份「声明式配置」，支持快照、差异、按声明应用。
// 设计要点：
//  - 只暴露可写的公开字段（token / 口令 / webhook 地址一律不导出，应用时按 id 沿用旧值）
//  - 每次 apply 前先落一份快照，出问题可以按快照回滚（复用 /api/backups/restore 的思路）
//  - drift = 「当前运行状态」与「最近一次 apply 的声明」之间的差异，用来发现有人手改了面板
const fs = require('fs');
const path = require('path');

function snapDir(dataDir) {
  const d = path.join(dataDir, 'config');
  fs.mkdirSync(d, { recursive: true });
  return d;
}

const ROUTE_FIELDS = ['id', 'name', 'path', 'host', 'upstream', 'backupUpstream', 'strip', 'timeoutSec',
  'matchMethod', 'ipAllow', 'headersReq', 'headersRes', 'ipDeny', 'tunnelId', 'note', 'enabled',
  'lbTryDuration', 'lbPolicy'];
const TUNNEL_FIELDS = ['id', 'name', 'enabled', 'mode', 'origin', 'publicHostname', 'protocol',
  'loglevel', 'metricsPort', 'extraArgs'];

function pick(obj, fields) {
  const out = {};
  for (const f of fields) if (obj && obj[f] !== undefined) out[f] = obj[f];
  return out;
}

function routeView(r) {
  const v = pick(r, ROUTE_FIELDS);
  if (r && r.basicAuth && r.basicAuth.user) v.basicAuth = { user: r.basicAuth.user };
  return v;
}

function tunnelView(t) {
  const v = pick(t, TUNNEL_FIELDS);
  v.hasToken = !!(t && t.token);
  return v;
}

function settingsView(s) {
  const c = JSON.parse(JSON.stringify(s || {}));
  // 只留声明式的部分；密钥类只留 has* 标记
  const out = {
    panelTitle: c.panelTitle,
    caddyListen: c.caddyListen,
    notFoundBody: c.notFoundBody,
    maintenance: c.maintenance,
    security: { ipDeny: c.security && c.security.ipDeny, rateLimit: c.security && c.security.rateLimit },
    notify: {
      format: c.notify && c.notify.format,
      events: c.notify && c.notify.events,
      cooldownSec: c.notify && c.notify.cooldownSec,
      quietHours: c.notify && c.notify.quietHours,
      template: c.notify && c.notify.template,
      hasUrl: !!(c.notify && c.notify.url),
      hasSecret: !!(c.notify && c.notify.secret),
    },
    cf: { accountId: c.cf && c.cf.accountId, zoneId: c.cf && c.cf.zoneId, hasToken: !!(c.cf && c.cf.token) },
  };
  return out;
}

/** 当前运行状态 → 声明式配置 */
function snapshot(state) {
  return {
    apiVersion: 'cf-tunnel-panel/v1',
    kind: 'Config',
    settings: settingsView(state.settings),
    tunnels: (state.tunnels || []).map(tunnelView),
    routes: (state.routes || []).map(routeView),
    shares: (state.shares || []).map((x) => ({ name: x.name, path: x.path, upstream: x.upstream, expiresAt: x.expiresAt })),
  };
}

/** 差异：按 id 对齐，逐字段比；返回 {added, removed, changed} */
function diffView(prev, next) {
  const byId = (list) => new Map((list || []).map((x) => [String(x.id), x]));
  const out = { added: [], removed: [], changed: [] };
  for (const key of ['routes', 'tunnels']) {
    const a = byId(prev && prev[key]);
    const b = byId(next && next[key]);
    for (const [id, v] of b) {
      if (!a.has(id)) out.added.push({ kind: key, id, name: v.name || v.path || '' });
      else {
        const old = a.get(id);
        const fields = [];
        for (const f of Object.keys(v)) {
          if (JSON.stringify(old[f]) !== JSON.stringify(v[f])) fields.push(f);
        }
        if (fields.length) out.changed.push({ kind: key, id, name: v.name || v.path || '', fields });
      }
    }
    for (const [id, v] of a) {
      if (!b.has(id)) out.removed.push({ kind: key, id, name: v.name || v.path || '' });
    }
  }
  const sOld = JSON.stringify(prev && prev.settings || {});
  const sNew = JSON.stringify(next && next.settings || {});
  out.settingsChanged = sOld !== sNew;
  return out;
}

function stamp(d = new Date()) {
  return d.toISOString().replace(/[:.]/g, '-');
}

/** 落一份快照：data/config/<ts>-<label>.json，保留最近 80 份 */
function writeSnapshot(dataDir, cfg, label = 'apply') {
  const dir = snapDir(dataDir);
  const file = path.join(dir, `${stamp()}-${String(label).replace(/[^\w-]/g, '') || 'apply'}.json`);
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2));
  const all = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
  for (const f of all.slice(0, Math.max(0, all.length - 80))) {
    try { fs.unlinkSync(path.join(dir, f)); } catch { /* ignore */ }
  }
  // 最近一次 apply 的声明，供 drift 比较
  if (label === 'apply') fs.writeFileSync(path.join(dir, 'last-applied.json'), JSON.stringify(cfg, null, 2));
  return path.basename(file);
}

function listSnapshots(dataDir, limit = 20) {
  const dir = snapDir(dataDir);
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.json') && f !== 'last-applied.json')
    .sort()
    .reverse()
    .slice(0, limit)
    .map((f) => {
      const st = fs.statSync(path.join(dir, f));
      return { file: f, bytes: st.size, at: st.mtime.toISOString() };
    });
}

function readSnapshot(dataDir, file) {
  if (!/^[\w.-]+\.json$/.test(String(file || ''))) throw new Error('快照文件名不合法');
  const p = path.join(snapDir(dataDir), path.basename(file));
  if (!fs.existsSync(p)) throw new Error('这份快照不在了');
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function lastApplied(dataDir) {
  const p = path.join(snapDir(dataDir), 'last-applied.json');
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

module.exports = { snapshot, diffView, writeSnapshot, listSnapshots, readSnapshot, lastApplied, settingsView, tunnelView, routeView };
