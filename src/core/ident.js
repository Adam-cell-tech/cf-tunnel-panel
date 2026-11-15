'use strict';
/**
 * 版本指纹：给 /healthz 用，能一眼看出「容器里跑的是镜像代码还是 docker cp 进去的代码」。
 * - code：运行时对 src/ 现算的指纹
 * - build：构建镜像时写进 /app/.code-hash 的指纹（没有 build 阶段就是 null）
 * - drift：两者都存在且不一致 = 代码是热替换进去的，和镜像不一致
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

let cached = null;

function codeHash() {
  try {
    return execFileSync(process.execPath, [path.join(__dirname, '..', '..', 'tools', 'codehash.js')], {
      encoding: 'utf8', timeout: 8000,
    }).trim();
  } catch {
    return '';
  }
}

function buildInfo(env = process.env) {
  if (cached) return { ...cached, sha: env.GIT_SHA || '' };
  let build = null;
  try {
    build = fs.readFileSync(path.join(__dirname, '..', '..', '.code-hash'), 'utf8').trim() || null;
  } catch { build = null; }
  const code = codeHash() || null;
  cached = { code, build, drift: !!(code && build && code !== build) };
  return { ...cached, sha: env.GIT_SHA || '' };
}

module.exports = { buildInfo, codeHash };
