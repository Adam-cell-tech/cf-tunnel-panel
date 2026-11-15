/* cf-tunnel-panel · 公共前端工具（所有页面共用） */
'use strict';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ---------------- HTTP ---------------- */
async function api(path, { method = 'GET', body, raw = false } = {}) {
  const opt = { method, headers: {} };
  if (body !== undefined) {
    opt.headers['Content-Type'] = 'application/json';
    opt.body = typeof body === 'string' ? body : JSON.stringify(body);
  }
  const r = await fetch(path, opt);
  if (raw) return r;
  const text = await r.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { ok: r.ok, raw: text }; }
  if (!r.ok || (data && data.ok === false)) {
    const msg = (data && data.error) || `HTTP ${r.status}`;
    if (r.status === 403 && /只读/.test(msg)) showReadonly(msg);
    throw new Error(msg);
  }
  return data;
}

const RO_KEY = 'cfp-readonly-notice';
function showReadonly(msg) {
  try { if (sessionStorage.getItem(RO_KEY)) return; sessionStorage.setItem(RO_KEY, '1'); } catch {}
  const bar = document.createElement('div');
  bar.className = 'hint warn robar';
  bar.setAttribute('role', 'status');
  bar.innerHTML = `<b>当前是只读账号</b>：能看所有页面，但改不了任何配置（${esc(msg)}）。要用管理员账号重新登录：<a href="/">点这里</a>`;
  document.body.prepend(bar);
  toast('只读账号不能修改配置', 'warn');
}

/* ---------------- Toast ---------------- */
function toast(msg, kind = '') {
  let box = $('#toast');
  if (!box) {
    box = document.createElement('div');
    box.id = 'toast';
    document.body.appendChild(box);
  }
  const el = document.createElement('div');
  el.className = 't ' + kind;
  el.textContent = msg;
  box.appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .2s'; }, 2600);
  setTimeout(() => el.remove(), 2900);
}

/* ---------------- Ctrl+K 命令面板 ---------------- */
const CMDS = [
  { t: '概览', s: '总览 状态 图表', h: '/' },
  { t: '隧道出口', s: 'tunnels 出口 cloudflared', h: '/tunnels' },
  { t: '代理规则', s: 'rules 规则 分流', h: '/rules' },
  { t: '工具箱', s: 'tools docker 分享 curl cloudflare', h: '/tools' },
  { t: '观测', s: 'observe 访问 日志 统计', h: '/observe' },
  { t: '设置', s: 'settings 维护 通知 备份 只读', h: '/settings' },
];

function paletteItems(extra) {
  const q = ($('#palQ') || {}).value;
  const kw = String(q || '').trim().toLowerCase();
  const all = CMDS.concat(extra || []);
  if (!kw) return all.slice(0, 12);
  return all.filter((x) => (x.t + ' ' + (x.s || '')).toLowerCase().includes(kw)).slice(0, 12);
}

function renderPalette(extra, active) {
  const items = paletteItems(extra);
  const box = $('#palList');
  box.innerHTML = items.map((it, i) => `<div class="pal-item${i === active ? ' on' : ''}" data-h="${esc(it.h)}" role="option" aria-selected="${i === active ? 'true' : 'false'}">
      <span class="ico">${it.h === '/tunnels' ? '🛰' : it.h === '/rules' ? '⑃' : it.h === '/tools' ? '🧰' : it.h === '/observe' ? '📈' : it.h === '/settings' ? '⚙️' : '▦'}</span>
      <span class="t">${esc(it.t)}</span><span class="s">${esc(it.s || '')}</span></div>`).join('')
    || '<div class="empty">没有匹配项</div>';
  return items;
}

async function openPalette() {
  if ($('#palWrap')) { $('#palWrap').remove(); return; }
  const wrap = document.createElement('div');
  wrap.id = 'palWrap';
  wrap.className = 'pal-wrap';
  wrap.innerHTML = `<div class="pal" role="dialog" aria-modal="true" aria-label="命令面板">
      <input id="palQ" placeholder="搜索页面、出口、规则…（↑↓ 选择，回车打开，Esc 关闭）" aria-label="命令面板搜索" />
      <div id="palList" role="listbox"></div></div>`;
  document.body.appendChild(wrap);
  $('#palQ').focus();
  let extra = [];
  let active = 0;
  try {
    const d = await loadState(true);
    extra = (d.state.tunnels || []).map((t) => ({ t: '出口：' + t.name, s: '隧道 ' + t.id, h: '/tunnels' }))
      .concat((d.state.routes || []).map((r) => ({ t: '规则：' + (r.name || r.path), s: (r.path || '') + ' → ' + (r.upstream || ''), h: '/rules' })));
  } catch {}
  renderPalette(extra, active);
  const go = (i) => {
    const items = paletteItems(extra);
    if (!items[i]) return;
    location.href = items[i].h;
  };
  $('#palQ').addEventListener('input', () => { active = 0; renderPalette(extra, active); });
  $('#palQ').addEventListener('keydown', (e) => {
    const items = paletteItems(extra);
    if (e.key === 'ArrowDown') { active = Math.min(items.length - 1, active + 1); renderPalette(extra, active); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { active = Math.max(0, active - 1); renderPalette(extra, active); e.preventDefault(); }
    else if (e.key === 'Enter') { go(active); e.preventDefault(); }
    else if (e.key === 'Escape') { wrap.remove(); }
  });
  wrap.addEventListener('click', (e) => {
    if (e.target === wrap) { wrap.remove(); return; }
    const it = e.target.closest('.pal-item');
    if (it) location.href = it.dataset.h;
  });
}

/* ---------------- 主题 ---------------- */
const THEME_KEY = 'cfp-theme';
function applyTheme(v) {
  if (v === 'light' || v === 'dark') document.documentElement.dataset.theme = v;
  const b = $('#btnTheme');
  if (b) b.textContent = document.documentElement.dataset.theme === 'light' ? '☀️' : '🌙';
}
function initTheme() {
  const saved = localStorage.getItem(THEME_KEY);
  if (saved) applyTheme(saved);
  else applyTheme(window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
  const pal = $('#btnPalette');
  if (pal) pal.addEventListener('click', () => openPalette());
  const b = $('#btnTheme');
  if (b) b.addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
    applyTheme(next);
    localStorage.setItem(THEME_KEY, next);
  });
  window.addEventListener('storage', (e) => { if (e.key === THEME_KEY) applyTheme(e.newValue); });
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); openPalette(); }
  });
}

/* ---------------- 时间 / 数字 ---------------- */
const pad2 = (n) => String(n).padStart(2, '0');
function fmtTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  if (isNaN(d)) return '';
  return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}
function fmtClock() {
  const d = new Date();
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}
function hm(ms) { return ms == null || ms === '' ? '' : ms + 'ms'; }

/* ---------------- 状态词 ---------------- */
const STATUS = {
  stopped: ['已停止', ''],
  starting: ['启动中', 'warn'],
  running: ['运行中', 'ok'],
  stopping: ['停止中', 'warn'],
  error: ['异常', 'err'],
};
function statusPill(st) {
  const [text, cls] = STATUS[st] || [st || '未知', ''];
  return `<span class="pill ${cls}"><span class="dot ${cls}"></span>${esc(text)}</span>`;
}

/* ---------------- 分页 ---------------- */
const PER_PAGE = 5;
const pageCount = (n) => Math.max(1, Math.ceil(n / PER_PAGE));
function pagerHtml(page, pages, total) {
  if (!total) return '';
  return `<div class="pager">
      <span class="muted">共 ${total} 条 · 第 ${page} / ${pages} 页</span>
      <button class="sm ghost" data-page="1" ${page <= 1 ? 'disabled' : ''}>« 首页</button>
      <button class="sm ghost" data-page="${page - 1}" ${page <= 1 ? 'disabled' : ''}>← 上一页</button>
      <button class="sm ghost" data-page="${page + 1}" ${page >= pages ? 'disabled' : ''}>下一页 →</button>
      <button class="sm ghost" data-page="${pages}" ${page >= pages ? 'disabled' : ''}>末页 »</button>
    </div>`;
}
function bindPager(box, onPage) {
  $$('[data-page]', box).forEach((b) => b.addEventListener('click', () => {
    const p = parseInt(b.dataset.page, 10);
    if (p >= 1) onPage(p);
  }));
}

/* ---------------- 剪贴板 ---------------- */
async function copyText(t) {
  try {
    await navigator.clipboard.writeText(t);
    toast('已复制到剪贴板', 'ok');
  } catch {
    const ta = document.createElement('textarea');
    ta.value = t;
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); toast('已复制到剪贴板', 'ok'); } catch { toast('复制失败，请手动选择', 'err'); }
    ta.remove();
  }
}

/* ---------------- 全局状态（每页各自拉，存在 window.ST） ---------------- */
window.ST = null;
let stateInflight = null;
async function loadState(force = false) {
  if (!force && window.ST) return window.ST;
  if (stateInflight) return stateInflight;
  stateInflight = api('/api/state').then((d) => {
    window.ST = d;
    stateInflight = null;
    return d;
  }).catch((e) => {
    stateInflight = null;
    throw e;
  });
  return stateInflight;
}
function rtOf(id, d = window.ST) {
  const list = (d && d.runtime && d.runtime.tunnels) || [];
  return list.find((x) => x.id === id) || { status: 'stopped', url: '' };
}
function tunnelUrl(t, d = window.ST) {
  const rt = rtOf(t.id, d) || {};
  return rt.publicUrl || rt.url || '';
}
function caddyOk(d = window.ST) { return !!(d && d.runtime && d.runtime.caddy && d.runtime.caddy.ok); }

/* ---------------- 日志流 ---------------- */
function openLogStream(onLine) {
  try {
    const es = new EventSource('/api/logs/stream');
    es.onmessage = (ev) => {
      try { onLine(JSON.parse(ev.data)); } catch { /* 忽略坏帧 */ }
    };
    return es;
  } catch { return null; }
}

/* ---------------- 顶部健康指示 ---------------- */
function paintHealth(d) {
  const list = (d.state && d.state.tunnels) || [];
  const running = list.filter((t) => rtOf(t.id, d).status === 'running').length;
  const box = $('#healthDot');
  const txt = $('#healthText');
  if (box) box.className = 'dot ' + (running ? 'ok' : 'err');
  if (txt) txt.textContent = running ? `${running}/${list.length} 出口在线` : '没有出口在线';
}

document.addEventListener('DOMContentLoaded', () => {
  initTheme();
  const y = $('#year');
  if (y) y.textContent = new Date().getFullYear();
  // 侧栏健康指示：每页都刷一次，失败静默
  loadState().then(paintHealth).catch(() => {});
  setInterval(() => { loadState(true).then(paintHealth).catch(() => {}); }, 15000);
});
