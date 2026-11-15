#!/usr/bin/env node
'use strict';
/**
 * 计算代码指纹：src/ 下所有文件 + package.json 的内容 SHA1（前 16 位）。
 * 构建镜像时写进 /app/.code-hash；运行时再算一次，两者不一致 = 容器里跑的不是镜像里的代码。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');

function walk(dir, out = []) {
  for (const name of fs.readdirSync(dir).sort()) {
    const full = path.join(dir, name);
    const st = fs.statSync(full);
    if (st.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

function codeHash() {
  const h = crypto.createHash('sha1');
  const files = [...walk(path.join(ROOT, 'src')), path.join(ROOT, 'package.json')];
  for (const f of files) {
    h.update(path.relative(ROOT, f).split(path.sep).join('/'));
    h.update('\0');
    h.update(fs.readFileSync(f));
    h.update('\0');
  }
  return h.digest('hex').slice(0, 16);
}

module.exports = { codeHash, ROOT };

if (require.main === module) process.stdout.write(codeHash());
