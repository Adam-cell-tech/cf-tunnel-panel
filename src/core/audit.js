'use strict';
/**
 * 审计日志：谁、从哪个 IP、什么时候、对什么做了什么。
 *
 * 为什么要有：面板已经能通过隧道从公网访问，改一条规则、关一次维护模式、
 * 换一次面板密码，都可能是"别人干的"。配置备份只能告诉你"被改过"，
 * 审计日志才能告诉你"谁改的、从哪里改的、改完成没成"。
 *
 * 落盘策略：内存环形缓冲 500 条 + data/audit.log 追加写入（JSON Lines），
 * 文件超过 2MB 时只保留最后 3000 行（防无限膨胀，又不丢最近的痕迹）。
 */

const fs = require('fs');
const path = require('path');

const { DATA_DIR } = require('./paths');

const AUDIT_MAX = 500;
const FILE_MAX_BYTES = 2 * 1024 * 1024;
const KEEP_LINES = 3000;

const AUDIT_FILE = path.join(DATA_DIR, 'audit.log');
const buffer = [];
let seq = 0;

/** 路径 → 人话动作。匹配不到的就不做翻译，直接记原始路径（宁可糙也别瞎猜）。 */
const ACTIONS = [
  [/^\/api\/panel-auth$/, '面板登录口令/账号变更'],
  [/^\/api\/viewer$/, '只读账号变更'],
  [/^\/api\/routes$/, '修改代理规则'],
  [/^\/api\/settings$/, '修改全局设置'],
  [/^\/api\/tunnels\/start-all$/, '启动全部出口'],
  [/^\/api\/tunnels\/stop-all$/, '停止全部出口'],
  [/^\/api\/tunnels\/[^/]+\/delete$/, '删除隧道出口'],
  [/^\/api\/tunnels\/[^/]+\/(start|stop|restart)$/, '启停隧道出口'],
  [/^\/api\/tunnels\/[^/]+$/, '修改隧道出口'],
  [/^\/api\/tunnels$/, '新建隧道出口'],
  [/^\/api\/shares$/, '新建一次性分享'],
  [/^\/api\/shares\/[^/]+\/delete$/, '删除分享链接'],
  [/^\/api\/backups\/restore$/, '回滚配置'],
  [/^\/api\/import$/, '导入配置'],
  [/^\/api\/cf\/dns$/, '新建 DNS 记录'],
  [/^\/api\/cf\/dns\/[^/]+\/delete$/, '删除 DNS 记录'],
  [/^\/api\/cf\/tunnels$/, '云端建隧道'],
  [/^\/api\/cf\/tunnels\/[^/]+\/delete$/, '云端删隧道'],
  [/^\/api\/notify\/test$/, '发测试通知'],
  [/^\/api\/curl$/, '链路自测'],
  [/^\/api\/ws-test$/, 'WebSocket 自测'],
  [/^\/api\/bench\/local$/, '本机回环测速'],
  [/^\/api\/rules\/test$/, '测上游可达性'],
];

function actionOf(method, url) {
  const p = String(url || '').split('?')[0];
  for (const [re, label] of ACTIONS) if (re.test(p)) return label;
  if (method === 'GET' || method === 'HEAD') return '查看';
  return `${method} ${p}`;
}

/** 写一条审计记录（内存 + 文件） */
function record(entry = {}) {
  const rec = {
    seq: ++seq,
    at: entry.at || Date.now(),
    actor: String(entry.actor || '').slice(0, 60) || '(未登录)',
    ip: String(entry.ip || '').slice(0, 60),
    method: String(entry.method || ''),
    path: String(entry.path || '').slice(0, 300),
    status: Number(entry.status || 0),
    ms: Number(entry.ms || 0),
    action: String(entry.action || '').slice(0, 80),
    target: String(entry.target || '').slice(0, 200),
    ok: entry.ok !== false,
  };
  // 同一次请求可能被「显式记账」和「收尾兜底」各记一条：兜底那条的 action 是「POST /api/xxx」形式，
  // 若前一条同 method+path+status 且间隔 <1s、action 是人话，就丢弃这条兜底记录，避免审计里成对出现。
  const generic = /^(?:GET|POST|PUT|PATCH|DELETE) \/api\//.test(rec.action);
  const prev = buffer[buffer.length - 1];
  if (generic && prev && prev.method === rec.method && prev.path === rec.path && prev.status === rec.status
      && Math.abs(rec.at - prev.at) < 1000 && !/^(?:GET|POST|PUT|PATCH|DELETE) \/api\//.test(prev.action)) {
    return prev;
  }
  buffer.push(rec);
  if (buffer.length > AUDIT_MAX) buffer.splice(0, buffer.length - AUDIT_MAX);
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.appendFileSync(AUDIT_FILE, JSON.stringify(rec) + '\n');
    maybeRotate();
  } catch { /* 写不进去不影响主流程 */ }
  return rec;
}

let rotateAt = 0;
function maybeRotate() {
  const now = Date.now();
  if (now - rotateAt < 60000) return; // 每分钟最多检查一次
  rotateAt = now;
  try {
    const st = fs.statSync(AUDIT_FILE);
    if (st.size <= FILE_MAX_BYTES) return;
    const lines = fs.readFileSync(AUDIT_FILE, 'utf8').trim().split('\n');
    fs.writeFileSync(AUDIT_FILE, lines.slice(-KEEP_LINES).join('\n') + '\n');
  } catch { /* 忽略 */ }
}

function matches(rec, q) {
  if (!q) return true;
  const s = q.toLowerCase();
  return [rec.actor, rec.ip, rec.action, rec.path, rec.target]
    .some((v) => String(v || '').toLowerCase().includes(s));
}

/**
 * 按整点聚合「变更频率」：观测页趋势图用它画第二根柱子。
 * 只统计写操作与失败调用（record 本来就只记这些），所以这就是"谁在什么时候动过手"的密度。
 */
function byHour(hours = 12) {
  const n = Math.min(Math.max(Number(hours) || 12, 1), 72);
  let rows = buffer.slice();
  if (!rows.length) rows = readFileTail();
  const now = new Date();
  const buckets = [];
  const index = new Map();
  for (let i = n - 1; i >= 0; i -= 1) {
    const d = new Date(now);
    d.setHours(d.getHours() - i, 0, 0, 0);
    const k = d.getTime();
    const b = { t: k, total: 0, ok: 0, err: 0 };
    buckets.push(b);
    index.set(k, b);
  }
  const from = buckets.length ? buckets[0].t : 0;
  for (const r of rows) {
    if (!r || !r.at || r.at < from) continue;
    const d = new Date(r.at);
    d.setMinutes(0, 0, 0);
    const b = index.get(d.getTime());
    if (!b) continue;
    b.total += 1;
    if (r.ok) b.ok += 1; else b.err += 1;
  }
  return buckets;
}

/** 读审计：内存优先；进程刚重启时回落到文件 */
function list({ limit = 100, q = '' } = {}) {
  const n = Math.min(Math.max(Number(limit) || 100, 1), 500);
  // 读文件而不是只读内存：横向扩展下另一个实例记的条目也要看得见，
  // 重启后历史也还在（内存环形只是写盘失败的兜底）。
  let rows = readFileTail();
  if (!rows.length) rows = buffer.slice();
  const total = rows.length;
  rows = rows.filter((r) => matches(r, q)).reverse().slice(0, n);
  return { ok: true, available: rows.length > 0 || total > 0, count: total, rows };
}

function readFileTail() {
  try {
    const lines = fs.readFileSync(AUDIT_FILE, 'utf8').trim().split('\n');
    return lines.slice(-AUDIT_MAX).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

function stats() {
  let size = 0;
  try { size = fs.statSync(AUDIT_FILE).size; } catch {}
  return { count: buffer.length, fileBytes: size, file: AUDIT_FILE };
}

module.exports = { record, list, stats, byHour, actionOf, AUDIT_FILE, AUDIT_MAX };
