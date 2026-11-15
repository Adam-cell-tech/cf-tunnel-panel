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
for (const p of ['/metrics', '/badge.svg', '/legacy']) {
  const r = await fetch(B + p);
  ok(`${p} 200`, r.status === 200, String(r.status));
}
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

const bad = await j('/api/match', { method: 'POST', body: { path: '/site/x', host: 'nope.invalid', method: 'GET' } });
ok('模拟匹配：专属出口规则不会串到别的域名', !(bad.d.matched && bad.d.rule && bad.d.rule.path === '/site'), (bad.d.rule || {}).path || 'no-match');

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

// 清理临时探针规则
try {
  const cur = (await j('/api/state')).d.state.routes || [];
  const left = cur.filter((r) => r.id !== 'qa-probe');
  if (left.length !== cur.length) await j('/api/routes', { method: 'POST', body: { routes: left } });
} catch (e) { console.log('清理探针规则失败：' + e.message); }

console.log(`\n${pass}/${pass + fail} 通过`);
process.exit(fail ? 1 : 0);
