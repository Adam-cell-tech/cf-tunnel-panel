/* 监控页：把 Prometheus 的 targets / 告警 聚合进来，并复用 Grafana 嵌入 */
(function () {
  let gKey = '';

  function badge(health) {
    const map = { up: ['正常', 'ok'], down: ['DOWN', 'err'], unknown: ['未知', 'warn'] };
    const [t, k] = map[health] || ['未知', 'warn'];
    return `<span class="tag ${k === 'ok' ? 'ok' : k === 'err' ? 'err' : 'warn'}">${t}</span>`;
  }

  function ago(iso) {
    if (!iso) return '—';
    const d = Date.parse(iso);
    if (!Number.isFinite(d)) return '—';
    const s = Math.max(0, Math.round((Date.now() - d) / 1000));
    if (s < 90) return s + ' 秒前';
    if (s < 5400) return Math.round(s / 60) + ' 分钟前';
    return Math.round(s / 3600) + ' 小时前';
  }

  function grafanaUrl(g, panel) {
    const dash = String(g.dashboard || '').split('/');
    if (!g.url || !dash[0]) return '';
    const q = new URLSearchParams({ orgId: '1', kiosk: '' });
    if (panel && panel.panelId) q.set('panelId', String(panel.panelId));
    if (g.theme) q.set('theme', g.theme);
    return `${String(g.url).replace(/\/+$/, '')}/d-solo/${encodeURIComponent(dash[0])}/${encodeURIComponent(dash[1] || dash[0])}?${q}`;
  }

  function paintGrafana(g) {
    const card = $('#monGrafanaCard');
    const body = $('#monGrafanaBody');
    if (!card || !body) return;
    const panels = (g && g.panels) || [];
    if (!g || !g.enabled || !g.url || !panels.length) { card.hidden = true; return; }
    card.hidden = false;
    const open = $('#btnMonOpen');
    if (open && g.url) { open.href = g.url; open.style.display = ''; }
    const mixed = location.protocol === 'https:' && /^http:\/\//i.test(g.url);
    const key = JSON.stringify([g.url, g.dashboard, g.theme, mixed, panels]);
    if (key === gKey) return;
    gKey = key;
    if (mixed) {
      body.innerHTML = '<div class="hint warn">Grafana 地址是 <span class="mono">http://</span>，而当前页面是 https —— 浏览器会按混合内容拦截。把 Grafana 也挂到 https 域名（或改用局域网地址访问面板）。</div>';
      return;
    }
    body.innerHTML = panels.map((p) => `
      <div class="field"><label>${esc(p.title || ('panel ' + p.panelId))}</label>
        <iframe class="chart" style="border:1px solid var(--line);border-radius:10px;width:100%;height:${Number(p.h) || 200}px"
          src="${esc(grafanaUrl(g, p))}" loading="lazy" referrerpolicy="no-referrer"></iframe></div>`).join('');
  }

  async function load() {
    const tb = $('#monTargetBody');
    const ab = $('#monAlertBody');
    try {
      const d = await api('/api/monitor/status');
      $('#monReady').textContent = d.ok ? (d.ready ? '就绪' : '未就绪') : '连不上';
      $('#monReady').className = 'v ' + (d.ok && d.ready ? 'ok-hint' : 'err-hint');
      $('#monPromUrl').textContent = d.promUrl || '';
      if (!d.ok) {
        tb.innerHTML = `<div class="hint warn">${esc(d.error || '查询失败')}</div>`;
        ab.innerHTML = '<div class="empty">—</div>';
        $('#monTargets').textContent = '—';
        $('#monAlerts').textContent = '—';
        return;
      }
      const s = d.summary || {};
      $('#monTargets').textContent = `${s.up}/${s.total} 正常`;
      $('#monTargets').className = 'v ' + (s.down ? 'err-hint' : 'ok-hint');
      const firing = (d.alerts || []).filter((a) => a.state === 'firing');
      $('#monAlerts').textContent = firing.length ? String(firing.length) : '0';
      $('#monAlerts').className = 'v ' + (firing.length ? 'err-hint' : 'ok-hint');

      tb.innerHTML = (d.targets || []).length
        ? `<div class="tbl-wrap"><table class="stackable"><thead><tr><th>任务</th><th>实例</th><th>状态</th><th>最近抓取</th><th>错误</th></tr></thead><tbody>${
          d.targets.map((t) => `<tr>
            <td class="mono" data-label="任务">${esc(t.job)}</td>
            <td class="mono muted" data-label="实例">${esc(t.scrapeUrl || t.instance)}</td>
            <td data-label="状态">${badge(t.health)}</td>
            <td class="mono" data-label="最近抓取">${esc(ago(t.lastScrape))}</td>
            <td class="mono muted" data-label="错误">${esc(t.lastError || '—')}</td>
          </tr>`).join('')}</tbody></table></div>`
        : '<div class="empty">没有抓取目标</div>';

      ab.innerHTML = (d.alerts || []).length
        ? `<div class="tbl-wrap"><table class="stackable"><thead><tr><th>告警</th><th>状态</th><th>级别</th><th>开始</th><th>说明</th></tr></thead><tbody>${
          d.alerts.map((a) => `<tr>
            <td data-label="告警"><b>${esc(a.name)}</b></td>
            <td data-label="状态"><span class="tag ${a.state === 'firing' ? 'err' : 'warn'}">${a.state === 'firing' ? '正在告警' : '待定'}</span></td>
            <td class="muted" data-label="级别">${esc(a.severity || '—')}</td>
            <td class="mono" data-label="开始">${esc(ago(a.activeAt))}</td>
            <td class="muted" data-label="说明">${esc(a.summary || '—')}</td>
          </tr>`).join('')}</tbody></table></div>`
        : '<div class="empty">当前没有告警 —— 这是好事</div>';
    } catch (e) {
      tb.innerHTML = `<div class="hint err">${esc(e.message)}</div>`;
    }
    const st = await loadState(true).catch(() => null);
    if (st) {
      paintGrafana(((st.state || {}).settings || {}).grafana);
      const role = st.role || 'admin';
      $('#monRole').textContent = (st.mode === 'standby' ? '备份（只读）' : '主实例') + ' · ' + role;
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    load().catch((e) => toast(e.message, 'err'));
    if ($('#btnMonRefresh')) $('#btnMonRefresh').addEventListener('click', () => load().catch((e) => toast(e.message, 'err')));
    setInterval(() => { if (!document.hidden) load().catch(() => {}); }, 30000);
  });
})();
