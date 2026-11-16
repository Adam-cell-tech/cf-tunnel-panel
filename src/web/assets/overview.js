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
function drawTrend(buckets) {
  const box = $('#trendBox');
  const n = buckets.length;
  if (!n) { box.innerHTML = '<div class="empty">还没有流量数据</div>'; return; }
  const max = Math.max(1, ...buckets.map((b) => b.total));
  const W = 100, H = 42, bw = W / n;
  const bars = buckets.map((b, i) => {
    const h = (b.total / max) * H;
    const eh = (b.err / max) * H;
    const x = i * bw;
    return `<rect x="${x + bw * 0.12}" y="${H - h}" width="${bw * 0.76}" height="${h}" rx="0.8" fill="var(--acc)" opacity="0.85"></rect>`
      + (eh > 0 ? `<rect x="${x + bw * 0.12}" y="${H - eh}" width="${bw * 0.76}" height="${eh}" rx="0.8" fill="var(--err)"></rect>` : '');
  }).join('');
  const labels = buckets.map((b, i) => {
    if (n > 8 && i % 2) return '';
    const d = new Date(b.t);
    return `<text x="${i * bw + bw / 2}" y="${H + 6.5}" font-size="3.6" text-anchor="middle" fill="var(--dim)">${d.getHours()}:00</text>`;
  }).join('');
  const total = buckets.reduce((a, b) => a + b.total, 0);
  const err = buckets.reduce((a, b) => a + b.err, 0);
  box.innerHTML = `<div class="row" style="gap:8px;margin-bottom:6px">
      <span class="tag">合计 ${total} 次</span>
      <span class="tag err">错误 ${err} 次（${total ? Math.round((err / total) * 100) : 0}%）</span>
      <span class="tag">峰值 ${max}/小时</span>
    </div>
    <svg class="chart" viewBox="0 0 ${W} ${H + 10}" preserveAspectRatio="none" role="img" aria-label="每小时请求数">${bars}${labels}</svg>`;
}

function drawHist(points) {
  const box = $('#histBox');
  if (!points.length) { box.innerHTML = '<div class="empty">还在采样中（每分钟一个点），几分钟后这里就有曲线了</div>'; return; }
  const maxTotal = Math.max(1, ...points.map((p) => p.total));
  const W = 100, H = 42;
  const step = points.length > 1 ? W / (points.length - 1) : W;
  const y = (v) => H - (v / maxTotal) * H;
  const line = points.map((p, i) => `${i * step},${y(p.running)}`).join(' ');
  const area = `0,${H} ` + points.map((p, i) => `${i * step},${y(p.running)}`).join(' ') + ` ${(points.length - 1) * step},${H}`;
  const minUp = Math.min(...points.map((p) => p.running));
  const last = points[points.length - 1];
  box.innerHTML = `<div class="row" style="gap:8px;margin-bottom:6px">
      <span class="tag ok">当前 ${last.running} / ${last.total} 在线</span>
      <span class="tag">区间最低 ${minUp}</span>
      <span class="tag">${points.length} 个采样点</span>
    </div>
    <svg class="chart" viewBox="0 0 ${W} ${H + 10}" preserveAspectRatio="none" role="img" aria-label="出口在线数历史">
      <polygon points="${area}" fill="var(--acc)" opacity="0.18"></polygon>
      <polyline points="${line}" fill="none" stroke="var(--acc)" stroke-width="1.2" vector-effect="non-scaling-stroke"></polyline>
    </svg>`;
}

function drawAudit(buckets) {
  const box = $('#auditBox');
  if (!box) return;
  const n = buckets.length;
  if (!n) { box.innerHTML = '<div class="empty">还没有变更记录</div>'; return; }
  const max = Math.max(1, ...buckets.map((b) => b.total));
  const W = 100, H = 42, bw = W / n;
  const bars = buckets.map((b, i) => {
    const h = (b.total / max) * H;
    const eh = (b.err / max) * H;
    const x = i * bw;
    return `<rect x="${x + bw * 0.12}" y="${H - h}" width="${bw * 0.76}" height="${h}" rx="0.8" fill="var(--warn)" opacity="0.85"></rect>`
      + (eh > 0 ? `<rect x="${x + bw * 0.12}" y="${H - eh}" width="${bw * 0.76}" height="${eh}" rx="0.8" fill="var(--err)"></rect>` : '');
  }).join('');
  const labels = buckets.map((b, i) => {
    if (n > 8 && i % 2) return '';
    return `<text x="${i * bw + bw / 2}" y="${H + 6.5}" font-size="3.6" text-anchor="middle" fill="var(--dim)">${new Date(b.t).getHours()}:00</text>`;
  }).join('');
  const total = buckets.reduce((a, b) => a + b.total, 0);
  const err = buckets.reduce((a, b) => a + b.err, 0);
  box.innerHTML = `<div class="row" style="gap:8px;margin-bottom:6px">
      <span class="tag">合计 ${total} 次改动</span>
      <span class="tag err">失败 ${err} 次</span>
      <span class="tag">${total === 0 ? '这段时间没人动过' : '峰值 ' + max + '/小时'}</span>
      <a class="sm" href="/observe">看明细 →</a>
    </div>
    <svg class="chart" viewBox="0 0 ${W} ${H + 10}" preserveAspectRatio="none" role="img" aria-label="每小时变更次数">${bars}${labels}</svg>`;
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
  const n = keys.length;
  const W = 100, H = 42, bw = W / Math.max(1, n);
  let stackMax = 1;
  keys.forEach((_, i) => {
    const sum = groups.reduce((a, g) => a + ((g.buckets[i] || {}).total || 0), 0);
    if (sum > stackMax) stackMax = sum;
  });
  let bars = '';
  keys.forEach((_, i) => {
    let y = H;
    groups.forEach((g, gi) => {
      const v = (g.buckets[i] || {}).total || 0;
      if (!v) return;
      const h = (v / stackMax) * H;
      y -= h;
      bars += `<rect x="${i * bw + bw * 0.12}" y="${y}" width="${bw * 0.76}" height="${h}" rx="0.8" fill="${PATH_COLORS[gi % PATH_COLORS.length]}" opacity="0.9"></rect>`;
    });
  });
  const labels = keys.map((t, i) => {
    if (n > 8 && i % 2) return '';
    return `<text x="${i * bw + bw / 2}" y="${H + 6.5}" font-size="3.6" text-anchor="middle" fill="var(--dim)">${new Date(t).getHours()}:00</text>`;
  }).join('');
  const legend = groups.map((g, gi) => `<span class="tag" style="border-left:3px solid ${PATH_COLORS[gi % PATH_COLORS.length]}">${esc(g.name)} · ${g.total}${g.err ? ` · 5xx ${g.err}` : ''}</span>`).join('');
  box.innerHTML = `<div class="row" style="gap:6px;margin-bottom:6px;flex-wrap:wrap">${legend}</div>
    <svg class="chart" viewBox="0 0 ${W} ${H + 10}" preserveAspectRatio="none" role="img" aria-label="按规则的每小时请求数">${bars}${labels}</svg>
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

async function refresh() {
  try {
    const d = await loadState(true);
    paintHealth(d);
    paintExits(d);
    paintRules(d);
    await paintStats(d);
    await paintCharts();
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
