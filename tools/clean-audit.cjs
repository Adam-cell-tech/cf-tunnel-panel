#!/usr/bin/env node
'use strict';
/**
 * 清掉审计日志里的「测试 / 本机调试」流量。
 *
 * 为什么要：v0.29.0 之前没有区分测试流量，开发期我（以及 e2e 脚本）从
 * 127.0.0.1 和 198.51.100.x（文档保留网段，永远不可能有真实客户端）
 * 打了上万次 /api/settings、/api/login、/api/match，把「变更趋势」顶到
 * 一小时几百次改动 —— 数字从此不可信。
 *
 * 判据只看 IP，不看行为：回环地址与保留网段不可能是真实访问者。
 * 真实流量（局域网 192.168.x、公网 IP）一律保留。
 *
 * 用法（默认只打印报告，不动文件）：
 *   node tools/clean-audit.cjs                 # 演练
 *   node tools/clean-audit.cjs --apply         # 真删（先备份到 data/audit/.backup-*）
 *   node tools/clean-audit.cjs --since 2026-11-17 --apply
 *   node tools/clean-audit.cjs --json          # 机器可读
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const AUDIT_DIR = path.join(ROOT, 'data', 'audit');

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : ''; };

const APPLY = has('--apply');
const AS_JSON = has('--json');
const SINCE = val('--since');
const UNTIL = val('--until');
// 有些极早的行没有 ip/path/status（那时审计还没记全），属于无信息量的垃圾行
const DROP_INVALID = has('--drop-invalid');

/** 回环 + RFC 5737 文档保留网段：这些地址只可能来自本机测试 */
const TEST_NETS = [
  /^127\./,
  /^::1$/,
  /^0\.0\.0\.0$/,
  /^198\.51\.100\./,
  /^203\.0\.113\./,
  /^192\.0\.2\./,
  /^localhost$/i,
];
const isTestIp = (ip) => TEST_NETS.some((re) => re.test(String(ip || '').trim()));

const MUTATING = [
  /^\/api\/settings$/, /^\/api\/routes$/, /^\/api\/tunnels?(\/|$)/, /^\/api\/shares(\/|$)/,
  /^\/api\/config\/(apply|snapshot)$/, /^\/api\/(panel-auth|viewer|operator)$/, /^\/api\/totp\//,
  /^\/api\/import$/, /^\/api\/backups\/restore$/, /^\/api\/security\/(deny|allow)$/,
  /^\/api\/cf\/(tunnels|dns|cache)(\/|$)/, /^\/api\/monitor\/(mute|unmute)$/,
  /^\/api\/notify\/resend$/, /^\/api\/sessions\/revoke/,
];
/** 老记录没有 mutating 字段，按 method+path 回推（和 src/core/audit.js 保持一致） */
function isMutating(r) {
  if (typeof r.mutating === 'boolean') return r.mutating;
  if (!r.method || r.method === 'GET' || r.method === 'HEAD') return false;
  const p = String(r.path || '').split('?')[0];
  return MUTATING.some((re) => re.test(p));
}

function dayOf(at) {
  const d = new Date(Number(at) || 0);
  if (Number.isNaN(d.getTime())) return 'unknown';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function readRows(file) {
  const out = [];
  let bad = 0;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try { out.push(JSON.parse(s)); } catch { bad += 1; }
  }
  return { rows: out, bad };
}

function main() {
  if (!fs.existsSync(AUDIT_DIR)) {
    console.error(`没有审计目录：${AUDIT_DIR}`);
    process.exit(2);
  }
  const files = fs.readdirSync(AUDIT_DIR)
    .filter((f) => /^audit-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))
    .sort();

  const report = { dir: AUDIT_DIR, apply: APPLY, since: SINCE || null, until: UNTIL || null, days: [] };
  const totals = { rows: 0, drop: 0, keep: 0, bad: 0, mutBefore: 0, mutAfter: 0, byIp: {} };

  for (const f of files) {
    const day = f.slice(6, 16);
    if (SINCE && day < SINCE) continue;
    if (UNTIL && day > UNTIL) continue;

    const file = path.join(AUDIT_DIR, f);
    const { rows, bad } = readRows(file);
    const keep = [];
    let drop = 0;
    for (const r of rows) {
      const invalid = DROP_INVALID && (!String(r.ip || '').trim() || !String(r.path || '').trim() || !Number(r.status));
      const test = isTestIp(r.ip) || invalid;
      if (test) {
        drop += 1;
        const k = String(r.ip || '?') || '?';
        const key = invalid && !isTestIp(r.ip) ? '(无 ip/path/status)' : k;
        totals.byIp[key] = (totals.byIp[key] || 0) + 1;
      } else keep.push(r);
    }
    const mutBefore = rows.filter(isMutating).length;
    const mutAfter = keep.filter(isMutating).length;

    totals.rows += rows.length;
    totals.drop += drop;
    totals.keep += keep.length;
    totals.bad += bad;
    totals.mutBefore += mutBefore;
    totals.mutAfter += mutAfter;
    report.days.push({ file: f, day, rows: rows.length, drop, keep: keep.length, bad, mutBefore, mutAfter });

    if (APPLY && drop > 0) {
      const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
      // 备份放到 backups/ 下：audit/ 里的保留期清扫只认 audit-*.jsonl，
      // 备份留在原地会一直堆着，谁也不敢删
      const backupDir = path.join(ROOT, 'data', 'backups', 'audit-cleanup');
      fs.mkdirSync(backupDir, { recursive: true });
      const backup = path.join(backupDir, `${f}.${stamp}`);
      fs.copyFileSync(file, backup);
      const tmp = file + '.tmp';
      fs.writeFileSync(tmp, keep.map((r) => JSON.stringify(r)).join('\n') + (keep.length ? '\n' : ''));
      fs.renameSync(tmp, file);                       // 原子替换，写到一半断电也不会留下半个文件
      report.days[report.days.length - 1].backup = path.basename(backup);
    }
  }

  if (AS_JSON) {
    console.log(JSON.stringify({ ...report, totals }, null, 2));
    return;
  }

  console.log(`审计目录：${AUDIT_DIR}`);
  console.log(`${APPLY ? '模式：真删（已备份）' : '模式：演练（不动文件）'}${SINCE ? `  从 ${SINCE}` : ''}${UNTIL ? `  到 ${UNTIL}` : ''}\n`);
  for (const d of report.days) {
    console.log(`  ${d.day}  总 ${String(d.rows).padStart(6)}  删 ${String(d.drop).padStart(6)}  留 ${String(d.keep).padStart(5)}` +
      `  变更 ${String(d.mutBefore).padStart(5)} → ${String(d.mutAfter).padStart(4)}${d.bad ? `  (坏行 ${d.bad})` : ''}`);
  }
  const pct = totals.rows ? Math.round((totals.drop / totals.rows) * 1000) / 10 : 0;
  console.log(`\n合计：${totals.rows} 行 → 删除 ${totals.drop}（${pct}%），保留 ${totals.keep}`);
  console.log(`变更数：${totals.mutBefore} → ${totals.mutAfter}`);
  const ips = Object.entries(totals.byIp).sort((a, b) => b[1] - a[1]).slice(0, 8);
  if (ips.length) console.log('按 IP：' + ips.map(([k, v]) => `${k}×${v}`).join('  '));
  if (!APPLY) console.log('\n演练结束。确认无误后加 --apply 真删（每个文件先备份到 data/backups/audit-cleanup/）。');
}

main();
