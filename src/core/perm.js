'use strict';
/**
 * 角色权限矩阵：admin / operator / viewer。
 *
 * viewer   —— 只读（所有 GET/HEAD）。
 * operator —— 日常运维：能改隧道、规则、分享、维护模式，能看全部状态；
 *             **不能**碰凭证类（Cloudflare token、通知地址、面板口令、只读/运维账号、TOTP）、
 *             不能导入/回滚整套配置、不能踢别人的会话。
 * admin    —— 全部。
 *
 * 白名单式：operator 只能命中列出的写接口，新增接口默认对它关闭（漏配 = 更安全）。
 */

const OPERATOR_WRITE = [
  /^\/api\/tunnels(\/|$)/,
  /^\/api\/tunnel(\/|$)/,
  /^\/api\/routes$/,
  /^\/api\/shares(\/|$)/,
  /^\/api\/curl$/,
  /^\/api\/ws-test$/,
  /^\/api\/security\/(deny|allow)$/,
  /^\/api\/rules\/test$/,
  /^\/api\/match$/,
  /^\/api\/bench\/local$/,
  /^\/api\/qr$/,
  /^\/api\/logs\//,
  /^\/api\/cf\/tunnels\/[^/]+\/(hostnames|ingress)(\/|$)/,
  /^\/api\/logout$/,
];

/** 只有 admin 能改的东西（写进提示里，让人知道为什么被拒）。 */
const ADMIN_ONLY_HINT = {
  '/api/settings': '通知地址、Cloudflare 凭证、维护模式这些属于管理员设置',
  '/api/panel-auth': '面板口令只有管理员能改',
  '/api/viewer': '只读账号只有管理员能管理',
  '/api/operator': '运维账号只有管理员能管理',
  '/api/totp': '二次验证只有管理员能改',
  '/api/import': '整套配置导入只有管理员能做',
  '/api/cf': 'Cloudflare 凭证相关操作只有管理员能做',
  '/api/sessions': '踢别人的会话只有管理员能做',
};

function check(role, method, pathname) {
  const m = String(method || 'GET').toUpperCase();
  const p = String(pathname || '/').split('?')[0];
  if (role === 'admin' || !role) return { ok: true };
  if (m === 'GET' || m === 'HEAD') return { ok: true };
  if (role === 'viewer') return { ok: false, error: '当前是只读账号，不能修改任何配置', code: 'readonly' };
  // operator
  if (/^\/api\/backups\/restore$/.test(p)) return { ok: false, error: '回滚整套配置只有管理员能做', code: 'admin_only' };
  if (OPERATOR_WRITE.some((re) => re.test(p))) return { ok: true };
  const base = Object.keys(ADMIN_ONLY_HINT).find((k) => p === k || p.startsWith(k + '/'));
  return { ok: false, error: base ? `没有权限：${ADMIN_ONLY_HINT[base]}` : '当前角色没有这个操作的权限', code: 'admin_only' };
}

module.exports = { check, OPERATOR_WRITE, ADMIN_ONLY_HINT };
