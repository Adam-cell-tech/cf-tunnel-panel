'use strict';
/**
 * 口令哈希：面板口令与只读口令都不再明文落盘。
 * 兼容旧数据：启动时把明文自动迁移成 bcrypt（见 state.migrateSecrets）。
 */
const bcrypt = require('bcryptjs');

const ROUNDS = 10;

/** 已经是 bcrypt 串？（$2a$ / $2b$ / $2y$） */
function isHash(v) {
  return /^\$2[aby]\$/.test(String(v || ''));
}

function hash(plain) {
  const s = String(plain || '');
  if (!s) return '';
  return bcrypt.hashSync(s, ROUNDS);
}

/** 校验：哈希走 compare，历史明文走等值（迁移期用） */
function verify(stored, plain) {
  const st = String(stored || '');
  if (!st) return false;
  const p = String(plain || '');
  if (isHash(st)) {
    try { return bcrypt.compareSync(p, st); } catch { return false; }
  }
  return st === p;
}

module.exports = { isHash, hash, verify, ROUNDS };
