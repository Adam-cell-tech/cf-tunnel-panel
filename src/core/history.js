'use strict';
/**
 * 历史数据落盘（v0.19.0）
 *
 * 为什么要有这个：横向扩展下两台实例各自在内存里攒「出口在线曲线」和「通知记录」，
 * 于是用户刷新页面时，落在 A 上看到的是一份历史、落在 B 上是另一份；
 * 而且一重启就全没了。这两样都属于「看一眼趋势」的数据，不参与决策，
 * 所以放磁盘上共享最省事：谁在跑就往同一个 JSONL 里追加，两边都读同一个文件。
 *
 * 两个文件都在 DATA_DIR/history/ 下：
 *   samples.jsonl  {t, running, total, caddyOk, req, inst}   每分钟一条（只有 leader 写）
 *   notify.jsonl   {seq, t, event, title, status, extra, text, inst}
 *
 * 取舍：
 * - 追加写（appendFileSync），不做锁 —— 两个进程同时追加各自一行是原子的，
 *   顺序可能交错，但按 t 排序就没差别。
 * - 文件超过 MAX_BYTES 时重写成「最后 KEEP_LINES 行」（临时文件 + rename），
 *   避免无限增长；重写期间另一进程可能追加，最坏情况丢一行采样，可接受。
 * - 采样按分钟去重：两个实例都写也只留一条（leader 切换时不会出现重复点）。
 */

const fs = require('fs');
const path = require('path');

const SAMPLE_MAX = 240;        // 内存里保留的点数（4 小时，每分钟一点）
const NOTIFY_MAX = 200;        // 通知记录条数
const MAX_BYTES = 512 * 1024;  // 单个文件上限，超了重写
const KEEP_LINES = 2000;       // 重写时保留的行数
const TAIL_BYTES = 256 * 1024; // 读取时只读文件末尾这么多

let dir = null;
let sampleFile = null;
let notifyFile = null;
let samples = [];              // 旧→新
let notifies = [];             // 旧→新
let inited = false;

/** 读文件末尾若干字节，解析成对象数组（坏行跳过） */
function readTail(file, max) {
  let buf;
  try {
    const st = fs.statSync(file);
    const size = st.size;
    const start = Math.max(0, size - TAIL_BYTES);
    const fd = fs.openSync(file, 'r');
    buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);
  } catch {
    return [];
  }
  const lines = buf.toString('utf8').split('\n');
  // 从末尾读取时第一行可能是半截（除非正好从 0 开始），丢掉
  if (buf.length && buf.length < (fs.statSync(file).size || 0)) lines.shift();
  const out = [];
  for (const line of lines) {
    const s = line.trim();
    if (!s) continue;
    try {
      const o = JSON.parse(s);
      if (o && typeof o === 'object') out.push(o);
    } catch { /* 半截行/损坏行，跳过 */ }
  }
  return out.slice(-max);
}

/** 文件太大就重写成最后 KEEP_LINES 行 */
function trimIfBig(file) {
  let size = 0;
  try { size = fs.statSync(file).size; } catch { return; }
  if (size <= MAX_BYTES) return;
  try {
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter((x) => x.trim());
    const keep = lines.slice(-KEEP_LINES).join('\n') + '\n';
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, keep);
    fs.renameSync(tmp, file);
  } catch { /* 失败就算了，下次再试 */ }
}

function appendLine(file, obj) {
  try {
    fs.appendFileSync(file, JSON.stringify(obj) + '\n');
    trimIfBig(file);
    return true;
  } catch {
    return false;
  }
}

/** 初始化（server 启动时调一次；重复调用是幂等的） */
function init(dataDir) {
  if (!dataDir) return false;
  dir = path.join(dataDir, 'history');
  try { fs.mkdirSync(dir, { recursive: true }); } catch { return false; }
  sampleFile = path.join(dir, 'samples.jsonl');
  notifyFile = path.join(dir, 'notify.jsonl');
  samples = readTail(sampleFile, SAMPLE_MAX);
  notifies = readTail(notifyFile, NOTIFY_MAX);
  inited = true;
  return true;
}

/** 另一实例可能刚写了新数据：按需重读（节流 2 秒，避免每个请求都读盘） */
let lastLoad = 0;
function refresh(force = false) {
  if (!inited) return;
  const now = Date.now();
  if (!force && now - lastLoad < 2000) return;
  lastLoad = now;
  samples = readTail(sampleFile, SAMPLE_MAX);
  notifies = readTail(notifyFile, NOTIFY_MAX);
}

/** 追加一条采样：同一分钟内只留一条（两个实例都写也不会重复） */
function appendSample(o) {
  const rec = {
    t: Number(o.t) || Date.now(),
    running: Number(o.running) || 0,
    total: Number(o.total) || 0,
    caddyOk: o.caddyOk ? 1 : 0,
    req: Number(o.req) || 0,
    inst: o.inst || null,
  };
  const minute = Math.floor(rec.t / 60000);
  const last = samples[samples.length - 1];
  if (last && Math.floor(last.t / 60000) === minute) return false;
  samples.push(rec);
  if (samples.length > SAMPLE_MAX) samples.splice(0, samples.length - SAMPLE_MAX);
  if (sampleFile) appendLine(sampleFile, rec);
  return true;
}

/** 追加一条通知记录（seq 用毫秒时间戳，跨实例也不会撞） */
function appendNotify(o) {
  const rec = {
    seq: Number(o.seq) || Date.now(),
    t: Number(o.t) || Date.now(),
    event: String(o.event || ''),
    title: String(o.title || ''),
    status: String(o.status || ''),
    extra: String(o.extra || ''),
    text: String(o.text || ''),
    inst: o.inst || null,
  };
  notifies.push(rec);
  if (notifies.length > NOTIFY_MAX) notifies.splice(0, notifies.length - NOTIFY_MAX);
  if (notifyFile) appendLine(notifyFile, rec);
  return rec;
}

/** 采样点（旧→新） */
function sampleList() {
  refresh();
  return samples.slice();
}

/** 通知记录（旧→新） */
function notifyList() {
  refresh();
  return notifies.slice();
}

/** 按 seq 找一条通知（重发用） */
function notifyBySeq(seq) {
  refresh(true);
  return notifies.filter((x) => x.seq === Number(seq)).pop() || null;
}

function stats() {
  const size = (f) => { try { return fs.statSync(f).size; } catch { return 0; } };
  return {
    dir,
    inited,
    samples: samples.length,
    notifies: notifies.length,
    sampleBytes: size(sampleFile),
    notifyBytes: size(notifyFile),
  };
}

module.exports = {
  SAMPLE_MAX, NOTIFY_MAX,
  init, refresh, appendSample, appendNotify,
  sampleList, notifyList, notifyBySeq, stats,
};
