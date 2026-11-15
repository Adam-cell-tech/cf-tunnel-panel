/**
 * 真 Caddy 端到端：证明「面板下发的配置真的能被 Caddy 接受，并且真的能转发」。
 *
 * 为什么需要：其它测试都不启动 Caddy，`buildCaddyConfig()` 生成的东西对不对、
 * 字段名有没有拼错（比如 load_balancing.selection vs selection_policy），只有真加载才知道。
 * 这个脚本跑在 CI 里，用 docker 起一个 caddy:2.11.9-alpine。
 *
 * 用法：CADDY_ADMIN=http://127.0.0.1:20190 PANEL_URL=http://127.0.0.1:8090 node test/e2e-caddy.mjs
 */
const B = process.env.PANEL_URL || 'http://127.0.0.1:8090';
const USER = process.env.PANEL_USER || 'admin';
const PASS = process.env.PANEL_PASS || '';
const basic = 'Basic ' + Buffer.from(`${USER}:${PASS}`).toString('base64');
const CURL_PORT = Number(process.env.CADDY_PORT || 8080);
let pass = 0, fail = 0;
const ok = (n, c, x = '') => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${x ? '  [' + x + ']' : ''}`); };
const j = async (p, o = {}) => {
  const init = { ...o, headers: { 'Content-Type': 'application/json', Authorization: basic, ...(o.headers || {}) } };
  if (init.body && typeof init.body !== 'string') init.body = JSON.stringify(init.body);
  const r = await fetch(B + p, init);
  return { status: r.status, d: await r.json().catch(() => ({})) };
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const st = await j('/api/state');
ok('面板可达', st.status === 200, String(st.status));
ok('Caddy 已就绪', !!(st.d.runtime && st.d.runtime.caddy && st.d.runtime.caddy.ok), JSON.stringify(st.d.runtime && st.d.runtime.caddy));

// 起一个最小上游（用面板自己的 /healthz 当目标就够了）
// 注意：这个脚本会临时改写线上规则表，必须先把原始规则落一份到磁盘，
// 无论成功失败都要在 finally 里还原 —— 否则一次中途崩溃就会把线上规则清空。
import { writeFileSync, readFileSync, unlinkSync } from 'node:fs';
const SNAP = '/tmp/e2e-routes-snapshot.json';
const routes0 = st.d.state.routes || [];
writeFileSync(SNAP, JSON.stringify(routes0));
const restore = async () => {
  try { await j('/api/routes', { method: 'POST', body: { routes: JSON.parse(readFileSync(SNAP, 'utf8')) } }); unlinkSync(SNAP); } catch (e) { console.log('还原规则失败：' + e.message); }
};
process.on('exit', (c) => { if (c !== 0) console.log('⚠️ 非正常退出，规则可能仍在探针状态，用 /api/backups 回滚'); });
const probe = { id: 'e2e-probe', name: 'E2E 探针', path: '/e2e', host: '', upstream: `http://127.0.0.1:${new URL(B).port}`, strip: true, tunnelId: '', enabled: true };
const setR = await j('/api/routes', { method: 'POST', body: { routes: [probe, ...routes0.filter((r) => r.id !== 'e2e-probe')] } });
ok('下发配置被 Caddy 接受', setR.status === 200 && setR.d.caddy && setR.d.caddy.ok, JSON.stringify(setR.d.caddy || setR.d));
await sleep(400);

const got = await fetch(`http://127.0.0.1:${CURL_PORT}/e2e/healthz`).catch((e) => ({ status: 0, err: e.message }));
const body = got.status ? await got.text() : '';
ok('经 Caddy 转发成功（/e2e/healthz）', got.status === 200 && body.includes('"ok"'), `status=${got.status} body=${String(body).slice(0, 60)}`);

const miss = await fetch(`http://127.0.0.1:${CURL_PORT}/nope-${Date.now()}`).catch(() => ({ status: 0 }));
ok('未命中规则返回 404', miss.status === 404, String(miss.status));

const cfg = await j('/api/caddy/config');
const conf = JSON.stringify(cfg.d.config || {});
ok('生成的配置里 admin 端口跟 CADDY_ADMIN', !conf.includes('127.0.0.1:2019"'), '');
ok('生成的配置带 access log writer', conf.includes('"writer"') && conf.includes('access.log'));

// 清理：用快照还原（不依赖当前 state，避免把自己写坏）
await restore();
const restored = (await j('/api/state')).d.state.routes.length;
ok('还原规则表', restored === routes0.length, `${restored} vs ${routes0.length}`);

console.log(`\n${pass}/${pass + fail} 通过`);
process.exit(fail ? 1 : 0);
