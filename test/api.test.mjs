import http from 'node:http';

const B = process.env.PANEL_URL || 'http://127.0.0.1:8090';
const USER = process.env.PANEL_USER || 'admin';
const PASS = process.env.PANEL_PASS || '';
if (!PASS) {
  console.error('需要环境变量 PANEL_PASS（面板登录密码）：PANEL_PASS=你的密码 node test/api.test.mjs');
  process.exit(2);
}
const basic = 'Basic ' + Buffer.from(`${USER}:${PASS}`).toString('base64');

// 所有打到面板的请求自动带凭据（面板登录开着，否则全是 401）
const rawFetch = globalThis.fetch;
globalThis.fetch = (u, o = {}) => {
  const href = String(u);
  if (href.startsWith(B)) o = { ...o, headers: { ...(o.headers || {}), Authorization: basic } };
  return rawFetch(u, o);
};

let pass = 0, fail = 0;
const ok = (n, c, x = '') => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${x ? '  [' + x + ']' : ''}`); };
const j = async (p, o = {}) => {
  const r = await fetch(B + p, { headers: o.body ? { 'Content-Type': 'application/json' } : {}, ...o, body: o.body ? JSON.stringify(o.body) : undefined });
  const t = await r.text();
  let d; try { d = JSON.parse(t); } catch { d = { raw: t }; }
  return { status: r.status, d, headers: r.headers };
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const h = await j('/healthz');
ok('healthz 200 且带 version', h.status === 200 && !!h.d.version, h.d.version);
ok('healthz 带代码指纹', !!h.d.code && h.d.code.length === 16, String(h.d.code));
ok('healthz 报告 drift 标记', typeof h.d.drift === 'boolean', String(h.d.drift));

const st = await j('/api/state');
const routes0 = st.d.state.routes.length;
ok('state: 不泄露 tunnel token', !JSON.stringify(st.d.state.tunnels).includes('"token":"ey'), '');
console.log('     settings.cf 字段:', JSON.stringify(st.d.state.settings.cf));
console.log('     settings.notify 字段:', JSON.stringify(st.d.state.settings.notify));

// 未知路径
for (const p of ['/nope', '/api/nope', '/assets/nope.js']) {
  const r = await j(p);
  ok(`未知路径 ${p} 返回 404`, r.status === 404, String(r.status));
}

// 隧道生命周期
const tl0 = (await j('/api/tunnels')).d.tunnels.length;
const created = await j('/api/tunnels', { method: 'POST', body: { name: 'API 测试出口', mode: 'quick', origin: 'http://127.0.0.1:8080' } });
ok('创建出口 200', created.status === 200 && !!created.d.id, JSON.stringify(created.d).slice(0, 80));
const nid = created.d.id;
await sleep(14000);
const tl1 = await j('/api/tunnels');
const rt1 = tl1.d.tunnels.find((t) => t.id === nid);
const throttled = rt1 && /限流/.test(String(rt1.lastError || ''));
ok('新出口进入 running（或 Cloudflare 限流时退避中）', rt1 && (rt1.status === 'running' || throttled), rt1 && (throttled ? '限流退避：' + rt1.lastError : rt1.status));
ok('新出口有公网地址（限流时跳过）', !!(rt1 && rt1.url) || throttled, rt1 && (rt1.url || '限流中'));
const stop = await j(`/api/tunnels/${nid}/stop`, { method: 'POST' });
ok('停止出口 200', stop.status === 200, String(stop.status));
await sleep(5000);
const tl2 = await j('/api/tunnels');
ok('停止后状态=stopped', tl2.d.tunnels.find((t) => t.id === nid).status === 'stopped', (tl2.d.tunnels.find((t) => t.id === nid) || {}).status);
const del = await j(`/api/tunnels/${nid}/delete`, { method: 'POST' });
ok('删除出口 200', del.status === 200, String(del.status));
const tl3 = await j('/api/tunnels');
ok('删除后数量回到原值', tl3.d.tunnels.length === tl0, `${tl0}→${tl3.d.tunnels.length}`);

// 临时全局探针规则（不依赖用户现有规则：现有规则多按 Host/出口绑定，裸 Host 可能什么都不命中）
const stRoutes = (await j('/api/state')).d.state.routes || [];
const QA = { id: 'qa-probe', name: 'QA 探针', enabled: true, tunnelId: '', host: '', path: '/qa',
  strip: true, upstream: 'http://127.0.0.1:8091', basicAuth: {}, headersReq: '', headersRes: '', note: '临时，测试结束删除' };
const router0 = await j('/api/routes', { method: 'POST', body: { routes: [QA, ...stRoutes.filter((r) => r.id !== 'qa-probe')] } });
ok('临时探针规则下发成功', router0.d.caddy && router0.d.caddy.ok === true, JSON.stringify(router0.d.caddy || {}));

// 规则自检
const t1 = await j('/api/rules/test', { method: 'POST', body: { upstream: 'http://127.0.0.1:8091' } });
ok('测上游（通）ok', t1.d.ok === true, JSON.stringify(t1.d).slice(0, 90));
const t2 = await j('/api/rules/test', { method: 'POST', body: { upstream: 'http://127.0.0.1:9' } });
ok('测上游（不通）失败', t2.d.ok === false, JSON.stringify(t2.d).slice(0, 90));
const mainRt = st.d.runtime.tunnels.find((x) => x.id === 'main') || {};
const mainHost = new URL(mainRt.publicUrl || mainRt.url || 'https://x.example.com').hostname;
const m1 = await j('/api/match', { method: 'POST', body: { path: '/qa/x', host: mainHost, method: 'GET' } });
ok('模拟匹配 /qa/x 命中 /qa', m1.d.ok === true && !!m1.d.matched && m1.d.rule.path === '/qa', (m1.d.rule || {}).path);
const m2 = await j('/api/match', { method: 'POST', body: { path: '/zzz', host: mainHost, method: 'GET' } });
ok('模拟匹配返回可用结果', m2.d.ok === true, JSON.stringify(m2.d).slice(0, 80));

// 链自测
const c1 = await j('/api/curl', { method: 'POST', body: { path: '/qa' } });
ok('/api/curl 打到 whoami', c1.d.ok === true && c1.d.status === 200, `${c1.d.status} ${c1.d.ms}ms`);

// 分享链接
const sh = await j('/api/shares', { method: 'POST', body: { name: 'API 分享', upstream: 'http://127.0.0.1:8091', minutes: 5 } });
ok('创建分享 200', sh.status === 200 && !!sh.d.share.url, sh.d.share && sh.d.share.url);
if (sh.d.share) {
  const sharePath = sh.d.share.path || ('/s/' + sh.d.share.token);
  const r = await fetch('http://127.0.0.1:8080' + sharePath);
  ok('分享链接经 Caddy 可用', r.status === 200, String(r.status));
  const d2 = await j(`/api/shares/${sh.d.share.id}/delete`, { method: 'POST' });
  ok('删除分享 200', d2.status === 200, String(d2.status));
}

// 维护模式
await j('/api/settings', { method: 'POST', body: { maintenance: { on: true, body: 'API 测试维护中', retryAfter: 120 } } });
const dm = await fetch('http://127.0.0.1:8080/qa');
ok('维护模式返回 503', dm.status === 503, String(dm.status));
const ra = dm.headers.get('retry-after');
ok('维护模式带 Retry-After', ra === '120', String(ra));
await j('/api/settings', { method: 'POST', body: { maintenance: { on: false, body: '', retryAfter: 300 } } });
const dm2 = await fetch('http://127.0.0.1:8080/qa');
ok('关闭维护后恢复 200', dm2.status === 200, String(dm2.status));

// IP 黑名单
await j('/api/settings', { method: 'POST', body: { security: { ipDeny: '127.0.0.1/32' } } });
const db = await fetch('http://127.0.0.1:8080/qa');
ok('黑名单命中 403', db.status === 403, String(db.status));
await j('/api/settings', { method: 'POST', body: { security: { ipDeny: '' } } });
const db2 = await fetch('http://127.0.0.1:8080/qa');
ok('清空黑名单恢复 200', db2.status === 200, String(db2.status));

// 面板自带测速端点
const bp = await fetch(B + '/__bench/ping');
const bpd = await bp.json();
ok('测速 ping 200', bp.status === 200 && bpd.ok === true, JSON.stringify(bpd).slice(0, 60));
ok('测速 ping 带 colo 字段', 'colo' in bpd, String(bpd.colo || '（本机直连为空，正常）'));
const bb = await fetch(B + '/__bench/blob?mb=1');
const bbuf = Buffer.from(await bb.arrayBuffer());
ok('测速 blob 1MB 字节数正确', bbuf.length === 1048576, `${bbuf.length}`);
ok('测速 blob 不被缓存', (bb.headers.get('cache-control') || '').includes('no-store'), bb.headers.get('cache-control') || '');
const bl = await j('/api/bench/local', { method: 'POST', body: { n: 3 } });
ok('本机 Caddy 延迟可测', bl.d.ok === true && bl.d.ttfbMs && typeof bl.d.ttfbMs.median === 'number', JSON.stringify(bl.d.ttfbMs || {}));


// 分享链接不能被「path=/ 的兜底规则」吃掉（v0.7.8 回归）
{
  const host = new URL((st.d.runtime.tunnels.find((t) => t.id === 'main') || {}).publicUrl || 'http://127.0.0.1').hostname;
  const sh = await j('/api/shares', { method: 'POST', body: { name: 'qa-shadow', upstream: 'http://127.0.0.1:8091', minutes: 5 } });
  const tok = sh.d.share && sh.d.share.token;
  ok('分享链接创建成功', !!tok, sh.d.share && sh.d.share.url);
  const hit = (pth) => new Promise((res) => {
    const rq = http.request({ host: '127.0.0.1', port: 8080, path: pth, method: 'GET', headers: { Host: host } }, (r) => { r.resume(); res(r.statusCode); });
    rq.on('error', () => res(0)); rq.end();
  });
  const codeRoot = await hit(`/s/${tok}`);
  const codeSub = await hit(`/s/${tok}/anything`);
  ok('分享链接在面板域名下可访问（不撞鉴权）', codeRoot === 200, String(codeRoot));
  ok('分享链接子路径透传正常', codeSub === 200, String(codeSub));
  await j(`/api/shares/${sh.d.share.id}/delete`, { method: 'POST', body: {} });
}


// Cloudflare API 集成（只读断言，避免动真实 DNS）
{
  const v = await j('/api/cf/verify');
  const hasCf = v.d && (v.d.accounts || []).length > 0;
  ok('CF: 验证 token 可用', v.status === 200 && hasCf, v.d && String(v.d.token).slice(0, 28));
  ok('CF: 自动带出 accountId 建议', !!(v.d && v.d.suggest && v.d.suggest.accountId), v.d && v.d.suggest && v.d.suggest.accountId);
  const dz = await j('/api/cf/dns');
  ok('CF: DNS 记录可读', dz.status === 200 && Array.isArray(dz.d.records), `${(dz.d.records || []).length} 条`);
  const dt = await j('/api/cf/tunnels');
  ok('CF: 云端隧道列表可读', dt.status === 200 && Array.isArray(dt.d.tunnels), `${(dt.d.tunnels || []).length} 条`);
}

// 导出导入往返
const exp = await j('/api/export');
ok('导出不含 token', !JSON.stringify(exp.d.tunnels || []).includes('eyJ'), '');
const imp = await j('/api/import', { method: 'POST', body: exp.d });
ok('导入后规则数不变', imp.d.ok && imp.d.routeCount === (exp.d.routes || []).length, `${(exp.d.routes || []).length}→${imp.d.routeCount}`);
const expFull = await j('/api/export?full=1');
ok('full 导出结构完整', expFull.d.ok !== false && Array.isArray(expFull.d.tunnels) && expFull.d.tunnels.length === (exp.d.tunnels || []).length, '');
const stFresh = await j('/api/state');
ok('state 不泄露 notify.url / cf.token', stFresh.d.state.settings.cf.hasToken !== undefined && stFresh.d.state.settings.notify.hasUrl !== undefined, JSON.stringify(stFresh.d.state.settings.notify));

// 面板鉴权（验证当前管理员口令；不动线上登录状态）
const noAuth = await rawFetch(B + '/api/state');
ok('无凭据 401', noAuth.status === 401, String(noAuth.status));
const withAuth = await rawFetch(B + '/api/state', { headers: { Authorization: basic } });
ok('带凭据 200', withAuth.status === 200, String(withAuth.status));
const badge = await rawFetch(B + '/badge.svg');
ok('徽章免鉴权', badge.status === 200, String(badge.status));

// 其他端点
for (const p of ['/metrics', '/badge.svg']) {
  const r = await fetch(B + p);
  ok(`${p} 200`, r.status === 200, String(r.status));
}
// v0.12.0 起旧单页已下线，/legacy 应该 404（不再是 96KB 的重复界面）
const lg = await fetch(B + '/legacy');
ok('/legacy 已下线（404）', lg.status === 404, String(lg.status));
// 新增：规则命中统计 / 配置导出 YAML
{
  const pages = ['/login', '/', '/tunnels', '/rules', '/tools', '/observe', '/settings'];
  let inline = [];
  for (const pg of pages) {
    const r = await fetch(B + pg);
    const html = await r.text();
    // 匹配「<script>」但不带 src 的内联标签
    const m = html.match(/<script(?![^>]*\ssrc=)[^>]*>/gi) || [];
    if (m.length) inline.push(pg + ':' + m.length);
  }
  ok('所有页面都没有内联 <script>（CSP script-src self 会拦）', inline.length === 0, inline.join(','));
  const boot = await rawFetch(B + '/boot.js');
  const bootTxt = await boot.text();
  ok('/boot.js 可用且注入语言与字典', boot.status === 200 && /__CFP_LANG/.test(bootTxt) && /__CFP_DICT/.test(bootTxt),
    `${boot.status} ${bootTxt.length}B`);
  ok('/boot.js 是 JS 且不缓存', /javascript/.test(boot.headers.get('content-type') || '') && /no-store/.test(boot.headers.get('cache-control') || ''),
    boot.headers.get('content-type') + ' / ' + boot.headers.get('cache-control'));
  const loginJs = await rawFetch(B + '/assets/login.js');
  ok('登录页脚本是外部文件', loginJs.status === 200, String(loginJs.status));
}
{
  const sec = await j('/api/security/attempts?hours=24');
  const d = sec.d || {};
  ok('/api/security/attempts 可用', sec.status === 200 && typeof d.total === 'number', JSON.stringify(d).slice(0, 80));
  ok('/api/security/attempts 两个维度都在', Array.isArray(d.byRule) && Array.isArray(d.byIp), `${(d.byRule || []).length}/${(d.byIp || []).length}`);
  ok('/api/security/attempts 计数自洽', !d.total || (d.byRule || []).length > 0, `total=${d.total}`);
  const sec6 = await j('/api/security/attempts?hours=6&limit=100');
  ok('/api/security/attempts 窗口参数生效', sec6.status === 200 && Number(sec6.d.hours) === 6, String(sec6.d && sec6.d.hours));
  const st2 = await j('/api/state');
  ok('state 里通知事件含 authScan', !st2.d.state.settings.notify.events || st2.d.state.settings.notify.events.authScan !== false, JSON.stringify(st2.d.state.settings.notify.events));
}
{
  const acc = await j('/api/access?limit=50');
  const rows = (acc.d && acc.d.rows) || [];
  const bad = rows.filter((r) => r.rule && (!r.rule.id || typeof r.rule.name !== 'string'));
  ok('/api/access 每行带命中规则（形状正确）', acc.status === 200 && bad.length === 0, `${rows.length} 行, 坏 ${bad.length}`);
  const withRule = rows.filter((r) => r.rule).length;
  ok('/api/access 命中规则的行可跳转（有 id）', rows.length === 0 || withRule > 0 || rows.every((r) => !r.rule), `命中行 ${withRule}/${rows.length}`);
}
const rs = await j('/api/routes/stats?limit=200');
ok('/api/routes/stats 可用', rs.status === 200 && Array.isArray(rs.d.routes), JSON.stringify(rs.d).slice(0, 60));
const yaml = await fetch(B + '/api/export.yaml', { headers: { Authorization: basic } });
const ytext = await yaml.text();
ok('/api/export.yaml 返回 YAML', yaml.status === 200 && ytext.includes('routes:') && /yaml/.test(yaml.headers.get('content-type') || ''), String(yaml.status));
ok('YAML 不含明文口令/密钥', !/^\s*pass:/mi.test(ytext) && !/\$2[aby]\$/.test(ytext) && !/cfat_/.test(ytext), ytext.slice(0, 40));
const sse = await fetch(B + '/api/logs/stream');
ok('SSE 日志流可连接', sse.status === 200 && (sse.headers.get('content-type') || '').includes('text/event-stream'), sse.headers.get('content-type'));
sse.body.cancel();

const dl = await fetch(B + '/api/logs/download');
ok('日志下载 200', dl.status === 200, String(dl.status));

// —— 0.7.1 新增能力 ——
const cfg = await j('/api/caddy/config');
ok('生成的 Caddy 配置可读取', cfg.status === 200 && cfg.d.ok === true && !!cfg.d.config.apps.http, cfg.d.ok ? `routes=${(cfg.d.config.apps.http.servers.main.routes || []).length}` : cfg.d.error);

const stNew = await j('/api/state');
ok('state 带 shadowed 列表', Array.isArray(stNew.d.runtime.caddy.shadowed), `shadowed=${(stNew.d.runtime.caddy.shadowed || []).length}`);
ok('state 带上游健康列表', Array.isArray(stNew.d.runtime.upstreams) && stNew.d.runtime.upstreams.length > 0, (stNew.d.runtime.upstreams || []).map((u) => (u.ok ? '1' : '0')).join(''));
ok('上游健康全部在线', (stNew.d.runtime.upstreams || []).every((u) => u.ok), '');

// 出口专属规则不能串域名：自己造一条绑在 main 出口的规则来测，不依赖用户当前的规则表
{
  const cur = (await j('/api/state')).d.state.routes;
  const withProbe = [{ id: 'qa-scope', name: 'QA 专属规则', path: '/qascope', host: '', upstream: 'http://127.0.0.1:8091', strip: true, tunnelId: 'main' }, ...cur.filter((r) => r.id !== 'qa-scope')];
  await j('/api/routes', { method: 'POST', body: { routes: withProbe } });
  const mainUrl = (await j('/api/state')).d.runtime.tunnels.find((t) => t.id === 'main') || {};
  const mainHost = String(mainUrl.publicUrl || mainUrl.url || '').replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  const other = await j('/api/match', { method: 'POST', body: { path: '/qascope/x', host: 'nope.invalid', method: 'GET' } });
  ok('模拟匹配：专属出口规则不会串到别的域名', !(other.d.rule && other.d.rule.id === 'qa-scope'), (other.d.rule || {}).path || 'no-match');
  const own = await j('/api/match', { method: 'POST', body: { path: '/qascope/x', host: mainHost, method: 'GET' } });
  ok('模拟匹配：专属出口规则在自己的域名上命中', !!(own.d.rule && own.d.rule.id === 'qa-scope'), JSON.stringify(own.d).slice(0, 80));
  const back = (await j('/api/state')).d.state.routes.filter((r) => r.id !== 'qa-scope');
  await j('/api/routes', { method: 'POST', body: { routes: back } });
}

const root = await j('/');
ok('页面有 CSP 头', (root.headers.get('content-security-policy') || '').includes("default-src 'self'"), '');
ok('页面有 nosniff 头', root.headers.get('x-content-type-options') === 'nosniff', '');

const e1 = await fetch(B + '/assets/app.css');
const et = e1.headers.get('etag');
const e2 = await fetch(B + '/assets/app.css', { headers: { 'If-None-Match': et } });
ok('静态资源支持 ETag/304', e1.status === 200 && !!et && e2.status === 304, `etag=${et} second=${e2.status}`);
const e3 = await fetch(B + '/assets/app.css', { headers: { 'Accept-Encoding': 'gzip' } });
ok('静态资源走 gzip', (e3.headers.get('content-encoding') || '') === 'gzip', e3.headers.get('content-encoding') || '');

const rl = await j('/api/match', { method: 'POST', body: { path: '/demo', method: 'GET' } });
ok('模拟匹配缺域名时提示 needHost', rl.d.needHost === true || (rl.d.ok === true), rl.d.needHost ? 'needHost' : 'ok');

// ---- v0.7.2 新接口：WS 自测 / 备份对比 / 通知冷却与静默 ----
const wsOk = await j('/api/ws-test', { method: 'POST', body: { path: '/term/ws' } });
ok('WS 自测：网页终端可升级 101', wsOk.d.ok === true && wsOk.d.status === 101, `${wsOk.d.status || ''} ${wsOk.d.ms || ''}ms`);
const wsBad = await j('/api/ws-test', { method: 'POST', body: { path: '/qa' } });
ok('WS 自测：普通 HTTP 上游识别为不可升级', wsBad.d.ok === false && wsBad.d.status === 200, String(wsBad.d.status));

const bfiles = (await j('/api/backups')).d.files || [];
if (bfiles.length) {
  const diff = await j('/api/backups/diff?a=' + encodeURIComponent(bfiles[0]));
  ok('备份对比可用', diff.d.ok === true && Array.isArray(diff.d.added) && Array.isArray(diff.d.removed) && Array.isArray(diff.d.changed), `${diff.d.backupRoutes}→${diff.d.currentRoutes}`);
} else {
  ok('备份对比可用', true, '（暂无备份）');
}
const diffBad = await j('/api/backups/diff?a=../../etc/passwd');
ok('备份对比拒绝路径穿越', diffBad.status === 400, String(diffBad.status));

const quietBad = await j('/api/settings', { method: 'POST', body: { notify: { quietHours: '25:99' } } });
ok('静默时段格式校验', quietBad.status === 400, String(quietBad.status));
const quietOk = await j('/api/settings', { method: 'POST', body: { notify: { quietHours: '23:00-07:00', cooldownSec: 120 } } });
const st2 = (await j('/api/state')).d.state.settings.notify;
ok('静默时段/冷却可保存', quietOk.d.ok !== false && st2.quietHours === '23:00-07:00' && st2.cooldownSec === 120, JSON.stringify(st2));
await j('/api/settings', { method: 'POST', body: { notify: { quietHours: '', cooldownSec: 300 } } });

// ---- 设置回包脱敏 ----
{
  const r = await j('/api/settings', { method: 'POST', body: { panelTitle: 'cf-tunnel-panel' } });
  const d = r.d || {};
  const cf = (d.settings && d.settings.cf) || {};
  const notify = (d.settings && d.settings.notify) || {};
  ok('保存设置不回显 Cloudflare token', d.ok === true && !('token' in cf) && !/cfat_|eyJ/.test(JSON.stringify(d)), JSON.stringify(cf));
  ok('保存设置不回显通知 URL', !('url' in notify), JSON.stringify(notify));
}

// ---- 登录防爆破 ----
// 用「伪造来源 IP + 错误密码」的方式触发锁，不去改线上口令（改口令一旦中途崩溃会把面板锁在临时的测试账号上）
const spoof = '198.51.100.7';
const codes = [];
for (let i = 0; i < 9; i += 1) {
  const r = await rawFetch(B + '/api/state', { headers: { 'X-Forwarded-For': spoof, Authorization: 'Basic ' + Buffer.from(`${USER}:definitely-wrong`).toString('base64') } });
  codes.push(r.status);
}
ok('连续 8 次错密码后第 9 次被锁（429）', codes.slice(0, 8).every((c) => c === 401) && codes[8] === 429, codes.join(','));
const goodAfter = await rawFetch(B + '/api/state', { headers: { 'X-Forwarded-For': spoof, Authorization: basic } });
ok('锁定期内密码正确仍可进入（不误伤自己人）', goodAfter.status === 200, String(goodAfter.status));
const goodOther = await rawFetch(B + '/api/state', { headers: { Authorization: basic } });
ok('其他 IP 不受影响', goodOther.status === 200, String(goodOther.status));

// ---- 只读账号 ----
const viewerSet = await rawFetch(B + '/api/viewer', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: basic }, body: JSON.stringify({ user: 'ro', pass: 'ropass1' }) });
ok('可设置只读账号', viewerSet.status === 200, String(viewerSet.status));
const roBasic = 'Basic ' + Buffer.from('ro:ropass1').toString('base64');
const roRead = await rawFetch(B + '/api/state', { headers: { Authorization: roBasic } });
ok('只读账号可读', roRead.status === 200, String(roRead.status));
const roWrite = await rawFetch(B + '/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: roBasic }, body: JSON.stringify({ panelTitle: 'hacked' }) });
ok('只读账号写操作 403', roWrite.status === 403, String(roWrite.status));
const roBadUser = await rawFetch(B + '/api/viewer', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: basic }, body: JSON.stringify({ user: 'a b!', pass: 'ropass1' }) });
ok('只读账号名非法被拒', roBadUser.status === 400, String(roBadUser.status));
await rawFetch(B + '/api/viewer', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: basic }, body: JSON.stringify({ user: '' }) });

// ---- 新查询接口 ----
const tr = await j('/api/traffic?hours=6');
ok('/api/traffic 结构正确', tr.d.ok && Array.isArray(tr.d.buckets) && tr.d.buckets.length === 6, String(tr.d.buckets && tr.d.buckets.length));
ok('/api/traffic 桶字段齐全', (tr.d.buckets || []).every((b) => 'total' in b && 'ok' in b && 'err' in b), '');
const hist = await j('/api/history');
ok('/api/history 可用', hist.d.ok === true && Array.isArray(hist.d.points), String((hist.d.points || []).length));
const nh = await j('/api/notify/history');
ok('/api/notify/history 可用', nh.d.ok === true && Array.isArray(nh.d.items), String((nh.d.items || []).length));
const sys = await j('/api/system');
ok('/api/system 字段齐全', sys.d.ok && sys.d.version && sys.d.node && typeof sys.d.uptimeSec === 'number' && typeof sys.d.backupCount === 'number', JSON.stringify({ v: sys.d.version, b: sys.d.backupCount }));


// ---- 审计日志 ----
await j('/api/settings', { method: 'POST', body: { panelTitle: (await j('/api/state')).d.state.settings.panelTitle } }); // 制造一条"改设置"记录
await sleep(120);
const au = await j('/api/audit?limit=50');
ok('/api/audit 可用', au.d.ok === true && Array.isArray(au.d.rows), `${(au.d.rows || []).length} 条`);
ok('/api/audit 有文件与计数', !!(au.d.stats && typeof au.d.stats.fileBytes === 'number' && typeof au.d.stats.count === 'number'), JSON.stringify(au.d.stats && { c: au.d.stats.count, b: au.d.stats.fileBytes }));
const rec = (au.d.rows || [])[0] || {};
ok('审计记录字段齐全', ['at', 'actor', 'ip', 'method', 'path', 'status', 'action'].every((k) => k in rec), Object.keys(rec).join(','));
ok('审计记到了刚才那次改设置', (au.d.rows || []).some((r) => r.path === '/api/settings' && r.method === 'POST' && r.ok), '');
ok('审计不记 GET /api/state（查看类不刷屏）', !(au.d.rows || []).some((r) => r.path === '/api/state' && r.ok), '');
const auq = await j('/api/audit?q=' + encodeURIComponent('settings'));
ok('审计支持关键字搜索', auq.d.ok && (auq.d.rows || []).every((r) => [r.action, r.path, r.actor, r.ip].join(' ').toLowerCase().includes('settings')), String((auq.d.rows || []).length));

// ---- 审计趋势 ----
const sTr = await j('/api/audit/trend?hours=3');
ok('/api/audit/trend 可用', sTr.d.ok === true && Array.isArray(sTr.d.buckets) && sTr.d.buckets.length === 3, JSON.stringify((sTr.d.buckets || []).map((b) => b.total)));
ok('审计趋势分桶字段齐全', (sTr.d.buckets || []).every((b) => 'total' in b && 'ok' in b && 'err' in b), '');

// ---- 会话登录 ----
const sLp = await rawFetch(B + '/login');
const sLpText = await sLp.text();
ok('登录页 200 且有表单', sLp.status === 200 && sLpText.includes('id="loginForm"'), String(sLp.status));
const sBad = await fetch(B + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '198.51.100.21' }, body: JSON.stringify({ user: USER, pass: 'wrong-' + Date.now() }) });
const sBadD = await sBad.json().catch(() => ({}));
ok('错口令登录被拒（401 且提示剩余次数）', sBad.status === 401 && sBadD.ok === false && /还剩|锁定/.test(sBadD.error || ''), sBadD.error || '');
const sGood = await fetch(B + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '198.51.100.21' }, body: JSON.stringify({ user: USER, pass: PASS }) });
const sGoodD = await sGood.json().catch(() => ({}));
const sSetCookie = String(sGood.headers.get('set-cookie') || '');
const sSid = (sSetCookie.match(/cfp_sid=([^;]+)/) || [])[1] || '';
ok('正确口令登录拿到会话 cookie', sGood.status === 200 && sGoodD.ok === true && !!sSid, sGoodD.role || '');
ok('cookie 带 HttpOnly 与 SameSite', /HttpOnly/i.test(sSetCookie) && /SameSite=Lax/i.test(sSetCookie), sSetCookie.length + ' 字节');
const sSess = await fetch(B + '/api/sessions', { headers: { Cookie: `cfp_sid=${sSid}` } });
const sSessD = await sSess.json().catch(() => ({}));
ok('/api/sessions 列出当前会话', sSess.status === 200 && sSessD.ok && (sSessD.sessions || []).some((x) => x.current === true), String((sSessD.sessions || []).length));
const sRo = await fetch(B + '/api/sessions/revoke-others', { method: 'POST', headers: { Cookie: `cfp_sid=${sSid}`, 'Sec-Fetch-Site': 'same-origin' } });
const sRoD = await sRo.json().catch(() => ({}));
ok('踢掉其它设备可用', sRo.status === 200 && sRoD.ok === true && typeof sRoD.revoked === 'number', String(sRoD.revoked));
const sCsrf = await fetch(B + '/api/settings', { method: 'POST', headers: { Cookie: `cfp_sid=${sSid}`, 'Content-Type': 'application/json', Origin: 'https://evil.example', 'Sec-Fetch-Site': 'cross-site' }, body: JSON.stringify({ panelTitle: 'hacked' }) });
ok('会话鉴权的跨站写请求被拦（CSRF）', sCsrf.status === 403, String(sCsrf.status));
const sSame = await fetch(B + '/api/sessions', { headers: { Cookie: `cfp_sid=${sSid}`, 'Sec-Fetch-Site': 'same-origin' } });
ok('同源请求正常放行', sSame.status === 200, '');
const sLo = await fetch(B + '/api/logout', { method: 'POST', headers: { Cookie: `cfp_sid=${sSid}`, 'Sec-Fetch-Site': 'same-origin' } });
ok('/api/logout 返回 200 且清 cookie', sLo.status === 200 && /Max-Age=0/.test(String(sLo.headers.get('set-cookie') || '')), '');
const sAfter = await fetch(B + '/api/sessions', { headers: { Cookie: `cfp_sid=${sSid}` } });
const sAfterD = await sAfter.json().catch(() => ({}));
ok('登出后 cookie 失效（会话已销毁）', sAfter.status === 401 || (sAfterD.sessions || []).length === 0, String(sAfter.status));

// ---- 界面语言 ----
const sEn = await rawFetch(B + '/', { headers: { Authorization: basic, Cookie: 'cfp_lang=en' } });
const sEnText = await sEn.text();
ok('英文模式：html lang=en + 导航英文', sEnText.includes('lang="en"') && /<span>(Overview|Routes|Settings)<\/span>/.test(sEnText), '');
const sZh = await rawFetch(B + '/', { headers: { Authorization: basic } });
const sZhText = await sZh.text();
ok('中文模式：html lang=zh-CN + 导航中文', sZhText.includes('lang="zh-CN"') && sZhText.includes('<span>总览</span>'), '');

// ---- 会话换 IP 告警 ----
const ipA = '198.51.100.31', ipB = '198.51.100.32';
const loginA = await fetch(B + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ipA }, body: JSON.stringify({ user: USER, pass: PASS }) });
const sidA = (String(loginA.headers.get('set-cookie') || '').match(/cfp_sid=([^;]+)/) || [])[1] || '';
ok('换 IP 测试：先登录拿到会话', !!sidA, '');
const moved = await fetch(B + '/api/sessions', { headers: { Cookie: `cfp_sid=${sidA}`, 'X-Forwarded-For': ipB } });
const movedD = await moved.json().catch(() => ({}));
const cur = (movedD.sessions || []).find((x) => x.current) || {};
ok('同一会话换 IP 后记录 prevIp 与时间', !!cur.ipChangedAt && cur.prevIp === ipA && cur.ip === ipB, `${cur.prevIp} → ${cur.ip}`);
const auIp = await j('/api/audit?q=' + encodeURIComponent('会话来源'));
ok('换 IP 被写进审计', (auIp.d.rows || []).some((r) => r.action === '会话来源 IP 变更'), String((auIp.d.rows || []).length));

// ---- 改口令踢掉所有会话 ----
const kick = await fetch(B + '/api/panel-auth', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ user: USER, pass: PASS }) });
const kickD = await kick.json().catch(() => ({}));
ok('改口令后返回 relogin 且踢掉会话', kick.status === 200 && kickD.relogin === true && kickD.revoked >= 1, `revoked=${kickD.revoked}`);
const dead = await fetch(B + '/api/sessions', { headers: { Cookie: `cfp_sid=${sidA}` } });
const deadD = await dead.json().catch(() => ({}));
ok('改口令后旧 cookie 失效', dead.status === 401 || (deadD.sessions || []).length === 0, String(dead.status));
const stillBasic = await rawFetch(B + '/healthz');
ok('改口令后 Basic 认证仍可用', stillBasic.status === 200, '');

// ---- 退出全部设备 ----
const loginC = await fetch(B + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '198.51.100.33' }, body: JSON.stringify({ user: USER, pass: PASS }) });
const sidC = (String(loginC.headers.get('set-cookie') || '').match(/cfp_sid=([^;]+)/) || [])[1] || '';
const all = await fetch(B + '/api/sessions/revoke-all', { method: 'POST', headers: { Cookie: `cfp_sid=${sidC}`, 'Sec-Fetch-Site': 'same-origin' } });
const allD = await all.json().catch(() => ({}));
ok('退出全部设备：返回踢掉数量并清 cookie', all.status === 200 && allD.ok === true && allD.revoked >= 1 && /Max-Age=0/.test(String(all.headers.get('set-cookie') || '')), `revoked=${allD.revoked}`);

// ---- 通知格式与加签 ----
{
  const nail = async (body) => (await fetch(B + '/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }));
  const r1 = await nail({ notify: { url: 'https://example.com/hook', format: 'dingtalk' } });
  const d1 = await r1.json().catch(() => ({}));
  ok('钉钉格式填普通地址被拒', r1.status === 400 && /钉钉/.test(d1.error || ''), d1.error || '');
  const r2 = await nail({ notify: { url: 'https://api.day.app/k', format: 'feishu' } });
  const d2 = await r2.json().catch(() => ({}));
  ok('飞书格式填 Bark 地址被拒', r2.status === 400 && /飞书/.test(d2.error || ''), d2.error || '');
  const r3 = await nail({ notify: { url: 'https://oapi.dingtalk.com/robot/send?access_token=abc', format: 'dingtalk', secret: 'SECx' } });
  const d3 = await r3.json().catch(() => ({}));
  ok('钉钉地址+加签密钥可保存', r3.status === 200 && !!(d3.settings && d3.settings.notify.hasSecret), String(r3.status));
  const r4 = await nail({ notify: { clearSecret: true } });
  const d4 = await r4.json().catch(() => ({}));
  ok('清空密钥不影响格式与冷却', r4.status === 200 && d4.settings.notify.format === 'dingtalk' && d4.settings.notify.cooldownSec === 300 && d4.settings.notify.hasSecret === false, JSON.stringify(d4.settings.notify));
  await nail({ notify: { clearUrl: true, format: 'generic' } });
}


// ========== 二次验证 TOTP（v0.13.0）==========
{
  const { totp: gen } = await import('file://' + process.cwd() + '/src/core/totp.js');
  const su = await j('/api/totp/setup', { method: 'POST', body: {} });
  ok('TOTP：生成密钥', su.status === 200 && /^[A-Z2-7]{32}$/.test(su.d.secret || ''), String(su.status));
  ok('TOTP：二维码是 dataURL', /^data:image\/png;base64,/.test(su.d.qr || ''));
  const secret = su.d.secret;
  const code = () => gen(secret);
  const bad = await j('/api/totp/enable', { method: 'POST', body: { code: '000000' } });
  ok('TOTP：错误验证码不能开启', bad.status === 400, String(bad.status));
  const en = await j('/api/totp/enable', { method: 'POST', body: { code: code() } });
  ok('TOTP：开启并给 10 个恢复码', en.status === 200 && (en.d.recoveryCodes || []).length === 10, String(en.status));
  const recovery = (en.d.recoveryCodes || [])[0];
  const st1 = await j('/api/state');
  ok('TOTP：状态可读（enabled + 恢复码余量）', st1.d.state.settings.totp.enabled === true && st1.d.state.settings.totp.recoveryLeft === 10);
  ok('TOTP：密钥不出现在 /api/state', !JSON.stringify(st1.d).includes(secret));

  const l1 = await rawFetch(B + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ user: USER, pass: PASS }) });
  const l1d = await l1.json();
  ok('TOTP：口令对但不发会话', l1.status === 200 && l1d.needTotp === true && !!l1d.challenge, JSON.stringify(l1d).slice(0, 80));
  const l2 = await rawFetch(B + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ challenge: l1d.challenge, code: code() }) });
  const ck = (l2.headers.getSetCookie ? l2.headers.getSetCookie() : [l2.headers.get('set-cookie')]).join(';').split(';')[0];
  const l2d = await l2.json();
  ok('TOTP：验证码换到会话', l2.status === 200 && l2d.ok === true && /cfp_sid=/.test(ck), String(l2.status));
  const viaSess = await rawFetch(B + '/api/state', { headers: { Cookie: ck } });
  ok('TOTP：会话可直接访问', viaSess.status === 200, String(viaSess.status));
  const l3 = await rawFetch(B + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ challenge: l1d.challenge, code: '111111' }) });
  ok('TOTP：错误验证码不发会话', l3.status === 401, String(l3.status));
  const c2 = await (await rawFetch(B + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ user: USER, pass: PASS }) })).json();
  const l4 = await rawFetch(B + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ challenge: c2.challenge, code: recovery }) });
  const l4d = await l4.json();
  ok('TOTP：恢复码可登录且一次性', l4.status === 200 && l4d.usedRecovery === true, JSON.stringify(l4d).slice(0, 80));
  const st2 = await j('/api/state');
  ok('TOTP：恢复码用掉后余量 -1', st2.d.state.settings.totp.recoveryLeft === 9, String(st2.d.state.settings.totp.recoveryLeft));
  // 恢复码重新生成：错口令拒绝、对的可换一批
  const rw = await j('/api/totp/recovery', { method: 'POST', body: { code: '000000' } });
  ok('TOTP：错码不能重生成恢复码', rw.status === 400, String(rw.status));
  const rg = await j('/api/totp/recovery', { method: 'POST', body: { code: code() } });
  const newCodes = (rg.d && rg.d.recovery) || [];
  ok('TOTP：可重生成 10 个恢复码', rg.status === 200 && newCodes.length === 10 && newCodes[0] !== recovery, String(rg.status));
  const st2b = await j('/api/state');
  ok('TOTP：重生成后余量回到 10', st2b.d.state.settings.totp.recoveryLeft === 10, String(st2b.d.state.settings.totp.recoveryLeft));
  const l5 = await rawFetch(B + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ user: USER, pass: PASS }) });
  const l5d = await l5.json();
  const l6 = await rawFetch(B + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ challenge: l5d.challenge, code: newCodes[0] }) });
  ok('TOTP：新恢复码可登录', l6.status === 200, String(l6.status));

  const dis = await j('/api/totp/disable', { method: 'POST', body: { code: code() } });
  ok('TOTP：可关闭', dis.status === 200 && dis.d.ok === true, String(dis.status));
  const st3 = await j('/api/state');
  ok('TOTP：关闭后 enabled=false', st3.d.state.settings.totp.enabled === false);
}

// ========== 传输层：静态资源缓存 + JSON gzip + 通知重发 ==========
{
  // 静态资源不需要登录（登录页自己要加载 app.css）
  const anon = await rawFetch(B + '/assets/app.css', { headers: { 'Accept-Encoding': 'gzip' } });
  ok('静态资源可匿名访问', anon.status === 200, String(anon.status));
  const ac = anon.headers.get('cache-control') || '';
  const cdn = anon.headers.get('cloudflare-cdn-cache-control') || anon.headers.get('cdn-cache-control') || '';
  ok('静态资源带浏览器缓存头', /public/.test(ac) && /max-age=300/.test(ac), ac);
  ok('静态资源带边缘缓存头', /max-age=86400/.test(cdn), cdn);
  ok('静态资源 ETag 区分编码', /-gz"$|-id"$/.test(anon.headers.get('etag') || ''), anon.headers.get('etag') || '');

  // v0.13.3：带 ?v= 指纹的资源走「一年 immutable」，没指纹的仍是 300s
  const hashed = await fetch(B + '/assets/app.css?v=deadbeef');
  const hcc = hashed.headers.get('cache-control') || '';
  ok('指纹资源一年 immutable', /max-age=31536000/.test(hcc) && /immutable/.test(hcc), hcc);
  const plain = await fetch(B + '/assets/app.css');
  ok('无指纹资源仍是短缓存', /max-age=300/.test(plain.headers.get('cache-control') || ''), plain.headers.get('cache-control') || '');
  const loginHtml = await (await fetch(B + '/login')).text();
  ok('登录页资源引用带指纹', /app\.css\?v=[a-f0-9]{6,}/.test(loginHtml), (loginHtml.match(/app\.css\?v=[a-f0-9]+/) || [''])[0]);

  // v0.13.3：通知文案模板可保存并回读（占位符原样存，渲染在发送时做）
  const tplSave = await j('/api/settings', { method: 'POST', body: { notify: { template: { title: '[{event}] {host}', text: '{time} 在线 {running}/{total}' } } } });
  ok('通知模板可保存', tplSave.status === 200, String(tplSave.status));
  const tplState = await j('/api/state');
  const tpl = (tplState.d.state.settings.notify || {}).template || {};
  ok('通知模板回读正确', tpl.title === '[{event}] {host}' && tpl.text === '{time} 在线 {running}/{total}', JSON.stringify(tpl));
  const tplClear = await j('/api/settings', { method: 'POST', body: { notify: { template: { title: '', text: '' } } } });
  ok('通知模板可清空', tplClear.status === 200, String(tplClear.status));

  // v0.13.4：按规则聚合的流量趋势
  const tp = await j('/api/traffic/paths?hours=6&top=3');
  ok('按规则流量接口可用', tp.status === 200 && Array.isArray(tp.d.groups), `${tp.status} groups=${(tp.d.groups || []).length}`);
  ok('按规则流量不与「未匹配」混在一起', !(tp.d.groups || []).some((g) => g.name === '(未匹配规则)'), JSON.stringify((tp.d.groups || []).map((g) => g.name)));
  ok('按规则流量给出未匹配计数', tp.d.unmatched && typeof tp.d.unmatched.total === 'number', JSON.stringify(tp.d.unmatched || {}));
  const g0 = (tp.d.groups || [])[0];
  ok('按规则流量带规则 id（可点击跳转）', (tp.d.groups || []).every((g) => typeof g.id === 'string'), JSON.stringify((tp.d.groups || []).map((g) => g.id)));
  ok('按规则流量带每小时分桶', !g0 || (Array.isArray(g0.buckets) && g0.buckets.length === (tp.d.hours || 0)), String(g0 ? g0.buckets.length : 0));

  // v0.13.3：缓存预热接口（无命名隧道时给人话 400，不能 500）
  const warm = await j('/api/cf/cache/warm', { method: 'POST', body: {} });
  ok('预热接口可用', warm.status === 200 || warm.status === 400, `${warm.status} ${JSON.stringify(warm.d).slice(0, 80)}`);
  if (warm.status === 200) {
    const st2 = await j('/api/state');
    ok('预热后记录代码指纹（用于部署提醒）', !!(st2.d.state.warm && st2.d.state.warm.code), JSON.stringify(st2.d.state.warm || null).slice(0, 80));
  }

  // 页面绝不能被 CDN 缓存（里面有版本号、登录态）
  const page = await fetch(B + '/settings');
  ok('页面响应禁止 CDN 缓存', /no-store/.test(page.headers.get('cloudflare-cdn-cache-control') || ''), String(page.headers.get('cloudflare-cdn-cache-control')));

  // JSON 压缩：/api/state 明文 ~5KB，gzip 后应显著变小
  const gz = await rawFetch(B + '/api/state', { headers: { Authorization: basic, 'Accept-Encoding': 'gzip' } });
  const gzLen = Number(gz.headers.get('content-length') || 0);
  ok('大 JSON 响应走 gzip', /gzip/.test(gz.headers.get('content-encoding') || '') && gzLen > 0 && gzLen < 4800, `${gz.headers.get('content-encoding')} ${gzLen}B`);
}

{
  // 通知重发：没有地址 / 没有记录时给人话错误，不是 500
  const r = await j('/api/notify/resend', { method: 'POST', body: {} });
  ok('重发通知：无记录时 400 且有人话原因', r.status === 400 && /通知/.test(r.d.error || ''), `${r.status} ${r.d.error || ''}`);
  // 缓存规则：不管 token 有没有权限，接口都要给出结构化结果
  const cr = await j('/api/cf/cache/rule');
  ok('缓存规则：接口返回结构稳定', cr.status === 200 && typeof cr.d.ok === 'boolean' && Array.isArray(cr.d.rules), `${cr.status}`);
  const pg = await j('/api/cf/cache/purge', { method: 'POST', body: { urls: [] } });
  ok('清理缓存：未配置/无权限时 400 不崩', pg.status === 200 || pg.status === 400, String(pg.status));
}

// ========== 角色：operator / viewer ==========
{
  const setOp = await j('/api/operator', { method: 'POST', body: { user: 'qa-oper', pass: 'qapass123' } });
  ok('operator：账号可设置', setOp.status === 200 && setOp.d.ok === true, JSON.stringify(setOp.d).slice(0, 80));
  const OP = 'Basic ' + Buffer.from('qa-oper:qapass123').toString('base64');
  const gs = await rawFetch(B + '/api/state', { headers: { Authorization: OP } });
  ok('operator：能读状态', gs.status === 200, String(gs.status));
  const routesNow = (await j('/api/state')).d.state.routes;
  const wr = await rawFetch(B + '/api/routes', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: OP }, body: JSON.stringify({ routes: routesNow }) });
  ok('operator：能改规则', wr.status === 200, String(wr.status));
  const ws = await rawFetch(B + '/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: OP }, body: JSON.stringify({ panelTitle: 'x' }) });
  const wsd = await ws.json().catch(() => ({}));
  ok('operator：不能改设置（403 且说明原因）', ws.status === 403 && /权限/.test(wsd.error || ''), String(ws.status) + ' ' + (wsd.error || ''));
  const wp = await rawFetch(B + '/api/panel-auth', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: OP }, body: JSON.stringify({ user: USER, pass: 'hack12345' }) });
  ok('operator：不能改面板口令', wp.status === 403, String(wp.status));
  const wi = await rawFetch(B + '/api/import', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: OP }, body: '{}' });
  ok('operator：不能导入配置', wi.status === 403, String(wi.status));
  const wb = await rawFetch(B + '/api/backups/restore', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: OP }, body: JSON.stringify({ file: 'x.json' }) });
  ok('operator：不能回滚配置', wb.status === 403, String(wb.status));
  const rd = await rawFetch(B + '/api/state', { headers: { Authorization: 'Basic ' + Buffer.from('admin:wrongpass').toString('base64') } });
  ok('operator：不影响管理员口令', rd.status === 401, String(rd.status));
  ok('operator：仍可登录（Basic 可用）', (await rawFetch(B + '/api/tunnels', { headers: { Authorization: OP } })).status === 200);
  const au = await j('/api/audit?limit=20');
  const opRows = ((au.d && au.d.rows) || []).filter((r) => /运维/.test(r.actor || ''));
  ok('operator：审计里能认出「运维」身份', opRows.length > 0, JSON.stringify(opRows[0] || {}).slice(0, 90));
  const off = await j('/api/operator', { method: 'POST', body: { user: '', pass: '' } });
  ok('operator：可关闭', off.status === 200 && off.d.ok === true);
  const after = await rawFetch(B + '/api/state', { headers: { Authorization: OP } });
  ok('operator：关闭后该账号失效', after.status === 401, String(after.status));
}

// 清理临时探针规则
try {
  const cur = (await j('/api/state')).d.state.routes || [];
  const left = cur.filter((r) => r.id !== 'qa-probe');
  if (left.length !== cur.length) await j('/api/routes', { method: 'POST', body: { routes: left } });
} catch (e) { console.log('清理探针规则失败：' + e.message); }

console.log(`\n${pass}/${pass + fail} 通过`);
process.exit(fail ? 1 : 0);
