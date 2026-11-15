'use strict';
/**
 * 测速端点（ping / blob / 本机回环）
 * 从 src/server.js 按职责拆出（v0.9.0），仅做搬运，行为不变。
 */

const http=require('http'); const https=require('https'); const crypto=require('crypto');
const zlib=require('zlib'); const net=require('net'); const fs=require('fs');
const path=require('path'); const os=require('os'); const { spawn }=require('child_process');
const QRCode=require('qrcode'); const bcrypt=require('bcryptjs');

const BENCH_MAX_MB = 32;

/** 从 CF-Ray 头里取边缘机房代码（如 `8f2a...-AMS` → AMS），本机直连时为空。 */
function coloOf(req) {
  const m = String(req.headers['cf-ray'] || '').match(/-([A-Z]{3})$/i);
  return m ? m[1].toUpperCase() : '';
}

/** 生成 N MB 零字节流：浏览器在「当前页面同源」下载它，量出来的就是真实端到端带宽。 */
function sendBenchBlob(req, res, url) {
  const mb = Math.min(BENCH_MAX_MB, Math.max(1, Number(url.searchParams.get('mb')) || 5));
  const total = mb * 1024 * 1024;
  res.writeHead(200, {
    'Content-Type': 'application/octet-stream',
    'Content-Length': String(total),
    'Cache-Control': 'no-store, no-cache, must-revalidate',
    'X-Bench-Bytes': String(total),
  });
  const chunk = Buffer.alloc(128 * 1024, 0);
  let sent = 0;
  const pump = () => {
    while (sent < total) {
      const n = Math.min(chunk.length, total - sent);
      sent += n;
      if (!res.write(n === chunk.length ? chunk : chunk.subarray(0, n))) {
        res.once('drain', pump);
        return;
      }
    }
    res.end();
  };
  pump();
}

/** 本机 → Caddy 的回环延迟（不经隧道），给公网延迟做对照。 */
function benchLocalOnce(port) {
  return new Promise((resolve) => {
    const t0 = process.hrtime.bigint();
    const req = http.request({ host: '127.0.0.1', port, path: '/', method: 'GET', headers: { Host: 'localhost' } }, (res) => {
      const ttfb = Number(process.hrtime.bigint() - t0) / 1e6;
      res.resume();
      res.on('end', () => resolve({ ok: true, ttfbMs: Math.round(ttfb), totalMs: Math.round(Number(process.hrtime.bigint() - t0) / 1e6), status: res.statusCode }));
    });
    req.setTimeout(4000, () => { req.destroy(); resolve({ ok: false, error: 'timeout' }); });
    req.on('error', (e) => resolve({ ok: false, error: e.message }));
    req.end();
  });
}


module.exports = { BENCH_MAX_MB, benchLocalOnce, coloOf, sendBenchBlob };
