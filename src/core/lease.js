'use strict';
// 领导权租约（用于「两个进程同时活」的滚动升级）
//
// 为什么需要它：state.json / Caddy 推送 / cloudflared 子进程都只能有**一个**属主。
// 所以第二个实例不是「同等副本」，而是**只读的备份实例**：能服务页面与查询接口，
// 但一切写操作都拒掉（409 STANDBY），等老实例退场后由它接管。
//
// 为什么不用 pid 判活：容器之间 pid 命名空间隔离，两个容器里都是 PID 1，
// process.kill(pid,0) 永远成功 —— 早期单实例锁正是因此误判。这里只用**心跳时间戳**。
const fs = require('fs');
const path = require('path');
const os = require('os');

const TTL_MS = Number(process.env.PANEL_LEASE_TTL_MS || 15000); // 15 秒没心跳视为死掉
const RENEW_MS = Math.max(1000, Math.round(TTL_MS / 3)); // 每 5 秒续一次

let lockFile = '';
let myId = '';
let leader = false;
let timer = null;
let onPromote = null;
let onDemote = null;
let startedAt = Date.now();

function instanceId() {
  if (myId) return myId;
  myId = process.env.PANEL_INSTANCE || `${os.hostname()}:${process.pid}:${process.env.PORT || 8090}`;
  return myId;
}

function read() {
  try {
    return JSON.parse(fs.readFileSync(lockFile, 'utf8'));
  } catch {
    return null;
  }
}

function writeLease() {
  const body = {
    id: instanceId(),
    pid: process.pid,
    host: os.hostname(),
    port: Number(process.env.PORT || 8090),
    at: Date.now(),
    ttlMs: TTL_MS,
    since: startedAt,
  };
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  const tmp = `${lockFile}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(body), { mode: 0o600 });
  fs.renameSync(tmp, lockFile); // 原子替换，避免读到写了一半的内容
  return body;
}

function expired(cur) {
  if (!cur || !cur.at) return true;
  const ttl = Number(cur.ttlMs || TTL_MS);
  return Date.now() - Number(cur.at) > ttl;
}

/** 尝试拿到领导权；成功返回 true */
function tryAcquire() {
  const cur = read();
  if (cur && cur.id !== instanceId() && !expired(cur)) {
    leader = false;
    return false;
  }
  writeLease();
  leader = true;
  return true;
}

function tick() {
  const cur = read();
  if (!cur || cur.id === instanceId()) {
    if (!leader) {
      // 自己本来就写着租约（比如刚 writeLease 后崩溃重启），直接接管
      leader = true;
      writeLease();
      if (onPromote) onPromote();
      return;
    }
    try { writeLease(); } catch { /* 磁盘抖动先忽略，下一轮再说 */ }
    return;
  }
  if (expired(cur)) {
    // 老实例不再续约 → 接管
    writeLease();
    leader = true;
    if (onPromote) onPromote();
  } else if (leader) {
    // 被别人抢走了（极端情况：两个实例几乎同时启动）
    leader = false;
    if (onDemote) onDemote();
  }
}

function init(file, opts = {}) {
  lockFile = file;
  if (opts.id) myId = opts.id;
  instanceId();
  startedAt = Date.now();
  onPromote = opts.onPromote || null;
  onDemote = opts.onDemote || null;
  const first = tryAcquire();
  if (timer) clearInterval(timer);
  timer = setInterval(tick, RENEW_MS);
  timer.unref?.();
  return first;
}

function isLeader() {
  return leader;
}

function status() {
  const cur = read();
  return {
    leader,
    id: instanceId(),
    ttlMs: TTL_MS,
    renewMs: RENEW_MS,
    holder: cur ? { id: cur.id, port: cur.port, at: cur.at } : null,
  };
}

/** 正常退出时立刻让出（滚动升级时新实例不用等 15 秒） */
function release() {
  if (timer) { clearInterval(timer); timer = null; }
  const cur = read();
  if (cur && cur.id === instanceId()) {
    try { fs.unlinkSync(lockFile); } catch { /* ignore */ }
  }
  leader = false;
}

module.exports = { init, tryAcquire, isLeader, status, release, instanceId };
