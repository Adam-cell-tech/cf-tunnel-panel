/* 隧道出口页 */
'use strict';
(function () {


function fmtDur(sec) {
  const s2 = Math.max(0, Math.round(sec));
  const d = Math.floor(s2 / 86400);
  const h = Math.floor((s2 % 86400) / 3600);
  const m = Math.floor((s2 % 3600) / 60);
  if (d) return `${d} 天 ${h} 小时`;
  if (h) return `${h} 小时 ${m} 分`;
  if (m) return `${m} 分 ${s2 % 60} 秒`;
  return `${s2} 秒`;
}
let ST = null;
let openedOnce = {};

function exitCard(t, d) {
  const rt = rtOf(t.id, d);
  const url = rt.publicUrl || rt.url || '';
  const scoped = (d.state.routes || []).filter((r) => r.tunnelId === t.id).length;
  const isNamed = t.mode === 'named';
  const metricsWarn = t.metricsPort && (d.state.tunnels || []).some((x) => x.id !== t.id && String(x.metricsPort) === String(t.metricsPort))
    ? '<span class="tag warn">metrics 端口与其他出口冲突</span>' : '';
  const tokenWarn = isNamed && !t.hasToken ? '<span class="tag warn" title="命名隧道必须有 Cloudflare 给的 token">还没填 Token</span>' : '';
  const hostWarn = isNamed && !String(t.publicHostname || '').trim() ? '<span class="tag warn" title="命名隧道要有公网域名才能被访问">还没填公网域名</span>' : '';
  return `<div class="card" data-id="${esc(t.id)}">
    <div class="hd">
      <h2>${esc(t.name || t.id)}</h2>
      <span class="tag">${isNamed ? '命名隧道' : '快速隧道'}</span>
      <span data-live="pill">${statusPill(rt.status)}</span>
      <span class="tag">${scoped} 条专属规则</span>
      ${metricsWarn}
      ${tokenWarn}
      ${hostWarn}
      <div class="right">
        <button class="sm ghost" data-act="start">启动</button>
        <button class="sm ghost" data-act="stop">停止</button>
        <button class="sm ghost" data-act="restart">重启</button>
        <button class="sm ghost" data-act="qr">二维码</button>
        <button class="sm ghost" data-act="dup">复制</button>
        <button class="sm danger" data-act="del">删除</button>
      </div>
    </div>
    <div class="bd stack">
      <div class="row" data-live="url">${liveRow(t, d)}</div>
      <details ${openedOnce[t.id] ? 'open' : ''} data-edit>
        <summary>出口设置</summary>
        <div class="stack" style="margin-top:10px">
          <div class="form-grid">
            <div class="field"><label>名字</label><input data-k="name" value="${esc(t.name)}" /></div>
            <div class="field"><label>模式</label>
              <select data-k="mode">
                <option value="quick" ${t.mode !== 'named' ? 'selected' : ''}>快速隧道</option>
                <option value="named" ${t.mode === 'named' ? 'selected' : ''}>命名隧道</option>
              </select>
            </div>
            <div class="field"><label>上游地址</label><input data-k="origin" value="${esc(t.origin)}" /></div>
            <div class="field"><label>公网域名</label><input data-k="publicHostname" value="${esc(t.publicHostname || '')}" placeholder="dsh.example.com" />
              <div class="muted" style="margin-top:4px">必须和 Cloudflare → 隧道 → 公共主机名里填的那个域名一致（快速隧道可留空）</div></div>
          </div>
          <div class="form-grid">
            <div class="field"><label>Tunnel Token ${t.hasToken ? '（已保存，留空不改）' : ''}</label>
              <input data-k="token" type="password" placeholder="${t.hasToken ? '已配置，留空不改' : '粘贴 eyJ 开头的那一串（不是整条 docker 命令）'}" autocomplete="off" />
              <div class="muted" style="margin-top:4px">${t.tokenTunnelId
                ? `当前 token 属于隧道 <code class="mono">${esc(t.tokenTunnelId.slice(0, 8))}…${esc(t.tokenTunnelId.slice(-4))}</code>`
                : (t.hasToken
                  ? '<span style="color:var(--err)">已保存的 token 解析不了（像是整条命令或复制不全），请重新粘贴</span>'
                  : (isNamed ? '还没有 token：Cloudflare 该隧道页里复制 <code>--token</code> 后面那一串' : '快速隧道不需要 token'))}</div>
            </div>
            <div class="field"><label>协议</label>
              <select data-k="protocol">
                ${['auto', 'http2', 'quic'].map((x) => `<option value="${x}" ${t.protocol === x ? 'selected' : ''}>${x}</option>`).join('')}
              </select>
            </div>
            <div class="field"><label>日志级别</label>
              <select data-k="loglevel">
                ${['debug', 'info', 'warn', 'error'].map((x) => `<option value="${x}" ${t.loglevel === x ? 'selected' : ''}>${x}</option>`).join('')}
              </select>
            </div>
            <div class="field"><label>metrics 端口</label><input data-k="metricsPort" value="${esc(t.metricsPort || '')}" placeholder="留空不用" /></div>
            <div class="field"><label>额外参数</label><input data-k="extraArgs" value="${esc(t.extraArgs || '')}" placeholder="--edge-ip-version 4" /></div>
          </div>
          <div class="row">
            <button class="primary" data-act="save">保存并重启</button>
            <span class="muted" data-msg></span>
          </div>
        </div>
      </details>
    </div>
  </div>`;
}

function liveRow(t, d) {
  const rt = rtOf(t.id, d);
  const url = rt.publicUrl || rt.url || '';
  const errText = rt.fatal ? 'Token 无效 · 已停止自动重试' : (rt.lastError ? String(rt.lastError).slice(0, 70) : '');
  const tags = [
    errText ? `<span class="tag err" title="${esc(rt.lastError || '')}">${esc(errText)}</span>` : '',
    rt.pid ? `<span class="tag">pid ${rt.pid}</span>` : '',
    rt.uptimeSec ? `<span class="tag" title="本次运行时长">已运行 ${fmtDur(rt.uptimeSec)}</span>` : '',
    (!rt.fatal && rt.reconnects) ? `<span class="tag warn" title="启动后异常退出重连的次数">重连 ${rt.reconnects}</span>` : '',
  ].join('');
  return (url
    ? `<a class="mono" href="${esc(url)}" target="_blank" rel="noreferrer">${esc(url)}</a><button class="sm ghost" data-act="copy">复制</button>`
    : '<span class="muted">还没有公网地址（启动后会显示）</span>') + tags;
}

/** 只改状态/地址这些小片段，绝不重建卡片 —— 否则正在输入的出口设置会被 5 秒轮询清空。 */
function updateLive() {
  $$('#tunnelList > .card').forEach((card) => {
    const id = card.dataset.id;
    const t = (ST.state.tunnels || []).find((x) => x.id === id);
    if (!t) return;
    const rt = rtOf(id, ST);
    const pill = card.querySelector('[data-live="pill"]');
    if (pill) pill.innerHTML = statusPill(rt.status);
    const row = card.querySelector('[data-live="url"]');
    if (row) row.innerHTML = liveRow(t, ST);
  });
}

let renderedIds = '';

function render() {
  const box = $('#tunnelList');
  const list = (ST.state.tunnels || []);
  if (!list.length) {
    box.innerHTML = '<div class="card"><div class="empty"><span class="big">⇄</span>还没有隧道出口，点右上角「新建出口」</div></div>';
    return;
  }
  box.innerHTML = list.map((t) => exitCard(t, ST)).join('');
  renderedIds = list.map((t) => t.id).join(',');
  $$('#tunnelList [data-edit]').forEach((el) => el.addEventListener('toggle', () => {
    const id = el.closest('[data-id]').dataset.id;
    openedOnce[id] = el.open;
  }));
}

function collect(card) {
  const g = (k) => {
    const el = card.querySelector(`[data-k="${k}"]`);
    return el ? el.value.trim() : '';
  };
  const body = {
    name: g('name'), mode: g('mode'), origin: g('origin'), publicHostname: g('publicHostname'),
    protocol: g('protocol'), loglevel: g('loglevel'), metricsPort: g('metricsPort'), extraArgs: g('extraArgs'),
  };
  const tok = g('token');
  if (tok) body.token = tok;
  return body;
}

async function act(card, action) {
  const id = card.dataset.id;
  const t = (ST.state.tunnels || []).find((x) => x.id === id);
  const msg = card.querySelector('[data-msg]');
  try {
    if (action === 'save') {
      if (msg) msg.textContent = '保存中…';
      await api('/api/tunnels/' + id, { method: 'POST', body: collect(card) });
      toast('已保存并重启该出口', 'ok');
      if (window.__cfpSetUnsaved) window.__cfpSetUnsaved('tunnels', false);
      await refresh(true);
      return;
    }
    if (action === 'del') {
      if (!confirm(`删除出口「${t.name}」？\n它下面绑定的专属规则会失效（规则本身保留），云端隧道不会被删除。`)) return;
      await api(`/api/tunnels/${id}/delete`, { method: 'POST' });
      toast('已删除', 'ok');
      await refresh(true);
      return;
    }
    if (action === 'dup') {
      const body = { name: (t.name || '出口') + ' 副本', mode: t.mode, origin: t.origin, token: t.token || '', publicHostname: '', protocol: t.protocol, loglevel: t.loglevel, metricsPort: '', extraArgs: t.extraArgs };
      delete body.token;
      await api('/api/tunnels', { method: 'POST', body });
      toast('已复制为新出口（token 需要重新填）', 'ok');
      await refresh(true);
      return;
    }
    if (action === 'qr') {
      const url = rtOf(id, ST).publicUrl || rtOf(id, ST).url;
      if (!url) return toast('这个出口还没有公网地址', 'err');
      const d = await api('/api/qr?text=' + encodeURIComponent(url));
      const w = window.open('', '_blank');
      if (w) w.document.write(`<title>二维码</title><body style="margin:0;display:grid;place-items:center;height:100vh;background:#0b0f14"><div style="text-align:center;color:#e6edf3;font:14px sans-serif"><img src="${d.dataUrl}" style="width:320px;background:#fff;padding:12px;border-radius:12px"/><div style="margin-top:10px;word-break:break-all">${esc(url)}</div></div></body>`);
      return;
    }
    if (action === 'copy') {
      const r0 = rtOf(id, ST) || {};
      return copyText(r0.publicUrl || r0.url || '');
    }
    await api(`/api/tunnels/${id}/${action}`, { method: 'POST' });
    toast(action === 'start' ? '正在启动…' : action === 'stop' ? '正在停止…' : '正在重启…', 'ok');
    setTimeout(() => refresh(true), 1200);
  } catch (e) {
    toast('操作失败：' + e.message, 'err');
    if (msg) msg.textContent = e.message;
  }
}

async function refresh(force) {
  try {
    ST = await loadState(force);
    paintHealth(ST);
    $('#caddyListenHint').textContent = (ST.state.settings && ST.state.settings.caddyListen) || ':8080';
    const ids = (ST.state.tunnels || []).map((t) => t.id).join(',');
    // 出口集合没变就只改状态片段，绝不重建卡片 —— 否则正在输入的「出口设置」会被 5 秒轮询清空
    if (force || ids !== renderedIds) render();
    else updateLive();
  } catch (e) {
    toast('读取状态失败：' + e.message, 'err');
  }
}

document.addEventListener('DOMContentLoaded', () => {
  $('#btnStartAll').addEventListener('click', async () => {
    try { await api('/api/tunnels/start-all', { method: 'POST' }); toast('正在启动全部出口', 'ok'); setTimeout(() => refresh(true), 1500); }
    catch (e) { toast(e.message, 'err'); }
  });
  $('#btnStopAll').addEventListener('click', async () => {
    try { await api('/api/tunnels/stop-all', { method: 'POST' }); toast('正在停止全部出口', 'ok'); setTimeout(() => refresh(true), 1200); }
    catch (e) { toast(e.message, 'err'); }
  });
  $('#btnAdd').addEventListener('click', () => {
    const nc = $('#newCard');
    if (nc && nc.scrollIntoView) nc.scrollIntoView({ behavior: 'smooth', block: 'center' });
    $('#newName').focus();
  });
  // 出口卡片里任何输入都算「未保存」，保存成功后由 saveTunnel 清掉
  document.addEventListener('input', (e) => {
    if (e.target.closest && e.target.closest('#tunnelList, #newTunnel')) {
      if (window.__cfpSetUnsaved) window.__cfpSetUnsaved('tunnels', true);
    }
  });
  $('#newMode').addEventListener('change', (e) => {
    $('#newNamedBox').classList.toggle('hidden', e.target.value !== 'named');
  });
  $('#btnCreate').addEventListener('click', async () => {
    const mode = $('#newMode').value;
    const body = {
      name: $('#newName').value.trim() || '新出口',
      mode,
      origin: $('#newOrigin').value.trim() || 'http://127.0.0.1:8080',
    };
    if (mode === 'named') {
      body.token = $('#newToken').value.trim();
      body.publicHostname = $('#newHost').value.trim();
      if (!body.token) return toast('命名隧道需要填 Tunnel Token', 'err');
    }
    try {
      $('#newMsg').textContent = '创建中…';
      await api('/api/tunnels', { method: 'POST', body });
      $('#newMsg').textContent = '';
      $('#newName').value = ''; $('#newToken').value = ''; $('#newHost').value = '';
      toast('已创建，正在启动', 'ok');
      await refresh(true);
    } catch (e) {
      $('#newMsg').textContent = e.message;
      toast('创建失败：' + e.message, 'err');
    }
  });
  $('#tunnelList').addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const card = b.closest('[data-id]');
    act(card, b.dataset.act);
  });

  refresh();
  setInterval(() => refresh(false), 5000);
});
})();
