/* 概览页 */
'use strict';

let logEl;
let logCount = 0;

function paintExits(d) {
  const box = $('#exitMini');
  const list = (d.state.tunnels || []);
  if (!list.length) { box.innerHTML = '<div class="empty">还没有隧道出口</div>'; return; }
  box.innerHTML = list.map((t) => {
    const rt = rtOf(t.id, d);
    const url = rt.publicUrl || rt.url || '';
    return `<div class="exit">
      <div class="grow">
        <div class="nm">${esc(t.name)} <span class="tag">${t.mode === 'named' ? '命名' : '快速'}</span>${statusPill(rt.status)}</div>
        ${url ? `<div class="url mono">${esc(url)}</div>` : '<div class="meta">还没有公网地址</div>'}
      </div>
    </div>`;
  }).join('');
}

function paintRules(d) {
  const box = $('#ruleMini');
  const list = d.state.routes || [];
  if (!list.length) { box.innerHTML = '<div class="empty">还没有规则，所有请求都会 404</div>'; return; }
  const rows = list.slice(0, 6).map((r) => `<tr>
      <td class="mono">${esc(r.path || '/')}</td>
      <td class="mono muted">${esc(r.upstream || '')}</td>
      <td class="nowrap">${r.tunnelId ? `<span class="tag acc">专属</span>` : '<span class="tag">全局</span>'}</td>
    </tr>`).join('');
  const c = d.runtime.caddy || {};
  const shadowed = c.shadowed || [];
  const dead = (d.runtime.upstreams || []).filter((u) => !u.ok);
  let hint = '';
  if (shadowed.length) {
    hint += `<div class="hint err">${shadowed.length} 条规则被前面的规则挡住、不会生效：` +
      shadowed.map((s) => `<span class="mono">${esc(s.path)}</span>`).join('、') + '</div>';
  }
  if (dead.length) {
    hint += `<div class="hint warn">${dead.length} 个上游端口不通：` +
      dead.map((u) => `<span class="mono">${esc(u.url)}</span>（${esc(u.error || '')}）`).join('、') + '</div>';
  }
  box.innerHTML = hint + `<table><thead><tr><th>路径</th><th>上游</th><th>作用域</th></tr></thead><tbody>${rows}</tbody></table>`;
}

async function paintStats(d) {
  const list = d.state.tunnels || [];
  const running = list.filter((t) => rtOf(t.id, d).status === 'running').length;
  $('#statExits').innerHTML = `${running}<small> / ${list.length}</small>`;
  $('#statExitsX').textContent = running ? '有出口在线' : '当前没有出口在线';

  const routes = d.state.routes || [];
  $('#statRules').textContent = (d.runtime.caddy && d.runtime.caddy.routeCount) || 0;
  $('#statRulesX').textContent = `配置里 ${routes.length} 条，${routes.filter((r) => r.tunnelId).length} 条专属`;

  const ok = caddyOk(d);
  const c = (d.runtime.caddy) || {};
  $('#statCaddy').innerHTML = ok ? '<span class="ok-hint">正常</span>' : '<span class="err-hint">异常</span>';
  $('#statCaddyX').textContent = ok ? `监听 ${c.listen || ''}` : (c.error || '下发失败');

  try {
    const a = await api('/api/access?limit=200');
    if (a.available) {
      const s = a.summary || {};
      $('#statReq').textContent = s.total || 0;
      const bs = s.byStatus || {};
      $('#statReqX').textContent = `2xx ${bs['2xx'] || 0} · 4xx ${bs['4xx'] || 0} · 5xx ${bs['5xx'] || 0}`;
    } else {
      $('#statReq').textContent = '0';
      $('#statReqX').textContent = '还没有访问日志';
    }
  } catch {
    $('#statReq').textContent = '–';
    $('#statReqX').textContent = '读取失败';
  }
}

// 极简 SVG 图：柱状（总量 + 错误叠加）与折线（在线出口数），不引第三方库
// ---------------------------------------------------------------- 图表工具
// Caddy/浏览器都不会给 SVG 里的 <text> 做等比缩放，之前用 preserveAspectRatio="none"
// 把整张图横向拉伸，刻度字被拉扁且贴着卡片底边。现在：绘图区留在 SVG 里，刻度用 HTML 绝对定位，
// 字号恒定、永远贴着条形中心。
const CH = 44;      // 绘图区高度（viewBox 单位）
const CPAD = 1.2;   // 左右留白，避免首尾柱子被卡片边缘切掉

function chartLabels(keys) {
  const n = Math.max(1, keys.length);
  const step = n > 8 ? 2 : 1;
  const items = keys.map((t, i) => (i % step ? '' :
    `<span style="left:${(((i + 0.5) / n) * 100).toFixed(2)}%">${new Date(t).getHours()}:00</span>`)).join('');
  return `<div class="chart-x">${items}</div>`;
}

function gridLines() {
  return `<line x1="0" y1="0.6" x2="100" y2="0.6" stroke="var(--line)" stroke-width="0.4" stroke-dasharray="2 2"></line>`
    + `<line x1="0" y1="${CH / 2}" x2="100" y2="${CH / 2}" stroke="var(--line)" stroke-width="0.4" stroke-dasharray="2 2"></line>`
    + `<line x1="0" y1="${CH}" x2="100" y2="${CH}" stroke="var(--line)" stroke-width="0.5"></line>`;
}

// 一组（或多组堆叠）柱子的公共画法，返回 { svg, labels }
function barsSvg(keys, series, max) {
  const n = Math.max(1, keys.length);
  const innerW = 100 - CPAD * 2;
  const bw = innerW / n;
  let body = gridLines();
  keys.forEach((k, i) => {
    // 每根柱子包在 <g><title> 里：鼠标悬停就能看到「几点 · 多少次（其中错误多少）」
    const hh = String(new Date(k).getHours()).padStart(2, '0');
    const parts = series.map((s) => ({ name: s.name || '', v: Number(s.values[i]) || 0 }));
    const tot = parts.reduce((a, p) => a + p.v, 0);
    const tip = `${hh}:00 · 共 ${tot}${series.some((x) => x.unit) ? series.find((x) => x.unit).unit : ''}`
      + parts.filter((p) => p.name).map((p) => ` · ${p.name} ${p.v}`).join('');
    body += `<g><title>${tip}</title>`
      + `<rect x="${(CPAD + i * bw).toFixed(2)}" y="0" width="${bw.toFixed(2)}" height="${CH}" fill="transparent"></rect>`;
    let y = CH;
    series.forEach((s) => {
      const v = Number(s.values[i]) || 0;
      if (!v) return;
      const h = Math.max(0.7, (v / max) * CH);
      y = Math.max(0, y - h);
      body += `<rect x="${(CPAD + i * bw + bw * 0.16).toFixed(2)}" y="${y.toFixed(2)}" width="${(bw * 0.68).toFixed(2)}" height="${h.toFixed(2)}" rx="0.6" fill="${s.color}" opacity="${s.opacity || 0.9}"></rect>`;
    });
    body += '</g>';
  });
  return { svg: `<svg class="chart" viewBox="0 0 100 ${CH}" preserveAspectRatio="none" role="img" aria-label="统计图表">${body}</svg>`, labels: chartLabels(keys) };
}

function drawTrend(buckets) {
  const box = $('#trendBox');
  const n = buckets.length;
  if (!n) { box.innerHTML = '<div class="empty">还没有流量数据（有访问后这里会自动出现）</div>'; return; }
  const max = Math.max(1, ...buckets.map((b) => b.total)) * 1.08;
  const keys = buckets.map((b) => b.t);
  const c = barsSvg(keys, [
    { values: buckets.map((b) => b.total), color: 'var(--acc)', opacity: 0.85, name: '合计', unit: ' 次' },
    { values: buckets.map((b) => b.err), color: 'var(--err)', opacity: 0.95, name: '其中错误' },
  ], max);
  const total = buckets.reduce((a, b) => a + b.total, 0);
  const err = buckets.reduce((a, b) => a + b.err, 0);
  box.innerHTML = `<div class="row" style="gap:8px;margin-bottom:8px;flex-wrap:wrap">
      <span class="tag">合计 ${total} 次</span>
      <span class="tag err">错误 ${err} 次（${total ? Math.round((err / total) * 100) : 0}%）</span>
      <span class="tag">峰值 ${Math.max(0, ...buckets.map((b) => b.total))}/小时</span>
    </div>
    ${c.svg}${c.labels}`;
}

function drawHist(points) {
  const box = $('#histBox');
  if (!points.length) { box.innerHTML = '<div class="empty">还在采样中（每分钟一个点），几分钟后这里就有曲线了</div>'; return; }
  const total = Math.max(1, ...points.map((p) => Number(p.total) || 0));
  const scale = total * 1.12;                       // 上留一点余量，避免"全在线"时曲线贴住顶边
  // 只有一个采样点时曲线画不出来（polyline 需要 2 个点），改成画一条水平虚线 + 说明
  if (points.length < 2) {
    const p0 = points[0];
    box.innerHTML = `<div class="row" style="gap:8px;margin-bottom:8px;flex-wrap:wrap">
        <span class="tag ok">当前 ${p0.running} / ${p0.total} 在线</span>
        <span class="tag warn">刚开始采样（1 个点），再等 1~2 分钟就出曲线</span>
      </div>
      <div class="empty" style="padding:6px 0">每分钟采一个点，曲线需要至少两个点才能画出来</div>`;
    return;
  }
  const step = points.length > 1 ? 100 / (points.length - 1) : 100;
  const y = (v) => CH - (Math.max(0, Math.min(v, scale)) / scale) * CH;
  const pts = points.map((p, i) => `${(i * step).toFixed(2)},${y(p.running).toFixed(2)}`).join(' ');
  const area = `0,${CH} ${pts} ${((points.length - 1) * step).toFixed(2)},${CH}`;
  const minUp = Math.min(...points.map((p) => Number(p.running) || 0));
  const last = points[points.length - 1];
  const keys = points.map((p) => p.t);
  box.innerHTML = `<div class="row" style="gap:8px;margin-bottom:8px;flex-wrap:wrap">
      <span class="tag ok">当前 ${last.running} / ${last.total} 在线</span>
      <span class="tag">区间最低 ${minUp}</span>
      <span class="tag">${points.length} 个采样点</span>
    </div>
    <svg class="chart" viewBox="0 0 100 ${CH}" preserveAspectRatio="none" role="img" aria-label="出口在线数历史">
      ${gridLines()}
      <polygon points="${area}" fill="var(--acc)" opacity="0.16"></polygon>
      <polyline points="${pts}" fill="none" stroke="var(--acc)" stroke-width="1.4" vector-effect="non-scaling-stroke" stroke-linejoin="round"></polyline>
      ${points.map((p, i) => `<circle cx="${(i * step).toFixed(2)}" cy="${y(p.running).toFixed(2)}" r="1.1" fill="var(--acc)"><title>${new Date(p.t).getHours()}:00 · ${p.running}/${p.total} 在线</title></circle>`).join('')}
    </svg>${chartLabels(keys.filter((_, i) => i % Math.max(1, Math.ceil(points.length / 6)) === 0))}`;
}

function drawAudit(buckets) {
  const box = $('#auditBox');
  if (!box) return;
  const n = buckets.length;
  if (!n) { box.innerHTML = '<div class="empty">还没有变更记录</div>'; return; }
  const max = Math.max(1, ...buckets.map((b) => b.total)) * 1.08;
  const keys = buckets.map((b) => b.t);
  const c = barsSvg(keys, [
    { values: buckets.map((b) => b.total), color: 'var(--warn)', opacity: 0.85, name: '合计', unit: ' 次改动' },
    { values: buckets.map((b) => b.err), color: 'var(--err)', opacity: 0.95, name: '失败' },
  ], max);
  const total = buckets.reduce((a, b) => a + b.total, 0);
  const err = buckets.reduce((a, b) => a + b.err, 0);
  box.innerHTML = `<div class="row" style="gap:8px;margin-bottom:8px;flex-wrap:wrap">
      <span class="tag">合计 ${total} 次改动</span>
      <span class="tag ${err ? 'err' : ''}">失败 ${err} 次</span>
      <span class="tag">${total === 0 ? '这段时间没人动过' : '峰值 ' + Math.max(0, ...buckets.map((b) => b.total)) + '/小时'}</span>
      <a class="sm" href="/observe">看明细 →</a>
    </div>
    ${c.svg}${c.labels}`;
}

// 按规则堆叠柱状图：一眼看出哪个服务在吃流量
const PATH_COLORS = ['var(--acc)', 'var(--warn)', 'var(--err)', 'var(--dim)'];

function drawPaths(groups, hours, unmatched) {
  const box = $('#pathBox');
  if (!box) return;
  if (!groups || !groups.length) {
    const extra = (unmatched && unmatched.total) ? `（另有 ${unmatched.total} 次没命中任何规则）` : '';
    box.innerHTML = `<div class="empty">这段时间还没有命中任何规则的访问${extra}</div>`;
    return;
  }
  const keys = groups[0].buckets.map((b) => b.t);
  let stackMax = 1;
  keys.forEach((_, i) => {
    const sum = groups.reduce((a, g) => a + ((g.buckets[i] || {}).total || 0), 0);
    if (sum > stackMax) stackMax = sum;
  });
  stackMax *= 1.08;
  const c = barsSvg(keys, groups.map((g, gi) => ({
    values: keys.map((_, i) => (g.buckets[i] || {}).total || 0),
    color: PATH_COLORS[gi % PATH_COLORS.length],
    opacity: 0.9,
    name: g.name,
    unit: ' 次请求',
  })), stackMax);
  const legend = groups.map((g, gi) => {
    const color = PATH_COLORS[gi % PATH_COLORS.length];
    const label = `${esc(g.name)} · ${g.total}${g.err ? ` · 5xx ${g.err}` : ''}`;
    const tip = `跳到规则页定位这条规则${g.path ? `（路径 ${esc(g.path)}）` : ''}`;
    return g.id
      ? `<a class="tag jump" href="/rules?focus=${encodeURIComponent(g.id)}" title="${tip}" style="border-left:3px solid ${color}">${label} →</a>`
      : `<span class="tag" style="border-left:3px solid ${color}">${label}</span>`;
  }).join('');
  box.innerHTML = `<div class="row" style="gap:6px;margin-bottom:8px;flex-wrap:wrap">${legend}</div>
    ${c.svg}${c.labels}
    <div class="sub" style="margin-top:4px">最近 ${hours} 小时；另有 ${(unmatched && unmatched.total) || 0} 次没命中任何规则（健康检查、未知路径）${(unmatched && unmatched.err) ? `，其中 5xx ${unmatched.err} 次` : ''}</div>`;
}

// 部署提醒：容器里跑的代码指纹变了、但还没预过热 → 提示去点一下
async function paintWarmHint(d) {
  const bar = $('#warmBar');
  if (!bar) return;
  let code = '';
  try { code = ((await api('/healthz')) || {}).code || ''; } catch { return; }
  const w = (d && d.state && d.state.warm) || null;
  if (!w) {
    bar.className = 'hint warn';
    bar.innerHTML = `还没有预过热：点 <a href="/tools">工具箱 → 预热缓存</a>，把关键资源在边缘拉一遍，首个访客就不用等冷启动。`;
    return;
  }
  if (w.code && code && w.code !== code) {
    bar.className = 'hint warn';
    bar.innerHTML = `代码已更新（指纹 ${esc(String(w.code))} → ${esc(code)}），上次预热是 ${fmtTime(w.at)}。资源 URL 变了，建议 <a href="/tools">重新预热</a>。`;
    return;
  }
  bar.className = 'hint warn hidden';
  bar.textContent = '';
}

async function paintCharts() {
  const hours = Number($('#trendHours').value || 12);
  try {
    const d = await api('/api/traffic?hours=' + hours);
    drawTrend(d.buckets || []);
  } catch (e) {
    $('#trendBox').innerHTML = `<div class="hint warn">${esc(e.message)}</div>`;
  }
  try {
    const h = await api('/api/history');
    drawHist(h.points || []);
  } catch (e) {
    $('#histBox').innerHTML = `<div class="hint warn">${esc(e.message)}</div>`;
  }
  try {
    const a = await api('/api/audit/trend?hours=' + Number(($('#auditHours') || {}).value || 12));
    drawAudit(a.buckets || []);
  } catch (e) {
    if ($('#auditBox')) $('#auditBox').innerHTML = `<div class="hint warn">${esc(e.message)}</div>`;
  }
  try {
    const ph = Number(($('#pathHours') || {}).value || 12);
    const pr = await api('/api/traffic/paths?hours=' + ph + '&top=4');
    drawPaths(pr.groups || [], pr.hours || ph, pr.unmatched || null);
  } catch (e) {
    if ($('#pathBox')) $('#pathBox').innerHTML = `<div class="hint warn">${esc(e.message)}</div>`;
  }
}

function appendLog(rec) {
  if (!logEl) return;
  const span = document.createElement('span');
  span.className = 'l-' + (rec.source || 'panel');
  span.textContent = `${new Date(rec.t || rec.at).toLocaleTimeString('zh-CN', { hour12: false })} [${rec.source}] ${rec.line}\n`;
  logEl.appendChild(span);
  logCount++;
  if (logEl.childNodes.length > 400) logEl.removeChild(logEl.firstChild);
  logEl.scrollTop = logEl.scrollHeight;
}

/**
 * Grafana 嵌入：只读 settings.grafana，拼 /d-solo/ 单 panel 地址。
 * 为什么用 d-solo：整块 dashboard 嵌进首页会带自己的时间选择器和侧栏，太小太挤；
 * d-solo 只给一张图，尺寸可控（height 由设置里每条决定）。
 * 注意 Grafana 侧必须 allow_embedding = true，否则它自己会回 X-Frame-Options: deny。
 */
function grafanaUrl(g, panel) {
  const dash = String(g.dashboard || '').replace(/^\/+|\/+$/g, '');
  const parts = dash.split('/');
  const uid = parts[0] || '';
  const slug = parts[1] || uid;
  const theme = g.theme || (document.documentElement.dataset.theme === 'light' ? 'light' : 'dark');
  const qs = new URLSearchParams({ orgId: '1', panelId: String(panel.panelId), kiosk: '', theme });
  return `${g.url.replace(/\/+$/, '')}/d-solo/${encodeURIComponent(uid)}/${encodeURIComponent(slug)}?${qs.toString()}`;
}

function paintGrafana(d) {
  const card = $('#grafanaCard');
  const box = $('#grafanaBox');
  if (!card || !box) return;
  const g = (d && d.state && d.state.settings && d.state.settings.grafana) || {};
  if (!g.enabled || !g.url || !g.dashboard || !(g.panels || []).length) {
    card.classList.add('hidden');
    return;
  }
  card.classList.remove('hidden');
  const open = $('#btnGrafanaOpen');
  if (open) {
    const dash = String(g.dashboard).replace(/^\/+|\/+$/g, '').split('/');
    open.href = `${g.url.replace(/\/+$/, '')}/d/${encodeURIComponent(dash[0])}/${encodeURIComponent(dash[1] || dash[0])}`;
  }
  // 已渲染过同样的配置就不重建（iframe 重建会闪、也会重新拉一次 Grafana）
  const key = JSON.stringify({ url: g.url, dash: g.dashboard, theme: g.theme, panels: g.panels });
  if (box.dataset.key === key) return;
  box.dataset.key = key;
  box.innerHTML = (g.panels || []).map((p) => `
    <div style="margin:0 0 10px">
      ${p.title ? `<div class="sub" style="margin:0 0 4px">${esc(p.title)}</div>` : ''}
      <iframe src="${esc(grafanaUrl(g, p))}" title="${esc(p.title || ('Grafana panel ' + p.panelId))}"
              style="width:100%;height:${Number(p.h) || 220}px;border:1px solid var(--line);border-radius:8px;background:transparent"
              loading="lazy" referrerpolicy="no-referrer"></iframe>
    </div>`).join('');
}

async function refresh() {
  try {
    const d = await loadState(true);
    paintHealth(d);
    paintExits(d);
    paintRules(d);
    await paintStats(d);
    await paintCharts();
    paintGrafana(d);
    await paintWarmHint(d);
    $('#updAt').textContent = '更新于 ' + fmtClock();
  } catch (e) {
    toast('读取状态失败：' + e.message, 'err');
  }
}

document.addEventListener('DOMContentLoaded', () => {
  logEl = $('#logBox');
  $('#btnRefresh').addEventListener('click', refresh);
  $('#trendHours').addEventListener('change', paintCharts);
  const ah = $('#auditHours');
  if (ah) ah.addEventListener('change', paintCharts);
  const ph = $('#pathHours');
  if (ph) ph.addEventListener('change', paintCharts);
  refresh();
  setInterval(refresh, 5000);
  openLogStream(appendLog);
});
