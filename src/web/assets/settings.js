/* 设置页 */
'use strict';
(function () {

let ST = null;
let backups = [];
let page = 1;

function renderBackups() {
  const box = $('#backupList');
  const pages = pageCount(backups.length);
  if (page > pages) page = pages;
  const slice = backups.slice((page - 1) * PER_PAGE, page * PER_PAGE);
  if (!backups.length) { box.innerHTML = '<div class="empty">还没有备份</div>'; return; }
  const REASON = {
    routes: '改了代理规则', settings: '改了设置', restore: '回滚过配置', viewer: '改了只读账号',
    'share-expire': '清理过期分享', import: '导入了配置', maintenance: '切换维护模式',
    'panel-auth': '改了面板登录', tunnel: '改了隧道出口', tunnels: '改了隧道出口',
    create: '新建出口', delete: '删除出口', start: '启动出口', stop: '停止出口', save: '保存',
  };
  const when = (f) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})/.exec(f);
    if (!m) return esc(f);
    const d = new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}`);
    return `<span title="${esc(f)}">${d.toLocaleString('zh-CN', { hour12: false })}</span>`;
  };
  box.innerHTML = `<div class="tbl-wrap"><table class="stackable"><thead><tr><th>时间</th><th>为什么存了这一份</th><th></th></tr></thead><tbody>${slice.map((f) => {
    const m = /^(.+?)-([a-z-]+)\.json$/.exec(f) || [];
    const reason = m[2] || '';
    return `<tr><td class="mono" data-label="时间">${when(f)}</td><td data-label="原因"><span class="tag">${esc(REASON[reason] || reason || '保存')}</span></td>
      <td class="nowrap" data-label="操作"><button class="sm ghost" data-restore="${esc(f)}">回滚到这份</button>
        <button class="sm ghost" data-diff="${esc(f)}">对比当前</button></td></tr>`;
  }).join('')}</tbody></table></div>${pagerHtml(page, pages, backups.length)}`;
  bindPager(box, (p) => { page = p; renderBackups(); });
}

async function showDiff(file) {
  const box = $('#diffOut');
  box.innerHTML = '<div class="hint">对比中…</div>';
  try {
    const d = await api('/api/backups/diff?a=' + encodeURIComponent(file));
    const part = (title, arr, fn) => (arr.length
      ? `<div style="margin-top:6px"><b>${title}（${arr.length}）</b><ul class="list">${arr.map((x) => `<li>${fn(x)}</li>`).join('')}</ul></div>`
      : '');
    const body = part('新增规则', d.added, (x) => `+ <code>${esc(x.path || '/')}</code> ${esc(x.name || '')}`)
      + part('删除规则', d.removed, (x) => `− <code>${esc(x.path || '/')}</code> ${esc(x.name || '')}`)
      + part('修改规则', d.changed, (x) => `<code>${esc(x.path || '/')}</code> ${esc(x.name || '')} —— 改了 ${x.fields.map((f) => `<code>${esc(f)}</code>`).join('、')}`);
    box.innerHTML = body
      ? `<div class="hint"><b>${esc(d.against)}</b> 与本机当前配置对比（${d.backupRoutes} → ${d.currentRoutes} 条）${body}</div>`
      : `<div class="hint ok-hint"><b>${esc(d.against)}</b> 和当前配置完全一致（${d.currentRoutes} 条规则）</div>`;
  } catch (e) {
    box.innerHTML = `<div class="hint err">对比失败：${esc(e.message)}</div>`;
  }
}

async function loadBackups() {
  try {
    const d = await api('/api/backups');
    backups = d.files || [];
    page = 1;
    renderBackups();
  } catch (e) {
    $('#backupList').innerHTML = `<div class="hint err">${esc(e.message)}</div>`;
  }
}

const NOTIFY_STATUS = { ok: ['已发送', 'ok'], fail: ['发送失败', 'err'], skipped: ['被拦下', 'warn'], error: ['发送失败', 'err'] };

async function loadNotifyHist() {
  const box = $('#notifyHist');
  try {
    const d = await api('/api/notify/history');
    const items = d.items || [];
    box.innerHTML = items.length
      ? `<div class="tbl-wrap"><table class="stackable"><thead><tr><th>时间</th><th>事件</th><th>标题</th><th>结果</th><th>详情</th></tr></thead><tbody>${items.map((it) => {
        const st = NOTIFY_STATUS[it.status] || [it.status || '—', ''];
        return `<tr><td class="mono" data-label="时间">${new Date(it.t).toLocaleTimeString('zh-CN', { hour12: false })}</td>
          <td data-label="事件"><span class="mono">${esc(it.event)}</span></td>
          <td data-label="标题">${esc(it.title || '')}</td>
          <td data-label="结果"><span class="tag ${st[1]}">${esc(st[0])}</span></td>
          <td class="muted" data-label="详情">${esc(it.extra || '')}</td></tr>`;
      }).join('')}</tbody></table></div>`
      : '<div class="empty">还没有发过通知（配置 webhook 后，掉线/换域名会走这里）</div>';
  } catch (e) {
    box.innerHTML = `<div class="hint err">${esc(e.message)}</div>`;
  }
}

async function loadSystem() {
  const box = $('#sysInfo');
  try {
    const d = await api('/api/system');
    const kb = (n) => (n >= 1024 * 1024 ? (n / 1024 / 1024).toFixed(1) + ' MB' : Math.round(n / 1024) + ' KB');
    const dur = (s) => {
      s = Math.round(s);
      const d2 = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m2 = Math.floor((s % 3600) / 60);
      return d2 ? `${d2} 天 ${h} 小时` : h ? `${h} 小时 ${m2} 分` : `${m2} 分钟`;
    };
    box.innerHTML = `<table><tbody>
      <tr><td class="muted">面板版本</td><td class="mono">v${esc(d.version)}</td></tr>
      <tr><td class="muted">Node / 平台</td><td class="mono">${esc(d.node)} · ${esc(d.platform || '')}</td></tr>
      <tr><td class="muted">已运行</td><td>${dur(d.uptimeSec)}</td></tr>
      <tr><td class="muted">数据目录</td><td class="mono">${esc(d.dataDir)}</td></tr>
      <tr><td class="muted">state.json</td><td>${kb(d.stateBytes)}</td></tr>
      <tr><td class="muted">备份份数</td><td>${d.backupCount} 份（上限 20）</td></tr>
      <tr><td class="muted">面板日志缓存</td><td>${kb(d.logBytes)}</td></tr>
      <tr><td class="muted">Caddy 访问日志</td><td>${kb(d.caddyLogBytes)}（Caddy 侧 10MB × 3 份自动轮转）</td></tr>
      <tr><td class="muted">内存占用</td><td>${d.memMB} MB</td></tr>
      <tr><td class="muted">主机</td><td class="mono">${esc(d.host)}</td></tr>
    </tbody></table>`;
  } catch (e) {
    box.innerHTML = `<div class="hint err">${esc(e.message)}</div>`;
  }
}

function fill() {
  const s = ST.state.settings || {};
  $('#panelTitle').value = s.panelTitle || '';
  $('#caddyListen').value = s.caddyListen || ':8080';
  $('#notFoundBody').value = s.notFoundBody || '';
  const m = s.maintenance || {};
  $('#maintOn').checked = !!m.on;
  $('#maintBody').value = m.body || '';
  $('#maintRetry').value = m.retryAfter || 300;
  const sec = s.security || {};
  $('#ipDeny').value = sec.ipDeny || '';
  const rl = sec.rateLimit || {};
  $('#rlOn').checked = !!rl.enabled;
  $('#rlRps').value = rl.rps || 20;
  $('#rlBurst').value = rl.burst || 40;
  const n = s.notify || {};
  $('#notifyUrl').value = '';
  $('#notifyUrl').placeholder = n.hasUrl ? '已配置（留空不改）' : 'https://…';
  $('#notifyFormat').value = n.format || 'generic';
  $('#evDown').checked = !!(n.events && n.events.tunnelDown);
  $('#evUrl').checked = !!(n.events && n.events.urlChange);
  $('#evCaddy').checked = !!(n.events && n.events.caddyFail);
  $('#notifyCool').value = n.cooldownSec === undefined ? 300 : n.cooldownSec;
  $('#notifyQuiet').value = n.quietHours || '';
  $('#panelUser').value = (ST.state.panel && ST.state.panel.user) || '';
  $('#verTag').textContent = '版本 ' + (ST.version || '—');
}

async function save() {
  const body = {
    panelTitle: $('#panelTitle').value.trim(),
    caddyListen: $('#caddyListen').value.trim(),
    notFoundBody: $('#notFoundBody').value,
    maintenance: { on: $('#maintOn').checked, body: $('#maintBody').value, retryAfter: Number($('#maintRetry').value) || 300 },
    security: {
      ipDeny: $('#ipDeny').value.trim(),
      rateLimit: { enabled: $('#rlOn').checked, rps: Number($('#rlRps').value) || 20, burst: Number($('#rlBurst').value) || 40 },
    },
    notify: {
      url: $('#notifyUrl').value.trim(),
      format: $('#notifyFormat').value,
      events: { tunnelDown: $('#evDown').checked, urlChange: $('#evUrl').checked, caddyFail: $('#evCaddy').checked },
      cooldownSec: Number($('#notifyCool').value) || 0,
      quietHours: $('#notifyQuiet').value.trim(),
    },
  };
  try {
    await api('/api/settings', { method: 'POST', body });
    toast('设置已保存并下发', 'ok');
    const d = await loadState();
    ST = d;
    fill();
    loadBackups();
  } catch (e) {
    toast('保存失败：' + e.message, 'err');
  }
}

document.addEventListener('DOMContentLoaded', () => {
  $('#btnSave').addEventListener('click', save);
  $('#btnBackupRefresh').addEventListener('click', loadBackups);
  $('#backupList').addEventListener('click', async (e) => {
    const dbtn = e.target.closest('[data-diff]');
    if (dbtn) { showDiff(dbtn.dataset.diff); return; }
    const b = e.target.closest('[data-restore]');
    if (!b) return;
    if (!confirm('回滚到 ' + b.dataset.restore + ' ？当前配置会先自动备份一份。')) return;
    try {
      const d = await api('/api/backups/restore', { method: 'POST', body: { file: b.dataset.restore } });
      $('#diffOut').innerHTML = '';
      toast('已回滚，' + d.routeCount + ' 条规则' + (d.restarted.length ? '，重启出口：' + d.restarted.join('、') : ''), 'ok');
      ST = await loadState();
      fill();
      loadBackups();
    } catch (err) {
      toast('回滚失败：' + err.message, 'err');
    }
  });

  $('#btnNotifyClear').addEventListener('click', async () => {
    if (!confirm('清空通知 Webhook 地址？')) return;
    try {
      await api('/api/settings', { method: 'POST', body: { notify: { clearUrl: true } } });
      $('#notifyMsg').textContent = '已清空';
      ST = await loadState();
      fill();
    } catch (e) { $('#notifyMsg').textContent = e.message; }
  });

  $('#btnNotifyTest').addEventListener('click', async () => {
    $('#notifyMsg').textContent = '发送中…';
    try {
      const d = await api('/api/notify/test', { method: 'POST' });
      $('#notifyMsg').textContent = d.ok ? '已发送' : '失败（先填 Webhook 地址并保存）';
    } catch (e) {
      $('#notifyMsg').textContent = e.message;
    }
  });

  $('#btnPanelAuth').addEventListener('click', async () => {
    const user = $('#panelUser').value.trim();
    const pass = $('#panelPass').value;
    if (user && !pass) { $('#authMsg').textContent = '要设用户名就得一起填密码'; return; }
    try {
      const d = await api('/api/panel-auth', { method: 'POST', body: { user, pass } });
      $('#panelPass').value = '';
      $('#authMsg').textContent = d.authEnabled ? '已开启登录（刷新后浏览器会要密码）' : '已关闭登录';
      toast(d.authEnabled ? '已开启面板登录' : '已关闭面板登录', 'ok');
    } catch (e) {
      $('#authMsg').textContent = e.message;
    }
  });

  $('#btnViewer').addEventListener('click', async () => {
    const user = $('#viewerUser').value.trim();
    const pass = $('#viewerPass').value;
    try {
      const d = await api('/api/viewer', { method: 'POST', body: { user, pass } });
      $('#viewerPass').value = '';
      $('#viewerMsg').textContent = d.viewer.user ? `只读账号 ${d.viewer.user} 已生效` : '已关闭只读账号';
      toast(d.viewer.user ? '只读账号已保存' : '只读账号已关闭', 'ok');
      loadNotifyHist();
    } catch (e) {
      $('#viewerMsg').textContent = e.message;
    }
  });

  $('#btnNotifyHist').addEventListener('click', loadNotifyHist);
  $('#btnSysRefresh').addEventListener('click', loadSystem);

  $('#btnExport').addEventListener('click', () => { location.href = '/api/export'; });
  $('#btnExportFull').addEventListener('click', () => {
    if (!confirm('含 token 的完整配置，注意别外传。继续？')) return;
    location.href = '/api/export?full=1';
  });
  $('#btnImport').addEventListener('click', () => $('#fileImport').click());
  $('#fileImport').addEventListener('change', async (e) => {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    try {
      const text = await f.text();
      const obj = JSON.parse(text);
      if (!confirm('导入会覆盖当前配置（并自动备份一份），继续？')) return;
      const d = await api('/api/import', { method: 'POST', body: obj });
      toast('已导入，' + d.routeCount + ' 条规则', 'ok');
      ST = await loadState();
      fill();
      loadBackups();
    } catch (err) {
      toast('导入失败：' + err.message, 'err');
    } finally {
      e.target.value = '';
    }
  });

  loadState().then((d) => {
    ST = d; fill();
    const v = (d.state.settings || {}).viewer || {};
    $('#viewerUser').value = v.user || '';
    $('#viewerUser').placeholder = v.hasPass ? '当前只读账号：' + v.user : '不填 = 不开启只读账号';
  }).catch(() => {});
  loadBackups();
  loadNotifyHist();
  loadSystem();
});

})();
