'use strict';
/**
 * TOTP（RFC 6238）二次验证：只依赖 node:crypto，不引第三方库。
 *
 * 为什么自己写：面板只有一个依赖（bcryptjs + qrcode），为了一个 30 行的
 * HMAC 算法去引 otplib 不划算，而且自己写能加「时钟偏移窗口」和「恢复码」。
 */

const crypto = require('crypto');

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const DIGITS = 6;
const PERIOD = 30; // 秒

/** 生成 160 位（20 字节）随机密钥，base32 输出（Google Authenticator 认这个格式）。 */
function newSecret() {
  const buf = crypto.randomBytes(20);
  let bits = '';
  for (const b of buf) bits += b.toString(2).padStart(8, '0');
  let out = '';
  for (let i = 0; i + 5 <= bits.length; i += 5) out += B32[parseInt(bits.slice(i, i + 5), 2)];
  return out;
}

function base32Decode(s) {
  const clean = String(s || '').toUpperCase().replace(/[\s=-]/g, '');
  let bits = '';
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx < 0) continue;
    bits += idx.toString(2).padStart(5, '0');
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

/** HOTP：HMAC-SHA1 + 动态截断（RFC 4226）。 */
function hotp(secret, counter) {
  const key = base32Decode(secret);
  const buf = Buffer.alloc(8);
  buf.writeUInt32BE(Math.floor(counter / 2 ** 32) >>> 0, 0);
  buf.writeUInt32BE(counter >>> 0, 4);
  const mac = crypto.createHmac('sha1', key).update(buf).digest();
  const off = mac[mac.length - 1] & 0x0f;
  const code = ((mac[off] & 0x7f) << 24 | mac[off + 1] << 16 | mac[off + 2] << 8 | mac[off + 3]) % 10 ** DIGITS;
  return String(code).padStart(DIGITS, '0');
}

function totp(secret, at = Date.now()) {
  return hotp(secret, Math.floor(at / 1000 / PERIOD));
}

/** 校验：允许时钟偏移 ±window 个步长（默认各 1 步 = ±30 秒）。返回命中的偏移量，失败返回 null。 */
function verify(secret, code, { at = Date.now(), window = 1 } = {}) {
  const c = String(code || '').replace(/\D/g, '');
  if (c.length !== DIGITS) return null;
  const step = Math.floor(at / 1000 / PERIOD);
  for (let d = -window; d <= window; d++) {
    if (hotp(secret, step + d) === c) return d;
  }
  return null;
}

/** otpauth:// 链接（扫码用）。 */
function otpauthUrl({ secret, label = 'panel', issuer = 'cf-tunnel-panel' }) {
  const l = encodeURIComponent(`${issuer}:${label}`);
  const q = new URLSearchParams({ secret, issuer, algorithm: 'SHA1', digits: String(DIGITS), period: String(PERIOD) });
  return `otpauth://totp/${l}?${q.toString()}`;
}

/** 恢复码：`XXXX-XXXX`，只用无歧义字符。返回明文（只显示一次）与 sha256（存盘）。 */
function newRecovery(n = 10) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const plain = [];
  const hashed = [];
  for (let i = 0; i < n; i++) {
    let s = '';
    for (let k = 0; k < 8; k++) s += alphabet[crypto.randomInt(alphabet.length)];
    const code = `${s.slice(0, 4)}-${s.slice(4)}`;
    plain.push(code);
    hashed.push(hashRecovery(code));
  }
  return { plain, hashed };
}

function hashRecovery(code) {
  return crypto.createHash('sha256').update(String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '')).digest('hex');
}

module.exports = { newSecret, base32Decode, hotp, totp, verify, otpauthUrl, newRecovery, hashRecovery, DIGITS, PERIOD };
