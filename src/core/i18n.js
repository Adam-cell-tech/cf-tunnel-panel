'use strict';
/**
 * 界面语言（中 / 英）
 *
 * 做法：字典是「中文原文 → 英文」，运行时按**精确文本**替换。
 * 好处是不用给几百个标签加 data-i18n，页面里写什么中文就翻什么；
 * 翻译不到的地方原样保留中文（宁可留白，也不要机器翻译乱来）。
 * 语言存在 cookie cfp_lang，服务端据此决定 <html lang> 与导航文案。
 */

const COOKIE = 'cfp_lang';
const LANGS = ['zh', 'en'];

const EN = {
  // 导航与外壳
  '总览': 'Overview',
  '概览': 'Overview',
  '隧道出口': 'Tunnels',
  '代理规则': 'Routes',
  '工具箱': 'Toolbox',
  '观测': 'Observability',
  '设置': 'Settings',
  '跳到主内容': 'Skip to content',
  '检测中…': 'Checking…',
  '旧版': 'Legacy',
  '退出': 'Sign out',
  '切换深色 / 浅色': 'Toggle dark / light',
  '打开命令面板': 'Open command palette',
  '退出登录': 'Sign out',
  '切换语言': 'Switch language',
  '登录': 'Sign in',
  '登录面板': 'Sign in to panel',
  '登录中…': 'Signing in…',
  '用户名': 'Username',
  '密码': 'Password',
  '用户名或密码不对': 'Wrong username or password',

  // 通用按钮/词
  '刷新': 'Refresh',
  '保存': 'Save',
  '保存设置': 'Save settings',
  '保存规则': 'Save routes',
  '取消': 'Cancel',
  '复制': 'Copy',
  '下载': 'Download',
  '删除': 'Delete',
  '添加': 'Add',
  '创建': 'Create',
  '创建并启动': 'Create & start',
  '启动': 'Start',
  '停止': 'Stop',
  '重启': 'Restart',
  '退出登录 ': 'Sign out ',
  '新建出口': 'New tunnel',
  '＋ 新建出口': '+ New tunnel',
  '全部启动': 'Start all',
  '全部停止': 'Stop all',
  '＋ 添加规则': '+ Add route',
  '从模板添加…': 'Add from template…',
  '粘贴导入': 'Paste & import',
  '导入到当前作用域': 'Import into this scope',
  '看命中哪条': 'Which rule matches?',
  '路径': 'Path',
  '上游': 'Upstream',
  '方法': 'Method',
  '备注名': 'Label',
  '域名（可留空）': 'Hostname (optional)',
  'Host / 域名': 'Host / hostname',
  '规则列表': 'Routes',
  '名字': 'Name',
  '模式': 'Mode',
  '上游地址': 'Upstream URL',
  '公网域名': 'Public hostname',
  '快速隧道（临时域名）': 'Quick tunnel (temp domain)',
  '命名隧道（自己的域名）': 'Named tunnel (own domain)',

  // 概览
  '流量趋势': 'Traffic',
  '出口在线历史': 'Tunnel uptime',
  '变更趋势': 'Changes',
  '最近日志': 'Recent logs',
  '快捷动作': 'Quick actions',
  '最近 6 小时': 'Last 6 hours',
  '最近 12 小时': 'Last 12 hours',
  '最近 24 小时': 'Last 24 hours',

  // 观测
  '访问统计': 'Access log',
  '审计日志': 'Audit log',
  '面板日志': 'Panel log',
  '自动刷新': 'Auto refresh',
  '全部状态': 'All statuses',
  '只看 2xx': 'Only 2xx',
  '只看 3xx': 'Only 3xx',
  '只看 4xx': 'Only 4xx',
  '只看 5xx': 'Only 5xx',
  '只看错误（4xx + 5xx）': 'Only errors (4xx + 5xx)',
  '只看错误': 'Only errors',
  '全部时间': 'All time',
  '最近 5 分钟': 'Last 5 min',
  '最近 1 小时': 'Last hour',
  '暂停': 'Pause',
  '继续': 'Resume',

  // 工具箱
  '本机 Docker 容器': 'Local Docker containers',
  '一次性分享链接': 'One-off share links',
  '生成链接': 'Create link',
  '有效分钟': 'Valid minutes',
  '链路自测': 'Chain self-test',
  '发请求': 'Send request',
  '测试 WebSocket 升级': 'Test WebSocket upgrade',
  '测速': 'Benchmark',
  '一键测速': 'Run benchmark',
  '下载大小': 'Size',
  '生成的 Caddy 配置': 'Generated Caddy config',
  '生成并查看': 'Generate & view',
  'Cloudflare API（可选）': 'Cloudflare API (optional)',
  '验证 Token / 拉账号与域名': 'Verify token / fetch account & zones',
  '保存 API 配置': 'Save API config',
  '刷新云端隧道': 'Refresh cloud tunnels',
  '新建隧道': 'Create tunnel',
  '隧道名字': 'Tunnel name',
  '绑定的域名（可留空）': 'Hostname (optional)',
  '顺带建 CNAME': 'Also create CNAME',
  '顺带在本机加一条出口': 'Also add local exit',
  '指向哪条隧道': 'Point to tunnel',
  '最近创建的那条': 'Most recently created',
  '按域名查记录': 'Look up records',

  // 设置
  '站点': 'Site',
  '面板标题': 'Panel title',
  'Caddy 监听地址': 'Caddy listen address',
  '未命中规则的 404 文案': '404 body for unmatched paths',
  '维护模式': 'Maintenance mode',
  '开启维护模式': 'Enable maintenance mode',
  '维护提示文案': 'Maintenance message',
  '安全': 'Security',
  '全局 IP 黑名单（逗号分隔，支持 CIDR）': 'Global IP blocklist (comma separated, CIDR ok)',
  '开启限流': 'Enable rate limit',
  '每秒请求数': 'Requests / second',
  '突发上限': 'Burst',
  '掉线通知': 'Notifications',
  'Webhook 地址': 'Webhook URL',
  '格式': 'Format',
  '通用 JSON': 'Generic JSON',
  '相同事件冷却（秒）': 'Cooldown (sec)',
  '静默时段': 'Quiet hours',
  '出口掉线': 'Tunnel down',
  '快速隧道换域名': 'Quick tunnel URL changed',
  'Caddy 下发失败': 'Caddy push failed',
  '发测试通知': 'Send test',
  '清空地址': 'Clear URL',
  '面板登录': 'Panel login',
  '用户名（留空 = 关闭鉴权）': 'Username (empty = disable auth)',
  '更新登录方式': 'Update credentials',
  '登录会话': 'Sessions',
  '踢掉其它设备': 'Sign out other devices',
  '账号': 'Account',
  '角色': 'Role',
  '来源 IP': 'Source IP',
  '设备': 'Device',
  '登录时间': 'Signed in',
  '最后活动': 'Last active',
  '只读账号': 'Read-only account',
  '只读用户名（留空 = 关闭）': 'Read-only user (empty = off)',
  '只读密码': 'Read-only password',
  '保存只读账号': 'Save read-only account',
  '通知发送记录': 'Notification history',
  '备份与回滚': 'Backups & rollback',
  '导入 / 导出': 'Import / export',
  '导出（脱敏）': 'Export (redacted)',
  '导出（含 token）': 'Export (with tokens)',
  '导入 JSON': 'Import JSON',
  '关于': 'About',
  '刷新系统信息': 'Refresh system info',

  // 状态词
  '运行中': 'Running',
  '已停止': 'Stopped',
  '启动中…': 'Starting…',
  '停止中…': 'Stopping…',
  '异常': 'Error',
  '全局': 'Global',
  '专属': 'Scoped',
  '管理员': 'Admin',
  '只读': 'Read-only',
  '当前': 'current',
};

function langOf(req) {
  const raw = String((req && req.headers && req.headers.cookie) || '');
  const m = raw.match(new RegExp(COOKIE + '=([^;]+)'));
  const v = m ? decodeURIComponent(m[1]).trim() : '';
  return LANGS.includes(v) ? v : 'zh';
}

/** chrome 服务端文案：中文原样返回，英文查表 */
function t(lang, zh) {
  return lang === 'en' ? (EN[zh] || zh) : zh;
}

/** 注入给前端用的字典（JSON 字面量） */
function clientDict() {
  return JSON.stringify(EN).replace(/</g, '\\u003c');
}

module.exports = { COOKIE, LANGS, EN, langOf, t, clientDict };
