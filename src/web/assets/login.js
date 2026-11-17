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
  var uField = document.getElementById('uField');
  var pField = document.getElementById('pField');
  var uErr = document.getElementById('uErr');
  var pErr = document.getElementById('pErr');
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

  /* 字段级错误：输入框红描边 + 下方 12px 红字，改输入就清掉 */
  function setFieldError(field, box, msg) {
    if (!field || !box) return;
    if (msg) {
      field.classList.add('bad');
      box.textContent = msg;
      box.classList.remove('hidden');
      var inp = field.querySelector('input');
      if (inp) inp.setAttribute('aria-invalid', 'true');
    } else {
      field.classList.remove('bad');
      box.textContent = '';
      box.classList.add('hidden');
      var inp2 = field.querySelector('input');
      if (inp2) inp2.removeAttribute('aria-invalid');
    }
  }
  function clearErrors() {
    setFieldError(uField, uErr, '');
    setFieldError(pField, pErr, '');
    err.classList.add('hidden');
    err.textContent = '';
  }
  [u, p].forEach(function (el) {
    if (!el) return;
    el.addEventListener('input', function () {
      if (el === u) setFieldError(uField, uErr, '');
      if (el === p) setFieldError(pField, pErr, '');
    });
  });

  /* 进入二次验证那一步：锁住账号密码、把焦点给验证码 */
  function toTotp(challenge) {
    f.dataset.challenge = challenge || '';
    tw.classList.remove('hidden');
    tIn.focus();
    submit.textContent = t('下一步');
    u.readOnly = true;
    p.readOnly = true;
    uField.classList.add('muted');
    pField.classList.add('muted');
  }

  f.addEventListener('submit', async function (e) {
    e.preventDefault();
    clearErrors();
    submit.disabled = true;
    var old = submit.textContent;
    var need = tw && !tw.classList.contains('hidden');
    submit.textContent = t('登录中…');
    try {
      var payload = need
        ? { challenge: f.dataset.challenge, code: tIn.value, remember: rem && rem.checked }
        : { user: u.value, pass: p.value, remember: rem && rem.checked };
      var r = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'cfp' },
        body: JSON.stringify(payload)
      });
      var d = await r.json().catch(function () { return {}; });
      if (d && d.needTotp) { toTotp(d.challenge); submit.disabled = false; submit.textContent = t('下一步'); return; }
      if (r.ok && d.ok) { location.href = f.getAttribute('data-next') || '/'; return; }
      var msg = d.error || t('登录失败');
      /* 账号/口令类错误落在对应字段上，其余（限流、网络）走整体提示 */
      if (!need && r.status === 401) {
        setFieldError(pField, pErr, msg);
        p.focus(); p.select();
      } else if (r.status === 429) {
        err.textContent = msg;
        err.classList.remove('hidden');
      } else if (need) {
        err.textContent = msg;
        err.classList.remove('hidden');
        tIn.select(); tIn.focus();
      } else {
        setFieldError(uField, uErr, msg);
        u.focus();
      }
    } catch (x) {
      err.textContent = t('网络错误：') + x.message;
      err.classList.remove('hidden');
    }
    submit.disabled = false;
    if (submit.textContent === t('登录中…')) submit.textContent = need ? t('下一步') : old;
  });
})();
