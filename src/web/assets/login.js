/* 登录页脚本（必须在外部文件里：CSP script-src 'self' 会拦掉内联脚本） */
(function () {
  var DICT = window.__CFP_DICT || {};
  function t(k) { return DICT[k] || k; }

  var f = document.getElementById('loginForm');
  var err = document.getElementById('err');
  var rem = document.getElementById('rem');
  var u = document.getElementById('u');
  var p = document.getElementById('p');
  var tw = document.getElementById('tWrap');
  var tIn = document.getElementById('t');
  var submit = f.querySelector('button[type="submit"]');
  if (err.textContent) err.classList.remove('hidden');

  /* 深浅色：跟侧栏那个按钮共用 localStorage 的 cfp-theme */
  try {
    var saved = localStorage.getItem('cfp-theme');
    var sysLight = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches;
    document.documentElement.setAttribute('data-theme', saved || (sysLight ? 'light' : 'dark'));
  } catch (e) { /* 隐私模式下 localStorage 会抛错，忽略 */ }
  var btnTheme = document.getElementById('btnTheme');
  if (btnTheme) {
    btnTheme.addEventListener('click', function () {
      var next = document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
      document.documentElement.setAttribute('data-theme', next);
      try { localStorage.setItem('cfp-theme', next); } catch (e) {}
    });
  }

  /* 语言切换：写 cookie 后重载（服务端据此渲染整页文案） */
  var btnLang = document.getElementById('btnLang');
  if (btnLang) {
    btnLang.addEventListener('click', function () {
      var cur = (document.documentElement.getAttribute('lang') || 'zh').toLowerCase();
      var nextLang = cur.indexOf('en') === 0 ? 'zh' : 'en';
      document.cookie = 'cfp_lang=' + nextLang + ';path=/;max-age=31536000;SameSite=Lax';
      location.reload();
    });
  }

  /* 显示/隐藏密码 */
  var btnReveal = document.getElementById('btnReveal');
  if (btnReveal && p) {
    btnReveal.addEventListener('click', function () {
      var show = p.getAttribute('type') === 'password';
      p.setAttribute('type', show ? 'text' : 'password');
      btnReveal.setAttribute('aria-pressed', show ? 'true' : 'false');
      btnReveal.setAttribute('aria-label', t(show ? '隐藏密码' : '显示密码'));
      p.focus();
    });
  }

  /* 进入二次验证那一步：锁住账号密码、把焦点给验证码 */
  function toTotp(challenge) {
    f.dataset.challenge = challenge || '';
    tw.classList.remove('hidden');
    tIn.focus();
    submit.textContent = t('下一步');
    u.readOnly = true;
    p.readOnly = true;
    u.parentElement.classList.add('muted');
    p.parentElement.classList.add('muted');
  }

  f.addEventListener('submit', async function (e) {
    e.preventDefault();
    err.classList.add('hidden');
    submit.disabled = true;
    var old = submit.textContent;
    var need = tw && !tw.classList.contains('hidden');
    submit.textContent = t('登录中…');
    try {
      var payload = need
        ? { challenge: f.dataset.challenge, code: tIn.value, remember: rem.checked }
        : { user: u.value, pass: p.value, remember: rem.checked };
      var r = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'cfp' },
        body: JSON.stringify(payload)
      });
      var d = await r.json().catch(function () { return {}; });
      if (d && d.needTotp) { toTotp(d.challenge); submit.disabled = false; return; }
      if (r.ok && d.ok) { location.href = f.getAttribute('data-next') || '/'; return; }
      err.textContent = d.error || t('登录失败');
      err.classList.remove('hidden');
      if (need) { tIn.select(); tIn.focus(); }
    } catch (x) {
      err.textContent = t('网络错误：') + x.message;
      err.classList.remove('hidden');
    }
    submit.disabled = false;
    submit.textContent = need ? t('下一步') : old;
  });
})();
