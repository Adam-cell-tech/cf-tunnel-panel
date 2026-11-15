/* 观测页：访问统计（可筛选/分页）+ 面板日志（可暂停/只看错误） */
'use strict';
(function () {

let rows = [];
let summary = null;
let page = 1;
let logEl = null;
let paused = false;
let auditRows = [];
let auditPage = 1;
let auditTotal = 0;
const AUDIT_PER_PAGE = 10;

function rangeSec() { return Number(($('#accRange') || {}).value || 0) || 0; }

function filteredRows() {
  const st = ($('#accStatus').value || '').trim();
  const q = ($('#accPath').value || '').trim().toLowerCase();
  const span = rangeSec();
  const since = span ? Date.now() - span * 1000 : 0;
  return rows.filter((r) => {
    if (since && r.ts) {
      const t = Date.parse(r.ts.replace(' ', 'T'));
      if (Number.isFinite(t) && t < since) return false;
    }
    if (st === 'err' && !(r.status >= 400)) return false;
    if (/^[2-5]$/.test(st) && Math.floor(Number(r.status) / 100) !== Number(st)) return false;
    if (q && !String(r.uri || '').toLowerCase().includes(q)) return false;
    return true;
  });
}

function renderAccess() {
  const box = $('#accessBody');
  const s = summary || {};
  const st = (k) => (s.byStatus && s.byStatus[k]) || 0;
  const list = filteredRows();
  const pages = pageCount(list.length);
  if (page > pages) page = pages;
  if (page < 1) page = 1;
  const slice = list.slice((page - 1) * PER_PAGE, page * PER_PAGE);
  const filtering = !!($('#accStatus').value || ($('#accPath').value || '').trim() || rangeSec());
  const body = slice.map((r) => `<tr>
      <td class="mono" data-label="时间">${esc((r.ts || '').slice(11, 19))}</td>
      <td class="mono" data-label="方法">${esc(r.method)}</td>
      <td class="mono" data-label="路径" title="${esc((r.host || '') + (r.ua ? ' · ' + r.ua : ''))}">${esc((r.uri || '').slice(0, 80))}</td>
      <td class="mono ${r.status >= 500 ? 'err-hint' : r.status >= 400 ? '' : 'ok-hint'}" data-label="状态">${r.status}</td>
      <td class="mono" data-label="耗时">${r.durMs}ms</td>
      <td class="mono muted" data-label="来源 IP">${esc(r.ip)}</td>
    </tr>`).join('');
  box.innerHTML = `
    <div class="row" style="padding:10px 12px;gap:8px;border-bottom:1px solid var(--line);flex-wrap:wrap">
      <span class="tag">最近 ${s.total || 0} 条</span>
      <span class="tag ok">2xx ${st('2xx')}</span>
      <span class="tag">3xx ${st('3xx')}</span>
      <span class="tag warn">4xx ${st('4xx')}</span>
      <span class="tag err">5xx ${st('5xx')}</span>
      ${filtering ? `<span class="tag info">筛选后 ${list.length} 条</span>` : ''}
      ${(s.topPaths || []).slice(0, 3).map((x) => `<span class="tag">${esc(x.k)} × ${x.v}</span>`).join('')}
    </div>
    <div class="tbl-wrap">
      <table class="stackable"><thead><tr><th>时间</th><th>方法</th><th>路径</th><th>状态</th><th>耗时</th><th>来源 IP</th></tr></thead>
      <tbody>${body || `<tr><td colspan="6" class="muted">${filtering ? '这组筛选条件下没有请求' : '这段时间还没有流量'}</td></tr>`}</tbody></table>
    </div>
    ${pagerHtml(page, pages, list.length)}`;
  bindPager(box, (p) => { page = p; renderAccess(); });
}

async function loadAccess() {
  try {
    const d = await api('/api/access?limit=200');
    if (!d.available) {
      $('#accessBody').innerHTML = `<div class="hint">${esc(d.note || '还没有访问日志（有流量后这里会自动出现）')}</div>`;
      return;
    }
    rows = d.rows || [];
    summary = d.summary || {};
    renderAccess();
    $('#accessMsg').textContent = '更新于 ' + fmtClock();
  } catch (e) {
    $('#accessBody').innerHTML = `<div class="hint err">读取失败：${esc(e.message)}</div>`;
  }
}

function logVisible(node) {
  const q = ($('#logFilter').value || '').trim().toLowerCase();
  const onlyErr = $('#logOnlyErr').checked;
  const text = node.textContent || '';
  if (q && !text.toLowerCase().includes(q)) return false;
  if (onlyErr && !/error|fail|失败|错误|异常|refused|timeout|超时|429|500|502|503/i.test(text)) return false;
  return true;
}

function appendLog(rec) {
  if (!logEl) return;
  if (paused) return;
  const span = document.createElement('span');
  span.className = 'l-' + (rec.source || 'panel');
  span.textContent = `${new Date(rec.t || rec.at).toLocaleTimeString('zh-CN', { hour12: false })} [${rec.source}] ${rec.line}\n`;
  if (!logVisible(span)) span.classList.add('hidden');
  logEl.appendChild(span);
  if (logEl.childNodes.length > 1500) logEl.removeChild(logEl.firstChild);
  logEl.scrollTop = logEl.scrollHeight;
}

function applyFilter() {
  for (const node of logEl.childNodes) {
    if (node.nodeType !== 1) continue;
    node.classList.toggle('hidden', !logVisible(node));
  }
}

function auditPill(ok, status) {
  const cls = ok ? 'ok' : 'err';
  return `<span class="pill ${cls}">${status || (ok ? '成功' : '失败')}</span>`;
}

function renderAudit() {
  const box = $('#auditBody');
  if (!box) return;
  if (!auditRows.length) { box.innerHTML = '<div class="empty">还没有审计记录（改一次配置或失败一次请求就会出现）</div>'; return; }
  const pages = Math.max(1, Math.ceil(auditTotal / AUDIT_PER_PAGE));
  if (auditPage > pages) auditPage = pages;
  const slice = auditRows.slice((auditPage - 1) * AUDIT_PER_PAGE, auditPage * AUDIT_PER_PAGE);
  box.innerHTML = `<div class="tbl-wrap"><table class="stackable">
    <thead><tr><th>时间</th><th>谁</th><th>从哪</th><th>做了什么</th><th>请求</th><th>结果</th></tr></thead>
    <tbody>${slice.map((r) => `<tr>
      <td data-label="时间">${fmtTime(r.at)}</td>
      <td data-label="谁">${esc(r.actor || '-')}${r.actor && r.actor.includes('只读') ? ' <span class="tag">只读</span>' : ''}</td>
      <td data-label="从哪"><span class="mono">${esc(r.ip || '-')}</span></td>
      <td data-label="做了什么">${esc(r.action || r.path || '-')}</td>
      <td data-label="请求"><span class="mono">${esc(r.method)} ${esc(r.path)}</span></td>
      <td data-label="结果">${auditPill(r.ok, r.status)}</td>
    </tr>`).join('')}</tbody></table></div>
    ${pagerHtml(auditPage, pages, auditTotal)}`;
  bindPager(box, (pg) => { auditPage = pg; renderAudit(); });
}

async function loadAudit() {
  const q = ($('#auditQ') || {}).value || '';
  const d = await api(`/api/audit?limit=200${q ? `&q=${encodeURIComponent(q)}` : ''}`);
  auditRows = d.rows || [];
  auditTotal = (d.stats && d.stats.count) || auditRows.length;
  renderAudit();
}

document.addEventListener('DOMContentLoaded', () => {
  logEl = $('#logBox');
  $('#btnAccessRefresh').addEventListener('click', loadAccess);
  $('#accessAuto').addEventListener('change', (e) => {
    if (e.target.checked) loadAccess();
  });
  for (const id of ['#accStatus', '#accRange']) {
    $(id).addEventListener('change', () => { page = 1; renderAccess(); });
  }
  $('#accPath').addEventListener('input', () => { page = 1; renderAccess(); });
  $('#logFilter').addEventListener('input', applyFilter);
  $('#logOnlyErr').addEventListener('change', applyFilter);
  $('#btnLogPause').addEventListener('click', (e) => {
    paused = !paused;
    e.target.textContent = paused ? '继续' : '暂停';
    e.target.setAttribute('aria-pressed', paused ? 'true' : 'false');
    e.target.classList.toggle('primary', paused);
    if (!paused) { logEl.scrollTop = logEl.scrollHeight; }
  });
  $('#btnLogDownload').addEventListener('click', () => { location.href = '/api/logs/download'; });

  loadAccess();
  loadAudit().catch(() => {});
  $('#btnAuditRefresh').addEventListener('click', () => loadAudit().catch((e) => toast(e.message)));
  let auditTimer = null;
  $('#auditQ').addEventListener('input', () => {
    clearTimeout(auditTimer);
    auditTimer = setTimeout(() => { auditPage = 1; loadAudit().catch(() => {}); }, 300);
  });
  openLogStream(appendLog);
  setInterval(() => {
    if (!$('#accessAuto').checked) return;
    if (document.hidden) return;                                  // 页面在后台就别刷了
    const a = document.activeElement;
    if (a && a.closest && a.closest('#accessBody')) return;        // 光标在表里（点分页/选文字）
    const sel = window.getSelection && window.getSelection();
    if (sel && String(sel).length) return;                         // 正在复制某行数据，别把它抢走
    loadAccess();
  }, 8000);
});

})();
