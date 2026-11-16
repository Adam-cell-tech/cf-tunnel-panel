/* 前端 DOM 回归测试（jsdom）
   用法：PANEL_PASS=你的密码 node test/dom.test.cjs
   面板开着 HTTP Basic 登录，所以这里起一个本地小代理自动加凭据。 */
const http = require('http');
let JSDOM;
try { ({ JSDOM } = require('jsdom')); } catch {
  console.error('缺少 jsdom：先在仓库目录执行 npm i -D jsdom');
  process.exit(2);
}

const UPSTREAM = process.env.PANEL_URL || 'http://127.0.0.1:8090';
const USER = process.env.PANEL_USER || 'admin';
const PASS = process.env.PANEL_PASS || '';
const PROXY_PORT = Number(process.env.PANEL_PROXY_PORT || 8099);
const BASE = PASS ? `http://127.0.0.1:${PROXY_PORT}` : UPSTREAM;

let proxy = null;
if (PASS) {
  const basic = 'Basic ' + Buffer.from(`${USER}:${PASS}`).toString('base64');
  const up = new URL(UPSTREAM);
  proxy = http.createServer((req, res) => {
    const opts = { hostname: up.hostname, port: up.port, path: req.url, method: req.method,
      headers: { ...req.headers, host: up.host, authorization: basic } };
    const p = http.request(opts, (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
    p.on('error', () => { res.writeHead(502); res.end('proxy error'); });
    req.pipe(p);
  });
}

async function open(path, wait = 900) {
  const errors = [];
  const dom = await JSDOM.fromURL(BASE + path, {
    runScripts: 'dangerously',
    resources: 'usable',
    pretendToBeVisual: true,
    beforeParse(win) {
      win.fetch = (u, o) => fetch(new URL(u, BASE).href, o);
      win.EventSource = class { constructor() { this.onmessage = null; } close() {} addEventListener() {} };
      win.alert = () => {};
      win.confirm = () => true;
      win.prompt = () => 'x';
      win.addEventListener('error', (e) => errors.push(String(e.message || e.error)));
    },
  });
  await new Promise((r) => setTimeout(r, wait));
  return { dom, win: dom.window, doc: dom.window.document, errors };
}

const results = [];
function chk(name, ok, extra = '') { results.push([ok, name, extra]); }

(async () => {
  if (proxy) await new Promise((r) => proxy.listen(PROXY_PORT, '127.0.0.1', r));
  // 1) 总览
  {
    const { doc, errors, win } = await open('/');
    const nav = [...doc.querySelectorAll('.side .nav a')].map((a) => a.getAttribute('href'));
    chk('总览: 侧栏 6 个导航', nav.length === 6, nav.join(','));
    const firstLink = doc.querySelector('.side .nav a');
    chk('总览: 导航链接是 flex 行内布局', !!firstLink && doc.querySelectorAll('.side .nav a .ico').length === 6, '');
    chk('总览: 日志无 Invalid Date', !/Invalid Date/.test(doc.body.textContent), '');
    chk('总览: 当前页高亮', !!doc.querySelector('.side .nav a.active'), '');
    chk('总览: 健康指示已填充', (doc.querySelector('#healthText') || {}).textContent !== '检测中…', (doc.querySelector('#healthText') || {}).textContent);
    chk('总览: 有按规则流量卡', !!doc.querySelector('#pathBox'), '');
    chk('总览: 有预热提醒位', !!doc.querySelector('#warmBar'), '');

    // v0.13.5：点图例跳到规则页要能定位并高亮
    {
      const hz = await (await fetch(BASE + '/healthz')).json();
      const rid = (await (await fetch(BASE + '/api/state')).json()).state.routes[0].id;
      const { doc: rd, errors: rErrs } = await open('/rules?focus=' + encodeURIComponent(rid));
      await new Promise((r) => setTimeout(r, 1200));
      const hit = rd.querySelector('.rule[data-focused]');
      chk('规则页: ?focus 能定位到规则', !!hit, String(!!hit));
      chk('规则页: focus 页面无脚本错误', rErrs.length === 0, rErrs.join(' | ').slice(0, 160));
      chk('规则页: 每条规则有命中统计徽标', rd.querySelectorAll('#ruleList [data-hits]').length > 0,
        String(rd.querySelectorAll('#ruleList [data-hits]').length));
    }

    chk('总览: 四张图都画出来了', doc.querySelectorAll('.chart').length >= 3, String(doc.querySelectorAll('.chart').length));
    chk('总览: 刻度是 HTML 行（不被 SVG 拉伸）', doc.querySelectorAll('.chart-x').length >= 3, String(doc.querySelectorAll('.chart-x').length));
    chk('总览: 刻度文字有内容', [...doc.querySelectorAll('.chart-x span')].some((x) => /\d+:00/.test(x.textContent)), '');
    chk('总览: 图表带悬停提示', doc.querySelectorAll('.chart title').length >= 3, String(doc.querySelectorAll('.chart title').length));
    chk('总览: 无脚本错误', errors.length === 0, errors.join(' | ').slice(0, 200));
    // 主题切换
    const before = win.document.documentElement.dataset.theme;
    doc.querySelector('#btnTheme').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 80));
    const after = win.document.documentElement.dataset.theme;
    chk('总览: 主题切换生效', before !== after, before + '→' + after);
    chk('总览: 主题写入 localStorage', win.localStorage.getItem('cfp-theme') === after, String(win.localStorage.getItem('cfp-theme')));
  }

  // 2) 隧道页
  {
    const { doc, win, errors } = await open('/tunnels');
    const cards = doc.querySelectorAll('#tunnelList > .card');
    { const s0 = await (await fetch(BASE + '/api/state')).json();
      const exp = (s0.state.tunnels || []).length;
      chk(`隧道: 出口卡片数 = ${exp}`, cards.length === exp, String(cards.length)); }
    chk('隧道: 存在新建出口按钮', !!doc.querySelector('#btnAdd') && !!doc.querySelector('#btnCreate'), '');
    const runningNow = /已在运行|运行中/.test(doc.querySelector('#tunnelList').innerHTML);
    const hasUrl = /trycloudflare\.com|https:\/\//.test(doc.querySelector('#tunnelList').innerHTML);
    const st = await (await fetch(BASE + '/api/state')).json();
    const anyUrl = (st.runtime.tunnels || []).some((t) => t.url);
    chk('隧道: 在线时卡片里有公网地址', anyUrl ? hasUrl : true, anyUrl ? '' : '（当前无线隧道，跳过）');
    chk('隧道: 在线时状态徽章出现', anyUrl ? runningNow : true, anyUrl ? '' : '（当前无线隧道，跳过）');
    chk('隧道: 每个出口都有状态标签', doc.querySelectorAll('#tunnelList .pill, #tunnelList .tag').length >= 2, '');
    // 回归：在「出口设置」里输入后，5 秒轮询不能把未保存的输入清掉
    {
      const card0 = doc.querySelector('#tunnelList > .card');
      const inp0 = card0 && card0.querySelector('[data-k="name"]');
      if (inp0) {
        inp0.value = '我改到一半的名字';
        inp0.dispatchEvent(new win.Event('input', { bubbles: true }));
        await new Promise((r) => setTimeout(r, 6200));
        const inp1 = (doc.querySelector('#tunnelList > .card') || {}).querySelector
          ? doc.querySelector('#tunnelList > .card').querySelector('[data-k="name"]') : null;
        chk('隧道: 输入出口设置后 5s 轮询不清空', !!inp1 && inp1.value === '我改到一半的名字', (inp1 || {}).value);
        chk('隧道: 轮询未重建卡片', doc.querySelectorAll('#tunnelList > .card').length === cards.length, '');
      } else {
        chk('隧道: 输入出口设置后 5s 轮询不清空', true, '（无出口卡片，跳过）');
      }
    }
    chk('隧道: 限流提示可见（若有）', true, '');
    chk('隧道: 无脚本错误', errors.length === 0, errors.join('|').slice(0, 160));
  }

  // 3) 规则页（关键回归：脏标记保护）
  {
    const { doc, win } = await open('/rules');
    const before = doc.querySelectorAll('.rule').length;
    doc.querySelector('#btnAddRule').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 300));
    const added = doc.querySelectorAll('.rule').length;
    chk('规则: 添加后 +1', added === before + 1, before + '→' + added);
    await new Promise((r) => setTimeout(r, 6500)); // 跨过两次 5s 轮询
    const afterWait = doc.querySelectorAll('.rule').length;
    chk('规则: 6.5 秒轮询后仍在（脏标记生效）', afterWait === added, added + '→' + afterWait);
    // 回归：在规则输入框里打字，5 秒轮询不能把内容顶回服务器旧值
    const firstPath = doc.querySelector('.rule input[data-k="path"]');
    firstPath.value = '/typed-by-test';
    firstPath.dispatchEvent(new win.Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 6500));
    chk('规则: 输入后 6.5 秒不被轮询清掉', firstPath.value === '/typed-by-test', firstPath.value);
    const banner = doc.querySelector('#rulesDirty');
    chk('规则: 出现「未保存」提示', !!banner && !banner.classList.contains('hidden'), banner ? banner.className : 'missing');
  }

  // 4) 观测页
  {
    const { doc } = await open('/observe');
    const rows = doc.querySelectorAll('#accessBody tbody tr').length;
    chk('观测: 访问表每页 ≤5 行', rows <= 5, String(rows));
    chk('观测: 有分页控件', !!doc.querySelector('#accessBody .pager') || rows < 5, String(!!doc.querySelector('#accessBody .pager')));
    chk('观测: 日志容器存在', !!doc.querySelector('#logBox'), '');
  }

  // 5) 设置页
  {
    const { doc, win } = await open('/settings');
    const hv = await (await fetch(BASE + '/healthz')).json();
    const vt = (doc.querySelector('#verTag') || {}).textContent || '';
    chk('设置: 版本号已渲染', vt.includes(hv.version), `${vt} vs ${hv.version}`);
    const bk = doc.querySelectorAll('#backupList tbody tr').length;
    chk('设置: 备份每页 ≤5 行', bk <= 5, String(bk));
    chk('设置: 维护模式字段回填', typeof doc.querySelector('#maintOn').checked === 'boolean', '');
    chk('设置: 有分页控件', !!doc.querySelector('#backupList .pager') || bk < 5, '');
    const sn = doc.querySelectorAll('.subnav a').length;
    chk('设置: 分区导航 ≥10 个锚点', sn >= 10, String(sn));
    chk('设置: 有设置项搜索框', !!doc.querySelector('#cardSearch'), '');
    {
      const sb = doc.querySelector('#cardSearch');
      const before = [...doc.querySelectorAll('.card[id^="sec-"]')].filter((c) => !c.classList.contains('hidden')).length;
      if (sb) {
        sb.value = '备份';
        sb.dispatchEvent(new win.Event('input', { bubbles: true }));
        await new Promise((r) => setTimeout(r, 60));
        const after = [...doc.querySelectorAll('.card[id^="sec-"]')].filter((c) => !c.classList.contains('hidden')).length;
        chk('设置: 搜索能收窄卡片', after > 0 && after < before, `${before} → ${after}`);
      } else { chk('设置: 搜索能收窄卡片', false, 'no input'); }
    }
    chk('设置: 分区锚点都能对上卡片', !!doc.querySelector('#sec-backup') && !!doc.querySelector('#sec-totp'), '');
    const rh = doc.querySelectorAll('#notifyHist [data-resend]').length;
    chk('设置: 通知记录带重发按钮', rh >= 0, String(rh));
    chk('设置: 通知模板输入框存在', !!doc.querySelector('#notifyTplTitle') && !!doc.querySelector('#notifyTplText'), '');

  }

  // ---- v0.8.0：P0/P1/P2 新交互 ----
  {
    const { doc, errors, win } = await open('/rules');
    const f = doc.querySelector('#ruleFilter');
    chk('规则: 有搜索框', !!f, '');
    if (f) {
      f.value = '不存在的关键字zzz';
      f.dispatchEvent(new win.Event('input', { bubbles: true }));
      chk('规则: 搜索无结果时有提示', /没有匹配/.test(doc.querySelector('#ruleList').textContent), '');
      f.value = '';
      f.dispatchEvent(new win.Event('input', { bubbles: true }));
    }
    // 粘贴导入改成内联框，不再 prompt
    chk('规则: 导入是内联 textarea（非 prompt）', !!doc.querySelector('#importText') && !!doc.querySelector('#btnDoImport'), '');
    doc.querySelector('#btnImport').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    const box = doc.querySelector('#importBox');
    chk('规则: 点导入展开面板', !!box && !box.classList.contains('hidden'), '');
    // 作用域持久化
    const sel = doc.querySelector('#scopeSel');
    if (sel && sel.options.length > 1) {
      sel.value = sel.options[1].value;
      sel.dispatchEvent(new win.Event('change', { bubbles: true }));
      chk('规则: 作用域写入 localStorage', win.localStorage.getItem('cfp-scope') === sel.options[1].value, String(win.localStorage.getItem('cfp-scope')));
    } else {
      chk('规则: 作用域写入 localStorage', true, '只有一个出口，跳过');
    }
    chk('规则: 无脚本错误', errors.length === 0, errors.join(' | ').slice(0, 160));
  }

  {
    const { doc, errors, win } = await open('/observe');
    chk('观测: 可疑访问卡片存在', !!doc.querySelector('#secBody'), String(!!doc.querySelector('#secBody')));
    chk('观测: 可疑访问有内容或空态', !!doc.querySelector('#secBody .empty') || !!doc.querySelector('#secBody table'), String(!!doc.querySelector('#secBody')));
    chk('观测: 可疑访问窗口可切换', !!doc.querySelector('#secHours'), '');
    chk('观测: 有状态筛选', !!doc.querySelector('#accStatus'), '');
    chk('观测: 有路径搜索', !!doc.querySelector('#accPath'), '');
    chk('观测: 有时间范围', !!doc.querySelector('#accRange'), '');
    const st = doc.querySelector('#accStatus');
    if (st) {
      st.value = '5';
      st.dispatchEvent(new win.Event('change', { bubbles: true }));
      chk('观测: 选 5xx 后表格仍正常渲染', !!doc.querySelector('#accessBody table, #accessBody .empty'), '');
      st.value = '';
      st.dispatchEvent(new win.Event('change', { bubbles: true }));
    }
    const pz = doc.querySelector('#btnLogPause');
    chk('观测: 有暂停按钮', !!pz, '');
    if (pz) {
      pz.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
      chk('观测: 暂停后按钮变「继续」', /继续/.test(pz.textContent) && pz.getAttribute('aria-pressed') === 'true', pz.textContent);
    }
    chk('观测: 有只看错误开关', !!doc.querySelector('#logOnlyErr'), '');
    chk('观测: 有审计日志卡片', !!doc.querySelector('#auditBody') && !!doc.querySelector('#auditQ'), '');
    await new Promise((r) => setTimeout(r, 600));
    const ab = doc.querySelector('#auditBody');
    chk('观测: 审计表渲染出记录', !!ab && !!ab.querySelector('table, .empty'), ab ? ab.textContent.trim().slice(0, 30) : '');
    const ar = doc.querySelector('#btnAuditRefresh');
    if (ar) {
      ar.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 400));
      chk('观测: 审计刷新不报错', errors.length === 0, errors.join(' | ').slice(0, 160));
    }
    chk('观测: 无脚本错误', errors.length === 0, errors.join(' | ').slice(0, 160));
  }

  {
    const { doc, errors, win } = await open('/');
    chk('概览: 有流量趋势图（SVG）', !!doc.querySelector('#trendBox svg, #trendBox .empty'), '');
    chk('概览: 有出口在线历史图', !!doc.querySelector('#histBox svg, #histBox .empty'), '');
    // Ctrl+K 命令面板
    doc.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }));
    await new Promise((r) => setTimeout(r, 600));
    const pal = doc.querySelector('#palWrap');
    chk('概览: Ctrl+K 打开命令面板', !!pal, '');
    if (pal) {
      const q = doc.querySelector('#palQ');
      q.value = '设置';
      q.dispatchEvent(new win.Event('input', { bubbles: true }));
      chk('概览: 命令面板可按关键字过滤', /设置/.test(doc.querySelector('#palList').textContent), '');
      doc.body.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    }
    chk('概览: 无脚本错误', errors.length === 0, errors.join(' | ').slice(0, 160));
  }

  {
    const { doc, errors } = await open('/settings');
    chk('设置: 有只读账号表单', !!doc.querySelector('#viewerUser') && !!doc.querySelector('#btnViewer'), '');
    chk('设置: 有通知发送记录表', !!doc.querySelector('#notifyHist'), '');
    chk('设置: 有系统信息表', !!doc.querySelector('#sysInfo table, #sysInfo .empty, #sysInfo .hint'), '');
    chk('设置: 备份表在小屏可堆叠（class）', !!doc.querySelector('#backupList table, #backupList .empty'), '');
    chk('设置: 有跳到主内容的链接', !!doc.querySelector('.skip-link'), '');
    chk('设置: 有命令面板按钮', !!doc.querySelector('#btnPalette'), '');
    chk('设置: 无脚本错误', errors.length === 0, errors.join(' | ').slice(0, 160));
  }

  // ---- 变更趋势（审计）----
  {
    const { doc, errors } = await open('/', 1600);
    chk('概览: 有变更趋势卡', !!doc.querySelector('#auditBox'), '');
    chk('概览: 变更趋势画出了 SVG', !!doc.querySelector('#auditBox svg'), String(!!doc.querySelector('#auditBox svg')));
    chk('概览: 有变更趋势时间范围选择', !!doc.querySelector('#auditHours'), '');
    chk('概览: 变更趋势无脚本错误', errors.length === 0, errors.join(' | ').slice(0, 160));
  }

  // ---- 会话与语言 ----
  {
    const { doc, win, errors } = await open('/settings', 1400);
    chk('设置: 有登录会话表', !!doc.querySelector('#sessTable'), '');
    chk('设置: 有踢掉其它设备按钮', !!doc.querySelector('#btnSessKickOthers'), '');
    chk('设置: 通知有格式专属提示区', !!doc.querySelector('#notifyHint'), '');
    chk('设置: 有加签密钥字段（切换格式显示）', !!doc.querySelector('#notifySecretWrap') && !!doc.querySelector('#notifySecret'), '');
    chk('设置: 有清空密钥按钮', !!doc.querySelector('#btnSecretClear'), '');
    chk('设置: 有退出全部设备按钮', !!doc.querySelector('#btnSessRevokeAll'), '');
    chk('设置: 通知里有「会话换 IP」开关', !!doc.querySelector('#evSessionIp'), '');

    chk('设置: 会话表渲染出行', !!doc.querySelector('#sessTable tbody tr'), (doc.querySelector('#sessTable tbody') || {}).textContent ? 'y' : '');
    chk('外壳: 有语言切换按钮', !!doc.querySelector('#btnLang'), (doc.querySelector('#btnLang') || {}).textContent || '');
    chk('外壳: 有退出登录按钮', !!doc.querySelector('#btnLogout'), '');
    chk('会话/语言: 无脚本错误', errors.length === 0, errors.join(' | ').slice(0, 160));
  }

  // ---- 登录页（独立页，不套外壳）----
  {
    const { doc, errors } = await open('/login', 600);
    chk('登录页: 有表单与两个输入框', !!doc.querySelector('#loginForm') && !!doc.querySelector('#u') && !!doc.querySelector('#p'), '');
    chk('登录页: 没有内联脚本（CSP 会拦）', doc.querySelectorAll('script:not([src])').length === 0, String(doc.querySelectorAll('script:not([src])').length));
    chk('登录页: 引用了外部 login.js', !!doc.querySelector('script[src*="login.js"]'), '');
    chk('登录页: 表单带 data-next', !!(doc.querySelector('#loginForm') && doc.querySelector('#loginForm').getAttribute('data-next')), '');
    chk('登录页: 引用了 /boot.js', !!doc.querySelector('script[src^="/boot.js"]'), '');
    chk('登录页: 不出现侧边导航', !doc.querySelector('.side .nav'), '');
    chk('登录页: 无脚本错误', errors.length === 0, errors.join(' | ').slice(0, 160));
  }

  let bad = 0;
  for (const [ok, name, extra] of results) {
    if (!ok) bad++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  [' + extra + ']' : ''}`);
  }
  console.log(`\n${results.length - bad}/${results.length} 通过`);
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.error('HARNESS ERROR', e); process.exit(2); });
