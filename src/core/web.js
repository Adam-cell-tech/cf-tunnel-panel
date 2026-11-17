'use strict';
/**
 * 页面外壳与静态资源（含 ETag / gzip）
 * 从 src/server.js 按职责拆出（v0.9.0），仅做搬运，行为不变。
 */

  const crypto=require('crypto');
const zlib=require('zlib');  const fs=require('fs');
const path=require('path');

const { PAGES, PAGE_DIR } = require('./paths');
const i18n = require('./i18n');
const { buildInfo } = require('./ident');

// 资源指纹：代码一变，URL 就变 → 可以给 /assets/* 上「一年 immutable」长缓存
const ASSET_V = (() => { try { return (buildInfo().code || 'dev').slice(0, 8); } catch { return 'dev'; } })();
const AV = (f) => `/assets/${f}?v=${ASSET_V}`;
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
function pageShell(active, body, lang = 'zh') {
  // 备份实例的页面也要显示「另一个实例刚改过的」配置
  try { require('./state').maybeReloadState(1000); } catch {}
  const title = state.settings.panelTitle || 'Cloudflare 隧道面板';
  const nav = PAGES.map((pg) => {
    const on = pg.path === active ? ' active' : '';
    return `<a class="${on ? 'active' : ''}" href="${pg.path}"><span class="ico">${pg.ico}</span><span>${i18n.t(lang, pg.title)}</span></a>`;
  }).join('');
  const activePage = PAGES.find((x) => x.path === active) || PAGES[0];
  return `<!doctype html>
<html lang="${lang === 'en' ? 'en' : 'zh-CN'}" data-theme="dark">
<head>
<meta charset="utf-8">
<link rel="manifest" href="/assets/manifest.webmanifest" />
  <link rel="icon" href="/assets/icon.svg" type="image/svg+xml" />
  <meta name="theme-color" content="#1b7f5a" />
  <meta name="viewport" content="width=device-width, initial-scale=1">
<title>${i18n.t(lang, activePage.title)} · ${title}</title>
<link rel="stylesheet" href="${AV('app.css')}">
<link rel="icon" href="/badge.svg" type="image/svg+xml">
</head>
<body>
<a class="skip-link" href="#main">${i18n.t(lang, '跳到主内容')}</a>
<div class="shell">
  <aside class="side" aria-label="侧边导航">
    <div class="brand"><span class="logo" aria-hidden="true">CF</span><div><div class="nm">${title}</div><div class="ver">v${VERSION}</div></div></div>
    <nav class="nav" aria-label="页面导航">${nav}</nav>
    <div class="side-foot">
      <div class="row"><span class="dot" id="healthDot" aria-hidden="true"></span><span class="muted" id="healthText" role="status">${i18n.t(lang, '检测中…')}</span></div>
      <div class="row"><span class="tag warn hidden" id="unsaved" title="有改动还没保存">未保存</span>
      <span class="tag hidden" id="roleTag" aria-live="polite"></span>
      <button class="sm ghost" id="btnTheme" title="切换深色 / 浅色" aria-label="切换深色或浅色主题">🌙</button>
      <button class="sm ghost" id="btnPalette" title="命令面板（Ctrl+K）" aria-label="打开命令面板">⌘K</button>
      <button class="sm ghost" id="btnLang" title="${i18n.t(lang, '切换语言')}" aria-label="${i18n.t(lang, '切换语言')}">${lang === 'en' ? '中文' : 'EN'}</button>
      <button class="sm ghost" id="btnLogout" title="${i18n.t(lang, '退出登录')}" aria-label="${i18n.t(lang, '退出登录')}">${i18n.t(lang, '退出')}</button></div>
      <div class="muted" style="font-size:11px">© <span id="year"></span> cf-tunnel-panel</div>
    </div>
  </aside>
  <main class="main" id="main">
${body}
  </main>
</div>
<script src="/boot.js?v=${ASSET_V}"></script>
<script src="${AV('app.js')}"></script>
<script src="${AV(activePage.file + '.js')}"></script>
</body>
</html>`;
}

/** 独立登录页：不套外壳（没登录时不该看到导航），自带一点样式。 */
function loginPage({ next = '/', error = '', lang = 'zh' } = {}) {
  const title = (state.settings && state.settings.panelTitle) || 'Cloudflare 隧道面板';
  const safeNext = String(next || '/').startsWith('/') ? String(next || '/') : '/';
  return `<!doctype html>
<html lang="${lang === 'en' ? 'en' : 'zh-CN'}" data-theme="dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${i18n.t(lang, '登录')} · ${title}</title>
<link rel="stylesheet" href="${AV('app.css')}">
<link rel="icon" href="/badge.svg" type="image/svg+xml">
</head>
<body class="login-body">
<form class="login-card" id="loginForm" autocomplete="on" data-next="${safeNext}">
  <div class="brand" style="padding:0 0 14px"><span class="logo" aria-hidden="true">CF</span><div><div class="nm">${title}</div><div class="ver">v${VERSION}</div></div></div>
  <h1 style="font-size:18px;margin:0 0 12px">${i18n.t(lang, '登录面板')}</h1>
  <div class="field"><label for="u">${i18n.t(lang, '用户名')}</label><input id="u" name="username" autocomplete="username" required autofocus></div>
  <div class="field"><label for="p">${i18n.t(lang, '密码')}</label><input id="p" name="password" type="password" autocomplete="current-password" required></div>
  <div class="field hidden" id="tWrap"><label for="t">${i18n.t(lang, '二次验证码')}</label><input id="t" name="otp" inputmode="numeric" autocomplete="one-time-code" placeholder="123456" maxlength="9"><div class="muted" style="font-size:12px;margin-top:4px">${i18n.t(lang, '输入验证器 App 里的 6 位数字；也可以用恢复码（XXXX-XXXX）')}</div></div>
  <label class="chk" style="margin:2px 0 8px;font-size:13px"><input type="checkbox" id="rem" checked> ${i18n.t(lang, '记住这台设备（30 天）')}</label>
  <div class="hint err hidden" id="err">${error ? error : ''}</div>
  <button class="primary" type="submit" style="width:100%;margin-top:10px">${i18n.t(lang, '登录')}</button>
  <p class="muted" style="font-size:12px;margin:12px 0 0">登录后 7 天内免登录；在「设置 → 登录会话」里可以查看并踢掉其它设备。</p>
</form>
<script src="/boot.js?v=${ASSET_V}"></script>
<script src="${AV('login.js')}"></script>
</body>
</html>`;
}

// 文本响应：带 ETag（命中 304）+ gzip，省流量也省得每次重传
// extra 用来加 CDN 侧的头（例如 Cloudflare-CDN-Cache-Control：让边缘缓存更久，浏览器只缓存 5 分钟）
function serveText(req, res, body, type, cache = 'no-cache', extra = {}) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8');
  const ae0 = String(req.headers['accept-encoding'] || '');
  const canGz = buf.length > 512 && /\bgzip\b/.test(ae0) && /text|json|javascript|svg/.test(type);
  // ETag 必须区分「压缩版 / 原版」：同一个 URL 两种编码若共用一个 ETag，
  // 中间缓存可能把 gzip 的字节当原文发给不支持 gzip 的客户端。
  const etag = 'W/"' + buf.length.toString(16) + '-' + crypto.createHash('sha1').update(buf).digest('hex').slice(0, 12) + (canGz ? '-gz' : '-id') + '"';
  const headers = Object.assign({ 'Content-Type': type, 'Cache-Control': cache, ETag: etag, Vary: 'Accept-Encoding' }, SEC_HEADERS, extra);
  if (/^text\/html/.test(type)) {
    // frame-src 只放行「设置里填的那个 Grafana 源」：不写死 *，也不允许任意站点被嵌进来
    let frameSrc = "'self'";
    try {
      const g = (state.settings || {}).grafana || {};
      if (g.enabled && g.url) {
        const u = new URL(g.url);
        frameSrc += ` ${u.protocol}//${u.host}`;
      }
    } catch { /* 配置坏了就退化成只允许 self */ }
    headers['Content-Security-Policy'] = `default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-src ${frameSrc}; base-uri 'none'; form-action 'self'`;
  }
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, headers);
    return res.end();
  }
  if (canGz) {
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


const { VERSION } = require('./paths');
const { SEC_HEADERS } = require('./util');

module.exports = { pageShell, readPage, serveText, loginPage };
