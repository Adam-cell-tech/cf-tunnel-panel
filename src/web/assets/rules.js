/* 代理规则页 */
'use strict';
(function () {

let ST = null;
let rules = [];
let selectedExit = localStorage.getItem('cfp-scope') || '';
let filterText = '';
let dirty = false;

const TEMPLATES = [
  { name: '静态网站（nginx:80）', path: '/site', upstream: 'http://127.0.0.1:8088', strip: true },
  { name: 'DSH / 任意 Web 后台', path: '/', upstream: 'http://127.0.0.1:3080', strip: false },
  { name: '演示服务 whoami', path: '/demo', upstream: 'http://127.0.0.1:8091', strip: true },
  { name: 'Adminer 数据库面板', path: '/db', upstream: 'http://127.0.0.1:8082', strip: true, sensitive: true },
  { name: 'phpMyAdmin', path: '/pma', upstream: 'http://127.0.0.1:8083', strip: true, sensitive: true },
  { name: 'pgAdmin', path: '/pg', upstream: 'http://127.0.0.1:5050', strip: true, sensitive: true },
  { name: '网页终端 ttyd', path: '/term', upstream: 'http://127.0.0.1:7682', strip: true, sensitive: true },
  { name: 'Grafana', path: '/grafana', upstream: 'http://127.0.0.1:3000', strip: true },
  { name: 'Uptime Kuma', path: '/status', upstream: 'http://127.0.0.1:3001', strip: true },
  { name: 'Portainer', path: '/portainer', upstream: 'http://127.0.0.1:9000', strip: true, sensitive: true },
  { name: 'Jellyfin', path: '/jellyfin', upstream: 'http://127.0.0.1:8096', strip: true, timeoutSec: 300 },
  { name: 'Nextcloud', path: '/nc', upstream: 'http://127.0.0.1:8085', strip: false, timeoutSec: 300 },
  { name: '宝塔面板', path: '/bt', upstream: 'http://127.0.0.1:8888', strip: true, sensitive: true },
  { name: 'MinIO 控制台', path: '/minio', upstream: 'http://127.0.0.1:9001', strip: true, sensitive: true },
];

const NEW_RULE = () => ({
  id: '', name: '', enabled: true, tunnelId: selectedExit || '', host: '', path: '', matchMethod: '',
  ipAllow: '', strip: true, upstream: '', backupUpstream: '', lbTryDuration: 0, lbPolicy: 'round_robin',
  headersReq: '', headersRes: '', timeoutSec: 0, basicAuth: { user: '', hash: '' }, note: '',
});

const scopeList = () => rules.filter((r) => (r.tunnelId || '') === selectedExit);

/** 上游 TCP 健康（服务端每 60s 探一次） */
function upHealth(url) {
  const list = (ST.runtime && ST.runtime.upstreams) || [];
  const t = String(url || '');
  if (!t) return null;
  return list.find((x) => t.startsWith(x.url)) || null;
}

function upDot(url) {
  const h = upHealth(url);
  if (!h) return '<span class="dot" title="还没探测" style="margin-left:6px"></span>';
  return `<span class="dot ${h.ok ? 'ok' : 'err'}" title="${h.ok ? 'TCP 通 · ' + h.ms + 'ms' : '不通：' + esc(h.error || '')}" style="margin-left:6px"></span>`;
}

function ruleHtml(r, i) {
  const scoped = !!r.tunnelId;
  const auth = r.basicAuth || {};
  return `<div class="rule" data-i="${i}">
    <div class="rule-h">
      <span class="idx">${i + 1}</span>
      <input data-k="name" value="${esc(r.name || '')}" placeholder="规则名字（可留空）" style="max-width:200px" />
      <span class="tag ${scoped ? 'acc' : ''}">${scoped ? '专属' : '全局'}</span>
      <span class="tag mono">${esc(r.path || '/')}</span>
      <span class="mono muted" style="font-size:11.5px">→ ${esc(r.upstream || '未填上游')}${upDot(r.upstream)}</span>
      <div class="right row">
        <button class="sm ghost" data-act="up" title="上移">↑</button>
        <button class="sm ghost" data-act="down" title="下移">↓</button>
        <button class="sm ghost" data-act="test" title="测上游连通性">测</button>
        <button class="sm ghost" data-act="exp" title="导出这条规则">导出</button>
        <button class="sm danger" data-act="del" title="删除">删</button>
      </div>
    </div>
    <div class="rule-b">
      <div class="form-grid">
        <div class="field"><label>路径前缀</label><input data-k="path" value="${esc(r.path || '')}" placeholder="/foo 或 /files/*" /></div>
        <div class="field"><label>上游</label><input data-k="upstream" value="${esc(r.upstream || '')}" placeholder="http://127.0.0.1:8080" /></div>
        <div class="field"><label>域名（可留空）</label><input data-k="host" value="${esc(r.host || '')}" placeholder="留空 = 任意域名" /></div>
        <div class="field"><label>作用域</label>
          <select data-k="tunnelId">
            <option value="" ${!r.tunnelId ? 'selected' : ''}>全局（所有出口）</option>
            ${(ST.state.tunnels || []).map((t) => `<option value="${esc(t.id)}" ${r.tunnelId === t.id ? 'selected' : ''}>出口：${esc(t.name)}</option>`).join('')}
          </select>
        </div>
      </div>
      <details>
        <summary>高级：认证 / IP 白名单 / 方法 / 超时 / 头 / 负载均衡</summary>
        <div class="form-grid" style="margin-top:10px">
          <div class="field"><label>基础认证用户名</label><input data-k="authUser" value="${esc(auth.user || '')}" placeholder="留空不开启" /></div>
          <div class="field"><label>基础认证密码 ${auth.hash ? '（已设置，留空不改）' : ''}</label><input data-k="authPass" type="password" placeholder="${auth.hash ? '••••••' : '设置密码'}" autocomplete="off" /></div>
          <div class="field"><label>来源 IP 白名单</label><input data-k="ipAllow" value="${esc(r.ipAllow || '')}" placeholder="192.168.1.0/24, 10.0.0.1" /></div>
          <div class="field"><label>方法限制</label><input data-k="matchMethod" value="${esc(r.matchMethod || '')}" placeholder="GET,POST（留空不限）" /></div>
          <div class="field"><label>超时（秒）</label><input data-k="timeoutSec" value="${esc(r.timeoutSec || 0)}" /></div>
          <div class="field"><label>备用上游</label><input data-k="backupUpstream" value="${esc(r.backupUpstream || '')}" placeholder="主上游挂了自动切这里" /></div>
          <div class="field"><label>负载均衡策略</label>
            <select data-k="lbPolicy">
              ${['round_robin', 'random', 'first', 'least_conn', 'ip_hash', 'uri_hash', 'header', 'cookie'].map((x) => `<option value="${x}" ${r.lbPolicy === x ? 'selected' : ''}>${x}</option>`).join('')}
            </select>
          </div>
          <div class="field"><label>重试时长（秒）</label><input data-k="lbTryDuration" value="${esc(r.lbTryDuration || 0)}" /></div>
        </div>
        <div class="form-grid" style="margin-top:10px">
          <div class="field"><label>请求头（每行 Name: Value）</label><textarea data-k="headersReq" placeholder="X-From-Panel: yes">${esc(r.headersReq || '')}</textarea></div>
          <div class="field"><label>响应头（每行 Name: Value）</label><textarea data-k="headersRes" placeholder="X-Robots-Tag: noindex">${esc(r.headersRes || '')}</textarea></div>
        </div>
        <div class="form-grid" style="margin-top:10px">
          <div class="field"><label>备注</label><input data-k="note" value="${esc(r.note || '')}" /></div>
          <div class="field"><label class="inline"><input class="chk" type="checkbox" data-k="strip" ${r.strip ? 'checked' : ''} /> 转发时去掉路径前缀</label></div>
          <div class="field"><label class="inline"><input class="chk" type="checkbox" data-k="enabled" ${r.enabled !== false ? 'checked' : ''} /> 启用这条规则</label></div>
        </div>
      </details>
      <div class="hint probe hidden"></div>
    </div>
  </div>`;
}

function matchFilter(r) {
  const q = filterText.trim().toLowerCase();
  if (!q) return true;
  const hay = [r.name, r.path, r.upstream, r.host, r.note, (r.backupUpstream || '')].join(' ').toLowerCase();
  return hay.includes(q);
}

function render() {
  const shown = [];
  let total = 0;
  rules.forEach((r, i) => {
    if ((r.tunnelId || '') !== selectedExit) return;
    total += 1;
    if (matchFilter(r)) shown.push(ruleHtml(r, i));
  });
  $('#ruleList').innerHTML = shown.length
    ? shown.join('')
    : (total
      ? `<div class="empty"><span class="big">🔍</span>没有匹配「${esc(filterText)}」的规则（共 ${total} 条）</div>`
      : `<div class="empty"><span class="big">⌘</span>这个作用域还没有规则${selectedExit ? '，新加的规则会绑定到这个出口' : ''}</div>`);
  const exit = (ST.state.tunnels || []).find((t) => t.id === selectedExit);
  $('#scopeTag').textContent = selectedExit ? `只看「${exit ? exit.name : selectedExit}」的专属规则` : '全局规则：对所有出口生效';
  renderWarns();
}

function renderWarns() {
  const scoped = scopeList();
  const out = [];
  const rootIdx = scoped.findIndex((r) => (r.path || '').replace(/\/+$/, '') === '');
  if (scoped.length && rootIdx < 0) {
    out.push(`<div class="hint warn">没有匹配 <span class="mono">/</span> 的规则 —— 访问首页会返回面板自定义的 404。
      <button class="sm ghost" data-warn="addroot">一键加一条 / 规则</button></div>`);
  }
  if (rootIdx >= 0 && rootIdx !== scoped.length - 1) {
    out.push(`<div class="hint warn">有一条 <span class="mono">/</span> 规则不在最后 —— 它会把后面所有规则拦掉。
      <button class="sm ghost" data-warn="moveend">把这条移到最后</button></div>`);
  }
  const shadowed = ((ST.runtime.caddy || {}).shadowed || []).filter((s) => {
    const r = rules[s.index];
    return r && (r.tunnelId || '') === selectedExit;
  });
  if (shadowed.length) {
    out.push(`<div class="hint err">${shadowed.length} 条规则被前面的规则挡住、永远不会生效：` +
      shadowed.map((s) => `<span class="mono">${esc(s.path)}</span>（${esc(s.reason)}）`).join('；') + '</div>');
  }
  const skipped = ((ST.runtime.caddy || {}).skipped || []).filter((s) => (s.tunnelId || '') === selectedExit);
  if (skipped.length) {
    out.push(`<div class="hint err">${skipped.length} 条规则没生效：` +
      skipped.map((s) => `${esc(s.name || s.path)}（${esc(s.reason)}）`).join('；') + '</div>');
  }
  $('#warns').innerHTML = out.join('');
}

function markDirty() {
  dirty = true;
  if (window.__cfpSetUnsaved) window.__cfpSetUnsaved('rules', true);
  $('#rulesDirty').classList.remove('hidden');
}

function collectRule(el, i) {
  const g = (k) => { const n = el.querySelector('[data-k="' + k + '"]'); return n ? n.value : ''; };
  const chk = (k) => { const n = el.querySelector('[data-k="' + k + '"]'); return n ? n.checked : false; };
  const r = rules[i] || NEW_RULE();
  const pass = g('authPass');
  return {
    ...r,
    name: g('name').trim(), path: g('path').trim(), upstream: g('upstream').trim(), host: g('host').trim(),
    tunnelId: g('tunnelId'), matchMethod: g('matchMethod').trim(), ipAllow: g('ipAllow').trim(),
    timeoutSec: Number(g('timeoutSec')) || 0, backupUpstream: g('backupUpstream').trim(),
    lbPolicy: g('lbPolicy'), lbTryDuration: Number(g('lbTryDuration')) || 0,
    headersReq: g('headersReq'), headersRes: g('headersRes'), note: g('note').trim(),
    strip: chk('strip'), enabled: chk('enabled'),
    basicAuth: { user: g('authUser').trim(), hash: (r.basicAuth && r.basicAuth.hash) || '', password: pass || undefined },
  };
}

function syncFromDom() {
  $$('#ruleList .rule').forEach((el) => {
    const i = parseInt(el.dataset.i, 10);
    if (!isNaN(i) && rules[i]) rules[i] = collectRule(el, i);
  });
}

async function save() {
  syncFromDom();
  try {
    $('#btnSave').disabled = true;
    const d = await api('/api/routes', { method: 'POST', body: { routes: rules } });
    rules = d.routes;
    dirty = false;
    if (window.__cfpSetUnsaved) window.__cfpSetUnsaved('rules', false);
    $('#rulesDirty').classList.add('hidden');
    toast(`已保存 ${rules.length} 条规则` + (d.caddy && d.caddy.ok ? '' : '（Caddy 下发失败，看日志）'), d.caddy && d.caddy.ok ? 'ok' : 'err');
    await refresh(true);
  } catch (e) {
    toast('保存失败：' + e.message, 'err');
  } finally {
    $('#btnSave').disabled = false;
  }
}

function fillScopes() {
  const sel = $('#scopeSel');
  sel.innerHTML = ['<option value="">全局规则</option>'].concat((ST.state.tunnels || []).map((t) =>
    `<option value="${esc(t.id)}">出口：${esc(t.name)}（${(ST.state.routes || []).filter((r) => r.tunnelId === t.id).length}）</option>`)).join('');
  if (![...sel.options].some((o) => o.value === selectedExit)) selectedExit = '';
  sel.value = selectedExit;
}

function isEditingRules() {
  const a = document.activeElement;
  return !!(a && a.closest && a.closest('#ruleList'));
}

async function refresh(force) {
  try {
    ST = await loadState(force);
    paintHealth(ST);
    // 有未保存改动、或者光标还在规则表单里 —— 绝对不能重画，否则正在输入的整条规则会被服务器旧值顶掉
    if (dirty || isEditingRules()) {
      renderWarns();
      return;
    }
    rules = (ST.state.routes || []).map((r) => ({ ...r }));
    fillScopes();
    render();
  } catch (e) {
    toast('读取失败：' + e.message, 'err');
  }
}

function addRule(tpl) {
  syncFromDom();
  const r = { ...NEW_RULE(), id: 'r' + Math.random().toString(36).slice(2, 8) };
  if (tpl) {
    Object.assign(r, { name: tpl.name, path: tpl.path, upstream: tpl.upstream, strip: tpl.strip !== false, timeoutSec: tpl.timeoutSec || 0 });
    if (tpl.sensitive) r.note = '这条会暴露数据库/终端，建议设置基础认证或来源 IP 白名单';
  }
  rules.push(r);
  markDirty();
  render();
  const el = $('#ruleList .rule[data-i="' + (rules.length - 1) + '"]');
  if (el) {
    if (el.scrollIntoView) el.scrollIntoView({ block: 'center' });
    const inp = el.querySelector('[data-k="path"]');
    if (inp) inp.focus();
  }
  if (tpl && tpl.sensitive) toast('已添加。这条会暴露敏感服务，记得填认证或 IP 白名单', 'ok');
}

document.addEventListener('DOMContentLoaded', () => {
  $('#scopeSel').addEventListener('change', (e) => {
    syncFromDom(); selectedExit = e.target.value;
    try { localStorage.setItem('cfp-scope', selectedExit); } catch {}
    render();
  });
  $('#ruleFilter').addEventListener('input', (e) => { filterText = e.target.value; render(); });

  $('#tplSel').innerHTML = '<option value="">从模板添加…</option>' +
    TEMPLATES.map((t, i) => `<option value="${i}">${esc(t.name)}</option>`).join('');
  $('#tplSel').addEventListener('change', (e) => {
    if (e.target.value === '') return;
    addRule(TEMPLATES[Number(e.target.value)]);
    e.target.value = '';
  });
  $('#btnAddRule').addEventListener('click', () => addRule(null));
  $('#btnSave').addEventListener('click', save);
  $('#ruleList').addEventListener('input', (e) => { if (e.target.closest('.rule')) markDirty(); });
  $('#ruleList').addEventListener('change', (e) => {
    const el = e.target.closest('.rule');
    if (!el) return;
    if (e.target.dataset.k === 'tunnelId') {
      const i = parseInt(el.dataset.i, 10);
      rules[i] = collectRule(el, i);
      markDirty();
      render();
      toast('作用域已改，记得保存', 'ok');
      return;
    }
    markDirty();
  });

  $('#ruleList').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const card = b.closest('.rule');
    const i = parseInt(card.dataset.i, 10);
    const action = b.dataset.act;
    if (action === 'del') {
      if (!confirm('删除这条规则？')) return;
      syncFromDom(); rules.splice(i, 1); markDirty(); render();
      return;
    }
    if (action === 'up' || action === 'down') {
      syncFromDom();
      const scoped = rules.map((r, idx) => ({ r, idx })).filter((x) => (x.r.tunnelId || '') === selectedExit);
      const pos = scoped.findIndex((x) => x.idx === i);
      const swap = action === 'up' ? scoped[pos - 1] : scoped[pos + 1];
      if (!swap) return;
      const tmp = rules[i]; rules[i] = rules[swap.idx]; rules[swap.idx] = tmp;
      markDirty(); render();
      return;
    }
    if (action === 'exp') {
      syncFromDom();
      const r = { ...rules[i], basicAuth: { user: (rules[i].basicAuth || {}).user || '', password: '' } };
      copyText(JSON.stringify(r, null, 2));
      return;
    }
    if (action === 'test') {
      syncFromDom();
      const hint = card.querySelector('.probe');
      hint.classList.remove('hidden');
      hint.className = 'hint probe';
      hint.textContent = '测试中…';
      try {
        const d = await api('/api/rules/test', { method: 'POST', body: { upstream: rules[i].upstream } });
        hint.className = 'hint probe ' + (d.ok ? 'ok' : 'err');
        hint.textContent = d.ok ? `上游可用：TCP ${d.tcpMs}ms，HTTP ${d.status}（${d.totalMs}ms）` : `连不上：${d.error || '未知错误'}`;
      } catch (err) {
        hint.className = 'hint probe err';
        hint.textContent = '测试失败：' + err.message;
      }
    }
  });

  // 只要动过规则表单就标脏：轮询立刻停手，保存成功才清
  const ruleList = $('#ruleList');
  if (ruleList) {
    ['input', 'change'].forEach((ev) => ruleList.addEventListener(ev, () => {
      if (!dirty) markDirty();
    }));
  }

  $('#warns').addEventListener('click', (e) => {
    const b = e.target.closest('[data-warn]');
    if (!b) return;
    syncFromDom();
    if (b.dataset.warn === 'addroot') {
      rules.push({ ...NEW_RULE(), id: 'r' + Math.random().toString(36).slice(2, 8), name: '默认站', path: '/', upstream: 'http://127.0.0.1:8091' });
    } else if (b.dataset.warn === 'moveend') {
      const idx = rules.findIndex((r) => (r.tunnelId || '') === selectedExit && (r.path || '').replace(/\/+$/, '') === '');
      if (idx < 0) return;
      rules.push(rules.splice(idx, 1)[0]);
    }
    markDirty(); render();
  });

  $('#btnImport').addEventListener('click', () => {
    const box = $('#importBox');
    box.classList.toggle('hidden');
    $('#btnImport').setAttribute('aria-expanded', box.classList.contains('hidden') ? 'false' : 'true');
    if (!box.classList.contains('hidden')) $('#importText').focus();
  });
  $('#btnCancelImport').addEventListener('click', () => {
    $('#importBox').classList.add('hidden');
    $('#importText').value = '';
    $('#btnImport').setAttribute('aria-expanded', 'false');
  });
  $('#btnDoImport').addEventListener('click', () => {
    const t = $('#importText').value.trim();
    if (!t) return;
    try {
      const o = JSON.parse(t);
      syncFromDom();
      rules.push({ ...NEW_RULE(), ...o, id: 'r' + Math.random().toString(36).slice(2, 8), tunnelId: o.tunnelId === undefined ? (selectedExit || '') : o.tunnelId });
      markDirty(); render();
      $('#importText').value = '';
      $('#importBox').classList.add('hidden');
      toast('已导入，记得保存', 'ok');
    } catch (e) { toast('JSON 解析失败：' + e.message, 'err'); }
  });

  $('#btnSim').addEventListener('click', () => { const c = $('#simCard'); if (c && c.scrollIntoView) c.scrollIntoView({ behavior: 'smooth', block: 'center' }); });
  $('#btnSimRun').addEventListener('click', async () => {
    syncFromDom();
    try {
      const d = await api('/api/match', { method: 'POST', body: { path: $('#simPath').value || '/', host: $('#simHost').value.trim(), method: $('#simMethod').value.trim() || 'GET' } });
      $('#simOut').innerHTML = d.matched
        ? `<div class="hint ok">命中第 ${d.index + 1} 条「${esc(d.matched.name || d.matched.path)}」 → <span class="mono">${esc(d.matched.upstream)}</span>${d.matched.strip ? '（会去掉前缀）' : ''}</div>`
        : `<div class="hint warn">${esc(d.note || '没有命中任何规则，会返回 404')}</div>`;
    } catch (e) {
      $('#simOut').innerHTML = `<div class="hint err">${esc(e.message)}</div>`;
    }
  });

  refresh();
  setInterval(() => refresh(false), 5000);
});

})();
