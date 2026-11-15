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

const NOTIFY_FMT = {
  generic: {
    label: 'Webhook 地址', ph: 'https://example.com/hook', secret: false,
    hint: '会 POST 一个 JSON：{title, text, event, ts, host}。任何能收 JSON 的服务都行（自建接收端、n8n、Node-RED…）。',
  },
  dingtalk: {
    label: '钉钉机器人 Webhook', ph: 'https://oapi.dingtalk.com/robot/send?access_token=…', secret: true,
    hint: '群 → 群设置 → 智能群助手 → 添加机器人 → 自定义。安全设置勾了「加签」就把 SEC 开头的密钥填到上面；只勾「自定义关键词」则留空密钥，但要保证关键词出现在「面板」「掉线」「失败」里任一个（消息标题会带上）。',
  },
  feishu: {
    label: '飞书机器人 Webhook', ph: 'https://open.feishu.cn/open-apis/bot/v2/hook/…', secret: true,
    hint: '群 → 设置 → 群机器人 → 添加 → 自定义机器人。开了「签名校验」就把密钥填到上面。',
  },
  bark: {
    label: 'Bark 推送地址', ph: 'https://api.day.app/你的Key', secret: false,
    hint: '在 Bark App 里复制推送地址，末尾不要带斜杠；面板会自动拼成 /标题/正文。自建服务器就填你的域名/Key。',
  },
};

function applyNotifyFmt() {
  const f = NOTIFY_FMT[$('#notifyFormat').value] || NOTIFY_FMT.generic;
  $('#notifyUrlLabel').textContent = f.label;
  const u = $('#notifyUrl');
  u.placeholder = S && S.settings.notify.hasUrl ? '已配置（留空不改）' : f.ph;
  $('#notifyHint').textContent = f.hint;
  $('#notifySecretWrap').classList.toggle('hidden', !f.secret);
  $('#notifySecret').placeholder = S && S.settings.notify.hasSecret ? '已配置（留空不改）' : (f.secret ? 'SEC 开头的密钥，留空不改' : '');
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
  if ($('#evSessionIp')) $('#evSessionIp').checked = !!(n.events && n.events.sessionIp);
  if ($('#evErrorSpike')) $('#evErrorSpike').checked = !!(n.events && n.events.errorSpike);
  if ($('#evLoginFail')) $('#evLoginFail').checked = !!(n.events && n.events.loginFail);
  $('#notifyCool').value = n.cooldownSec === undefined ? 300 : n.cooldownSec;
  $('#notifyQuiet').value = n.quietHours || '';
  $('#panelUser').value = (ST.state.panel && ST.state.panel.user) || '';
  $('#verTag').textContent = '版本 ' + (ST.version || '—');
  applyNotifyFmt();
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
      secret: $('#notifySecret').value.trim(),
      events: { tunnelDown: $('#evDown').checked, urlChange: $('#evUrl').checked, caddyFail: $('#evCaddy').checked, sessionIp: $('#evSessionIp') ? $('#evSessionIp').checked : true,
        errorSpike: $('#evErrorSpike') ? $('#evErrorSpike').checked : true,
        loginFail: $('#evLoginFail') ? $('#evLoginFail').checked : true },
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
    if (window.__cfpSetUnsaved) window.__cfpSetUnsaved('settings', false);
    loadBackups();
  } catch (e) {
    toast('保存失败：' + e.message, 'err');
  }
}


/* ---------------- 登录会话 ---------------- */
async function loadSessions() {
  const tb = document.querySelector('#sessTable tbody');
  if (!tb) return;
  try {
    const d = await api('/api/sessions');
    const rows = d.sessions || [];
    tb.innerHTML = rows.length ? rows.map((x) => `<tr>
        <td data-label="账号">${esc(x.user)}${x.current ? ' <span class="tag ok">当前</span>' : ''}</td>
        <td data-label="角色">${x.role === 'viewer' ? '只读' : '管理员'}</td>
        <td data-label="来源 IP"><span class="mono">${esc(x.ip || '-')}</span>${x.ipChangedAt ? ` <span class="tag err" title="原来是 ${esc(x.prevIp || '?')}，${fmtTime(x.ipChangedAt)} 变过来">换过 IP</span>` : ''}</td>
        <td data-label="设备"><span class="muted" style="font-size:12px">${esc(String(x.ua || '-').slice(0, 48))}</span></td>
        <td data-label="登录时间">${fmtTime(x.createdAt)}</td>
        <td data-label="最后活动">${fmtTime(x.lastSeenAt)}</td>
        <td data-label=""><button class="sm ghost" data-kick="${esc(x.id)}">踢掉</button></td>
      </tr>`).join('') : '<tr><td colspan="7" class="muted">没有活动中的会话（可能是用 Basic 认证或脚本访问）</td></tr>';
  } catch (e) {
    tb.innerHTML = `<tr><td colspan="7" class="hint err">${esc(e.message)}</td></tr>`;
  }
}

function bindSessions() {
  const tb = document.querySelector('#sessTable tbody');
  if (tb) tb.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-kick]');
    if (!b) return;
    if (!confirm('踢掉这个会话？那台设备需要重新登录。')) return;
    try {
      const d = await api('/api/sessions/revoke', { method: 'POST', body: { id: b.dataset.kick } });
      if (d.self) { location.href = '/login'; return; }
      toast('已踢掉');
      loadSessions();
    } catch (x) { toast(x.message, 'err'); }
  });
  const r = document.querySelector('#btnSessRefresh'); if (r) r.addEventListener('click', loadSessions);
  const all = document.querySelector('#btnSessRevokeAll');
  if (all) all.addEventListener('click', async () => {
    if (!confirm('退出全部设备？包括你现在这台，之后所有人都要重新登录。')) return;
    try { const d = await api('/api/sessions/revoke-all', { method: 'POST' }); toast(`已退出 ${d.revoked} 个会话，正在跳转登录…`); setTimeout(() => { location.href = '/login'; }, 700); }
    catch (x) { toast(x.message, 'err'); }
  });
  const k = document.querySelector('#btnSessKickOthers');
  if (k) k.addEventListener('click', async () => {
    if (!confirm('把除当前设备以外所有登录都踢掉？')) return;
    try { const d = await api('/api/sessions/revoke-others', { method: 'POST' }); toast(`已踢掉 ${d.revoked} 个会话`); loadSessions(); }
    catch (x) { toast(x.message, 'err'); }
  });
}

document.addEventListener('DOMContentLoaded', () => {
  // 设置页：任何输入都标记「未保存」，保存成功后清掉
  document.addEventListener('input', (e) => {
    if (e.target.closest && e.target.closest('#settingsForm, .card') && e.target.matches('input,select,textarea')) {
      if (window.__cfpSetUnsaved) window.__cfpSetUnsaved('settings', true);
    }
  });
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

  $('#notifyFormat').addEventListener('change', applyNotifyFmt);
  $('#btnSecretClear').addEventListener('click', async () => {
    try {
      await api('/api/settings', { method: 'POST', body: { notify: { clearSecret: true } } });
      toast('已清空加签密钥', 'ok');
      await loadState(true); fill();
    } catch (e) { toast(e.message, 'err'); }
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
      if (d.relogin) {
        $('#authMsg').textContent = '口令已更新，所有登录已失效，正在跳转登录页…';
        toast(`口令已更新，已踢掉 ${d.revoked} 个会话`, 'ok');
        setTimeout(() => { location.href = '/login'; }, 900);
        return;
      }
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
      $('#viewerMsg').textContent = d.viewer.user ? `只读账号 ${d.viewer.user} 已生效${d.relogin ? '（旧会话已全部失效）' : ''}` : '已关闭只读账号';
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
  bindSessions();
  loadSessions();
});

})();
