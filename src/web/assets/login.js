/* 登录页脚本（必须在外部文件里：CSP script-src 'self' 会拦掉内联脚本） */
(function () {
  var f = document.getElementById('loginForm');
  var err = document.getElementById('err');
  var rem = document.getElementById('rem');
  if (err.textContent) err.classList.remove('hidden');
  f.addEventListener('submit', async function (e) {
    e.preventDefault();
    err.classList.add('hidden');
    var btn = f.querySelector('button');
    btn.disabled = true; var old = btn.textContent; btn.textContent = '登录中…';
    try {
      var tw = document.getElementById('tWrap');
      var tIn = document.getElementById('t');
      var need = tw && !tw.classList.contains('hidden');
      var payload = need
        ? { challenge: f.dataset.challenge, code: tIn.value, remember: rem.checked }
        : { user: document.getElementById('u').value, pass: document.getElementById('p').value, remember: rem.checked };
      var r = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'cfp' }, body: JSON.stringify(payload) });
      var d = await r.json().catch(function () { return {}; });
      if (d && d.needTotp) {
        f.dataset.challenge = d.challenge;
        tw.classList.remove('hidden');
        tIn.focus();
        btn.disabled = false; btn.textContent = '下一步';
        document.getElementById('u').readOnly = true;
        document.getElementById('p').readOnly = true;
        return;
      }
      if (r.ok && d.ok) { location.href = f.getAttribute('data-next') || '/'; return; }
      err.textContent = d.error || '登录失败';
      err.classList.remove('hidden');
      btn.disabled = false; btn.textContent = old;
    } catch (x) {
      err.textContent = '网络错误：' + x.message;
      err.classList.remove('hidden');
    }
    btn.disabled = false; btn.textContent = old;
  });
})();
