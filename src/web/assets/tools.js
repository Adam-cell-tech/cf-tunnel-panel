/* 工具箱页 */
'use strict';
(function () {

let ST = null;

async function loadDocker() {
  const box = $('#dockerBody');
  box.innerHTML = '<div class="empty">读取中…</div>';
  try {
    const d = await api('/api/docker/containers');
    if (!d.available) {
      box.innerHTML = `<div class="hint">读不到 Docker：${esc(d.note || '没有挂载 /var/run/docker.sock')}</div>`;
      return;
    }
    const rows = (d.containers || []).map((c) => `<tr>
        <td><span class="mono">${esc(c.name)}</span><div class="muted" style="font-size:11px">${esc(c.image)}</div></td>
        <td class="mono muted">${esc(c.ports || '—')}</td>
        <td class="mono">${esc(c.upstream || '—')}</td>
        <td class="nowrap">${c.upstream ? `<button class="sm ghost" data-dock="${esc(c.upstream)}">加规则</button>` : '<span class="muted">无可用端口</span>'}</td>
      </tr>`).join('');
    box.innerHTML = `<div class="tbl-wrap"><table><thead><tr><th>容器</th><th>端口</th><th>建议上游</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`;
  } catch (e) {
    box.innerHTML = `<div class="hint err">${esc(e.message)}</div>`;
  }
}

async function loadShares() {
  const box = $('#shareList');
  try {
    const d = await api('/api/shares');
    const list = d.shares || [];
    if (!list.length) { box.innerHTML = '<div class="empty">还没有分享链接</div>'; return; }
    box.innerHTML = list.map((s) => `<div class="row" style="justify-content:space-between;border-top:1px solid var(--line);padding:8px 0">
        <div class="grow">
          <div><strong>${esc(s.name)}</strong> <span class="tag">${esc(s.upstream)}</span></div>
          <div class="mono" style="font-size:11.5px;word-break:break-all">${esc(s.url)}</div>
          <div class="muted" style="font-size:11.5px">剩余 ${Math.round(s.leftSec / 60)} 分钟</div>
        </div>
        <div class="row">
          <button class="sm ghost" data-copy="${esc(s.url)}">复制</button>
          <button class="sm danger" data-del="${esc(s.id)}">删除</button>
        </div>
      </div>`).join('');
  } catch (e) {
    box.innerHTML = `<div class="hint err">${esc(e.message)}</div>`;
  }
}

async function loadCf() {
  const box = $('#cfList');
  $('#cfMsg').textContent = '';
  try {
    const d = await api('/api/cf/tunnels');
    const list = d.tunnels || [];
    box.innerHTML = list.length
      ? `<div class="tbl-wrap"><table><thead><tr><th>名字</th><th>状态</th><th>连接</th><th>ID</th><th>操作</th></tr></thead><tbody>${list.map((t) => `<tr>
          <td>${esc(t.name)}</td>
          <td>${t.status ? `<span class="tag ${t.status === 'healthy' ? 'ok' : t.status === 'down' ? 'err' : ''}">${esc(t.status)}</span>` : '—'}</td>
          <td>${t.connections ? `<span class="tag">${t.connections} 条</span>` : '<span class="muted">0（没跑 connector）</span>'}</td>
          <td class="mono muted" style="font-size:11px">${esc(t.id)}</td>
          <td><button class="mini" data-cfget="${esc(t.id)}">复制 token</button> <button class="mini" data-cfdel="${esc(t.id)}">删除</button></td></tr>`).join('')}</tbody></table></div>`
      : '<div class="empty">云端还没有隧道</div>';
    const sel = $('#cfDnsTunnel');
    if (sel) {
      const keep = sel.value;
      sel.innerHTML = '<option value="">最近创建的那条</option>' +
        list.map((t) => `<option value="${esc(t.id)}">${esc(t.name)}（${esc(String(t.id).slice(0, 8))}…）</option>`).join('');
      if ([...sel.options].some((o) => o.value === keep)) sel.value = keep;
    }
  } catch (e) {
    box.innerHTML = `<div class="hint warn">${esc(e.message)}</div>`;
  }
}

async function saveCf() {
  const body = { cf: { accountId: $('#cfAccount').value.trim(), zoneId: $('#cfZone').value.trim() } };
  const tk = $('#cfToken').value.trim();
  if (tk) body.cf.token = tk;
  try {
    await api('/api/settings', { method: 'POST', body });
    $('#cfToken').value = '';
    $('#cfMsg').textContent = '已保存';
    toast('Cloudflare API 配置已保存', 'ok');
  } catch (e) {
    $('#cfMsg').textContent = e.message;
    toast('保存失败：' + e.message, 'err');
  }
}

document.addEventListener('DOMContentLoaded', () => {
  $('#btnDockerRefresh').addEventListener('click', loadDocker);
  $('#dockerBody').addEventListener('click', (e) => {
    const b = e.target.closest('[data-dock]');
    if (!b) return;
    sessionStorage.setItem('cfp-prefill-upstream', b.dataset.dock);
    toast('已带上上游，去规则页点「＋ 添加规则」', 'ok');
    location.href = '/rules?prefill=' + encodeURIComponent(b.dataset.dock);
  });

  $('#btnShareAdd').addEventListener('click', async () => {
    try {
      $('#shareMsg').textContent = '生成中…';
      const d = await api('/api/shares', { method: 'POST', body: { name: $('#shareName').value.trim(), upstream: $('#shareUpstream').value.trim(), minutes: Number($('#shareMinutes').value) || 30 } });
      $('#shareMsg').textContent = '';
      copyText(d.share.url);
      loadShares();
    } catch (e) {
      $('#shareMsg').textContent = e.message;
      toast('生成失败：' + e.message, 'err');
    }
  });
  $('#shareList').addEventListener('click', async (e) => {
    const c = e.target.closest('[data-copy]');
    if (c) return copyText(c.dataset.copy);
    const d = e.target.closest('[data-del]');
    if (d) {
      if (!confirm('删除这条分享链接？')) return;
      try { await api('/api/shares/' + d.dataset.del + '/delete', { method: 'POST' }); loadShares(); }
      catch (err) { toast(err.message, 'err'); }
    }
  });

  $('#btnWsTest').addEventListener('click', async () => {
    const out = $('#wsOut');
    const msg = $('#wsMsg');
    msg.textContent = '握手中…';
    out.textContent = '';
    try {
      const d = await api('/api/ws-test', { method: 'POST', body: { path: $('#wsPath').value.trim() || '/', host: $('#wsHost').value.trim() } });
      out.textContent = JSON.stringify(d, null, 2);
      msg.textContent = d.ok ? `可以升级（101，${d.ms}ms）` : `不能升级：${d.error || ''}`;
      msg.className = d.ok ? 'muted ok-hint' : 'muted err';
    } catch (e) {
      msg.textContent = '失败：' + e.message;
      msg.className = 'muted err';
    }
  });

  $('#btnCurl').addEventListener('click', async () => {
    const out = $('#curlOut');
    out.textContent = '请求中…';
    try {
      const d = await api('/api/curl', { method: 'POST', body: { path: $('#curlPath').value || '/', host: $('#curlHost').value.trim() } });
      const head = Object.entries(d.headers || {}).map(([k, v]) => `${k}: ${v}`).join('\n');
      out.textContent = `HTTP ${d.status}   ${d.ms}ms   ${d.bytes} 字节\n${head}\n\n${d.preview || ''}`;
    } catch (e) {
      out.textContent = '失败：' + e.message;
    }
  });

  async function cfVerify() {
    const msg = $('#cfMsg');
    msg.textContent = '验证中…';
    try {
      const d = await api('/api/cf/verify');
      msg.textContent = d.token || '';
      const acc = $('#cfAccount'), zn = $('#cfZone');
      if (!acc.value && d.suggest && d.suggest.accountId) acc.value = d.suggest.accountId;
      if (!zn.value && d.suggest && d.suggest.zoneId) zn.value = d.suggest.zoneId;
      const list = [];
      if ((d.accounts || []).length > 1) {
        list.push('<div class="hint">这个 token 能看到 ' + d.accounts.length + ' 个账号：' + d.accounts.map((a) => esc(a.name) + ' <code class="mono">' + esc(a.id) + '</code>').join(' ｜ ') + '</div>');
      }
      if ((d.zones || []).length) {
        list.push('<div class="tbl-wrap"><table><thead><tr><th>域名</th><th>状态</th><th>Zone ID</th><th></th></tr></thead><tbody>' +
          d.zones.map((z) => `<tr><td>${esc(z.name)}</td><td>${esc(z.status)}</td><td class="mono">${esc(z.id)}</td>
            <td><button class="mini" data-cfzone="${esc(z.id)}">用这个</button></td></tr>`).join('') + '</tbody></table></div>');
      } else {
        list.push('<div class="hint">读不到域名列表（token 可能没有 Zone · Zone · Read 权限），可以手动把 Zone ID 粘进去。</div>');
      }
      $('#cfList').innerHTML = list.join('');
      loadCf();
    } catch (e) { msg.textContent = '验证失败：' + e.message; }
  }

  async function cfDns(create) {
    const msg = $('#cfMsg');
    try {
      if (create) {
        const name = ($('#cfDnsName').value || '').trim();
        if (!name) return toast('先填要绑定的域名', 'warn');
        const sel = $('#cfDnsTunnel');
        const tid = (sel && sel.value) || '';
        const content = tid ? `${tid.trim()}.cfargotunnel.com` : '';
        const d = await api('/api/cf/dns', { method: 'POST', body: { type: 'CNAME', name, content } });
        toast('已创建 CNAME ' + d.record.name, 'ok');
      }
      const q = ($('#cfDnsName').value || '').trim();
      const r = await api('/api/cf/dns' + (q ? '?name=' + encodeURIComponent(q) : ''));
      const rows = (r.records || []);
      $('#cfDnsList').innerHTML = rows.length
        ? '<div class="tbl-wrap"><table><thead><tr><th>类型</th><th>名字</th><th>内容</th><th>代理</th><th></th></tr></thead><tbody>' +
          rows.map((x) => `<tr><td>${esc(x.type)}</td><td>${esc(x.name)}</td><td class="mono">${esc(x.content)}</td><td>${x.proxied ? '是' : '否'}</td>
            <td><button class="mini" data-cfdnsdel="${esc(x.id)}">删除</button></td></tr>`).join('') + '</tbody></table></div>'
        : '<div class="hint">没有匹配的记录</div>';
    } catch (e) { msg.textContent = 'DNS 操作失败：' + e.message; }
  }

  $('#btnCfVerify').addEventListener('click', cfVerify);
  $('#btnCfDnsAdd').addEventListener('click', () => cfDns(true));
  $('#btnCfDnsList').addEventListener('click', () => cfDns(false));
  $('#cfList').addEventListener('click', async (e) => {
    const z = e.target.closest('[data-cfzone]');
    if (z) { $('#cfZone').value = z.dataset.cfzone; toast('已填入 Zone ID，记得点「保存 API 配置」'); return; }
    const got = e.target.closest('[data-cfget]');
    if (got) {
      try {
        const d = await api('/api/cf/tunnels/' + got.dataset.cfget + '/token', { method: 'POST' });
        await copyText(d.token);
        toast('已复制这条隧道的 token，粘到「隧道出口」新建出口即可');
      } catch (err) { toast(err.message, 'err'); }
      return;
    }
    const del = e.target.closest('[data-cfdnsdel]');
    if (del) {
      if (!confirm('删掉这条 DNS 记录？')) return;
      try { await api('/api/cf/dns/' + del.dataset.cfdnsdel + '/delete', { method: 'POST' }); cfDns(false); }
      catch (err) { toast(err.message, 'err'); }
    }
  });

  $('#btnCfSave').addEventListener('click', saveCf);
  $('#btnCfList').addEventListener('click', loadCf);
  $('#btnCfCreate').addEventListener('click', () => {
    const box = $('#newTunBox');
    box.classList.toggle('hidden');
    $('#btnCfCreate').setAttribute('aria-expanded', box.classList.contains('hidden') ? 'false' : 'true');
    if (!box.classList.contains('hidden')) $('#newTunName').focus();
  });
  $('#btnNewTunCancel').addEventListener('click', () => {
    $('#newTunBox').classList.add('hidden');
    $('#newTunName').value = ''; $('#newTunHost').value = ''; $('#newTunMsg').textContent = '';
    $('#btnCfCreate').setAttribute('aria-expanded', 'false');
  });
  $('#btnNewTunDo').addEventListener('click', async () => {
    const name = ($('#newTunName').value || '').trim();
    const host = ($('#newTunHost').value || '').trim();
    const wantCname = $('#newTunCname').checked;
    const wantLocal = $('#newTunLocal').checked;
    if (!name) { $('#newTunMsg').textContent = '先给隧道起个名字'; return; }
    try {
      $('#newTunMsg').textContent = '创建中…';
      const d = await api('/api/cf/tunnels', { method: 'POST', body: { name, hostname: wantCname ? host : '', addLocal: false } });
      $('#cfMsg').textContent = '已创建';
      toast('已创建云端隧道' + (host ? '并写好 CNAME' : ''), 'ok');
      loadCf();
      if (wantLocal && d.token) {
        const t = await api('/api/tunnels', { method: 'POST', body: { name, mode: 'named', origin: 'http://127.0.0.1:8080', token: d.token, publicHostname: host } });
        toast('已在本机加好出口「' + t.id + '」', 'ok');
      }
      $('#newTunBox').classList.add('hidden');
      $('#btnCfCreate').setAttribute('aria-expanded', 'false');
      $('#newTunName').value = ''; $('#newTunHost').value = ''; $('#newTunMsg').textContent = '';
      $('#cfMsg').textContent = '已创建';
      toast('已创建云端隧道' + (wantCname && host ? '并写好 CNAME' : ''), 'ok');
    } catch (e) {
      $('#newTunMsg').textContent = e.message;
      toast('创建失败：' + e.message, 'err');
    }
  });
  $('#cfList').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-cfdel]');
    if (!b) return;
    if (!confirm('删掉云端这条隧道？本地出口不会被删，但会失效。')) return;
    try { await api('/api/cf/tunnels/' + b.dataset.cfdel + '/delete', { method: 'POST' }); loadCf(); }
    catch (err) { toast(err.message, 'err'); }
  });

  $('#btnCaddyCfg').addEventListener('click', async () => {
    try {
      const r = await api('/api/caddy/config');
      const box = $('#caddyCfg');
      box.style.display = 'block';
      box.textContent = r.ok ? JSON.stringify(r.config, null, 2) : '生成失败：' + r.error;
      $('#caddyCfgMsg').textContent = r.ok ? '已生成当前配置' : '';
    } catch (e) { toast(e.message, 'err'); }
  });
  $('#btnCaddyCopy').addEventListener('click', () => {
    const t = $('#caddyCfg').textContent;
    if (!t) return toast('先点“生成并查看”', 'warn');
    copyText(t).then(() => toast('已复制'));
  });


/** ---------------- 测速 ---------------- */
function fmtMs(v) { return v == null ? '—' : (v < 10 ? v.toFixed(1) : String(Math.round(v))); }
function pick(arr, p) {
  if (!arr.length) return null;
  const a = arr.slice().sort((x, y) => x - y);
  const i = Math.min(a.length - 1, Math.max(0, Math.round((p / 100) * (a.length - 1))));
  return a[i];
}

async function benchPing(n = 10) {
  const out = [];
  let colo = '';
  for (let i = 0; i < n; i += 1) {
    const t0 = performance.now();
    const r = await fetch('/__bench/ping?t=' + Date.now() + Math.random(), { cache: 'no-store' });
    const d = await r.json();
    out.push(performance.now() - t0);
    if (d && d.colo) colo = d.colo;
  }
  return { samples: out, min: pick(out, 0), median: pick(out, 50), p95: pick(out, 95), colo };
}

async function benchDownload(mb) {
  const t0 = performance.now();
  const res = await fetch('/__bench/blob?mb=' + mb + '&t=' + Date.now(), { cache: 'no-store' });
  let firstByte = null;
  let bytes = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (firstByte == null) firstByte = performance.now() - t0;
    bytes += value ? value.length : 0;
  }
  const total = (performance.now() - t0) / 1000;
  return { mb: bytes / 1048576, sec: total, ttfbMs: firstByte, mbps: bytes / 1048576 / total };
}

function benchRow(label, value, note) {
  return `<tr><td>${esc(label)}</td><td class="mono">${value}</td><td class="muted">${esc(note || '')}</td></tr>`;
}

async function runBench() {
  const btn = $('#btnBenchAll');
  const mb = Number(($('#benchMb') || {}).value || 5);
  btn.disabled = true;
  try {
    $('#benchMsg').textContent = '测延迟…';
    const ping = await benchPing(10);
    $('#benchMsg').textContent = `测带宽（${mb} MB）…`;
    const dl = await benchDownload(mb);
    $('#benchMsg').textContent = '测本机 Caddy…';
    let local = null;
    try { const r = await api('/api/bench/local', { method: 'POST', body: { n: 5 } }); local = r.ttfbMs; } catch (e) { local = null; }
    const where = ping.colo
      ? `经 Cloudflare <b>${esc(ping.colo)}</b> 机房`
      : '本机 / 局域网直连（没看到 cf-ray，说明这条路径没经过 Cloudflare）';
    const verdict = dl.mbps >= 20 ? '这条链路很宽，大文件也能过'
      : dl.mbps >= 5 ? '够用：网页、后台、远程终端都顺'
        : dl.mbps >= 1 ? '能看网页，大文件会慢'
          : '带宽被回源上行卡住了（家宽上行典型值），别拿它传大文件';
    $('#benchOut').innerHTML = `
      <div class="hint">当前路径：${where}</div>
      <div class="tbl-wrap"><table>
        <thead><tr><th>项目</th><th>结果</th><th>说明</th></tr></thead>
        <tbody>
          ${benchRow('延迟（中位）', `${fmtMs(ping.median)} ms`, `最小 ${fmtMs(ping.min)} / p95 ${fmtMs(ping.p95)}，10 次小请求`)}
          ${local ? benchRow('本机 → Caddy 延迟', `${fmtMs(local.median)} ms`, '不经隧道、不经公网，纯回环') : ''}
          ${benchRow(`下载 ${dl.mb.toFixed(1)} MB`, `${dl.mbps.toFixed(2)} MB/s`, `${dl.sec.toFixed(2)} 秒，首字节 ${fmtMs(dl.ttfbMs)} ms`)}
          ${benchRow('估算速率', `${(dl.mbps * 8).toFixed(1)} Mbps`, verdict)}
        </tbody>
      </table></div>
      <div class="hint">想换个机房再测：把浏览器地址换成别的优选 IP（见文档「速度实测」一节）；测速数字受你当前网络影响，同一台机器测到的公网数会比自己从外网访问偏乐观一点。</div>`;
    $('#benchMsg').textContent = '完成';
  } catch (e) {
    $('#benchMsg').textContent = '测速失败：' + e.message;
  } finally {
    btn.disabled = false;
  }
}

  loadDocker();
  loadShares();
  loadState().then((d) => {
    ST = d;
    const cf = (d.state.settings && d.state.settings.cf) || {};
    $('#cfAccount').value = cf.accountId || '';
    $('#cfZone').value = cf.zoneId || '';
    $('#cfToken').placeholder = cf.hasToken ? '已保存（留空不改）' : '粘贴 Cloudflare API Token';
  }).catch(() => {});
  $('#btnBenchAll').addEventListener('click', runBench);
  setInterval(() => { if (!document.hidden) loadShares(); }, 20000);
});

})();
