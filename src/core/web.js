'use strict';
/**
 * 页面外壳与静态资源（含 ETag / gzip）
 * 从 src/server.js 按职责拆出（v0.9.0），仅做搬运，行为不变。
 */

const http=require('http'); const https=require('https'); const crypto=require('crypto');
const zlib=require('zlib'); const net=require('net'); const fs=require('fs');
const path=require('path'); const os=require('os'); const { spawn }=require('child_process');
const QRCode=require('qrcode'); const bcrypt=require('bcryptjs');

const { PAGES, PAGE_DIR } = require('./paths');
const _state = require('./state');
const state = _state.stateProxy;
function readPage(file) {
  try {
    return fs.readFileSync(path.join(PAGE_DIR, file + '.html'), 'utf8');
  } catch {
    return `<div class="content"><div class="card"><div class="bd"><div class="hint err">页面 ${file} 缺失，请检查 src/web/pages/</div></div></div></div>`;
  }
}

// 整页外壳：左侧导航 + 顶部标题栏 + 页面主体
function pageShell(active, body) {
  const title = state.settings.panelTitle || 'Cloudflare 隧道面板';
  const nav = PAGES.map((pg) => {
    const on = pg.path === active ? ' active' : '';
    return `<a class="${on ? 'active' : ''}" href="${pg.path}"><span class="ico">${pg.ico}</span><span>${pg.title}</span></a>`;
  }).join('');
  const activePage = PAGES.find((x) => x.path === active) || PAGES[0];
  return `<!doctype html>
<html lang="zh-CN" data-theme="dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${activePage.title} · ${title}</title>
<link rel="stylesheet" href="/assets/app.css">
<link rel="icon" href="/badge.svg" type="image/svg+xml">
</head>
<body>
<a class="skip-link" href="#main">跳到主内容</a>
<div class="shell">
  <aside class="side" aria-label="侧边导航">
    <div class="brand"><span class="logo" aria-hidden="true">CF</span><div><div class="nm">${title}</div><div class="ver">v${VERSION}</div></div></div>
    <nav class="nav" aria-label="页面导航">${nav}</nav>
    <div class="side-foot">
      <div class="row"><span class="dot" id="healthDot" aria-hidden="true"></span><span class="muted" id="healthText" role="status">检测中…</span></div>
      <div class="row"><button class="sm ghost" id="btnTheme" title="切换深色 / 浅色" aria-label="切换深色或浅色主题">🌙</button>
      <button class="sm ghost" id="btnPalette" title="命令面板（Ctrl+K）" aria-label="打开命令面板">⌘K</button>
      <a class="sm ghost" href="/legacy" target="_blank" rel="noreferrer" title="旧版单页面">旧版</a></div>
      <div class="muted" style="font-size:11px">© <span id="year"></span> cf-tunnel-panel</div>
    </div>
  </aside>
  <main class="main" id="main">
${body}
  </main>
</div>
<script src="/assets/app.js"></script>
<script src="/assets/${activePage.file}.js"></script>
</body>
</html>`;
}

// 文本响应：带 ETag（命中 304）+ gzip，省流量也省得每次重传
function serveText(req, res, body, type, cache = 'no-cache') {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8');
  const etag = 'W/"' + buf.length.toString(16) + '-' + crypto.createHash('sha1').update(buf).digest('hex').slice(0, 12) + '"';
  const headers = { 'Content-Type': type, 'Cache-Control': cache, ETag: etag, Vary: 'Accept-Encoding', ...SEC_HEADERS };
  if (/^text\/html/.test(type)) {
    headers['Content-Security-Policy'] = "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'";
  }
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, headers);
    return res.end();
  }
  const ae = String(req.headers['accept-encoding'] || '');
  if (buf.length > 512 && /\bgzip\b/.test(ae) && /text|json|javascript|svg/.test(type)) {
    const gz = zlib.gzipSync(buf, { level: 6 });
    headers['Content-Encoding'] = 'gzip';
    headers['Content-Length'] = gz.length;
    res.writeHead(200, headers);
    return res.end(gz);
  }
  headers['Content-Length'] = buf.length;
  res.writeHead(200, headers);
  return res.end(buf);
}


const uiHtml = () => fs.readFileSync(UI_FILE, 'utf8');

const { UI_FILE, VERSION } = require('./paths');
const { SEC_HEADERS } = require('./util');

module.exports = { uiHtml, pageShell, readPage, serveText };
