# Changelog

按日期倒序。功能细节与实测数据见 [docs/ROADMAP.md](docs/ROADMAP.md)。

## v0.11.2

- **口令只存 bcrypt 哈希**：`state.json` 里 `panel.pass` / `viewer.pass` 改为 `$2b$10$…`；启动时自动把历史明文迁移成哈希（`migrate-secrets`）。
- **Basic 凭据缓存**：bcrypt 每次校验在本机 ARM 上约 170ms，成功凭据缓存 10 分钟后同页面加载从 5.8s 回到 <1s；改口令即时清空缓存。
- **代码指纹**：新增 `tools/codehash.js` + `src/core/ident.js`，`/healthz` 增加 `code` / `imageCode` / `sha` / `drift`；`Dockerfile` 构建时写 `.code-hash`，热替换代码会被识别成 `drift: true`。
- **修 core 模块冗余 require**：清理 121 条复制残留（先前误删 `SEC_HEADERS` 导致页面 500，已用更稳的匹配规则重做）。
- **修 v0.9.0 拆分埋下的真 bug**：`monitor.js` 对解构来的常量做 `histTick += 1`，每 5 秒抛 `Assignment to constant variable`，导致出口状态采样/掉线通知/历史采样自拆分起从未运行；改为模块内 `let histTick`。
- `package.json` 增加 `engines.node >= 20`。
- 测试：API 113、DOM 75。

## v0.12.0

**面板从「配置页」变成「小运维台」：会话登录、踢设备、单实例锁、主机名管理、按规则统计、更多告警、PWA、YAML 导出、GHCR 镜像。**

### 新增
- 会话登录：cookie `cfp_sid`（HttpOnly / SameSite=Lax）、记住我 30 天、空闲 12 小时过期；会话落盘 `data/sessions.json`（只存 cookie 值的 SHA-256），重启不掉线。
- 设置 → 登录会话：列出会话（IP / UA / 最后活跃 / 换过 IP 标记），支持单个踢、全部踢；改面板口令或只读账号会踢掉全部会话。
- 未保存改动守卫：标脏 + 顶栏「未保存」徽标 + 站内跳转确认 + `beforeunload`。
- 单实例锁 `data/.state.lock`：pid + `/proc/<pid>/cmdline` 双重确认，第二个实例直接退出。
- 公共主机名管理：`GET /api/cf/tunnels/<id>/ingress`、`POST .../hostnames`、`POST .../hostnames/delete`，自动建/删 CNAME。
- 按规则统计 `GET /api/routes/stats`：命中数、错误率、P50/P95/最慢、字节数、未命中请求。
- 新告警事件 `errorSpike`（5xx 尖峰）、`loginFail`（登录失败集中），沿用冷却与静默时段。
- `GET /api/export.yaml`：无密钥的单文件配置快照。
- PWA：manifest + 图标 + service worker（只缓存 `/assets/*`）。
- `.github/workflows/release.yml`：打 tag 构建多架构镜像推 GHCR。

### 变更
- Caddy admin 默认从 `127.0.0.1:2019` 改到 `127.0.0.1:20190`，监听地址跟随 `CADDY_ADMIN`；下发改多地址回退。
- 移除 `/legacy` 旧单页（96KB）及其入口。

### 修复
- 会话 `resolveKey` 不认原始 cookie 值，导致「登出」不生效、退出全部设备返回 undefined。
- 会话换 IP 分支读 `sess.id`（不存在）抛错，使 `/api/sessions` 500。
- 规则命中统计的索引错位（`simulateMatch` 返回 1-based），1xx（WebSocket 101）被漏计。

## v0.11.1

- 通知按格式校验地址（钉钉/飞书/Bark 填错当场 400，不再静默不送达）。
- 钉钉 / 飞书「加签」支持：密钥单独存，钉钉签进 URL、飞书签进 body。
- 设置页按格式切换地址标签/占位符/操作提示，新增「清空已存密钥」。
- 测试：API 111 项、DOM 75 项。

## v0.11.0

- 帮助文案全部中英双语（171 条页面文案入库，字典共 229 条），翻译改为文本节点级 + 属性级扫描。
- 会话换来源 IP 告警：审计 + 通知 + 会话表红标。
- 「退出全部设备」；改面板口令 / 改只读账号自动踢掉所有会话并跳登录页。
- 测试：API 107 项、DOM 72 项。

## v0.10.0
- 会话式登录：`/login` 页 + `cfp_sid` cookie（HttpOnly/SameSite=Lax/HTTPS 自动 Secure），7 天有效、12 小时闲置失效；Basic 认证保留给脚本与 Prometheus。
- 会话管理：`GET /api/sessions`、`POST /api/sessions/revoke`、`POST /api/sessions/revoke-others`；设置页「登录会话」表格显示账号/角色/IP/设备/时间，可逐个踢掉。会话只存内存，重启即失效。
- CSRF：会话 cookie 的写请求要求同源（`Sec-Fetch-Site`/`Origin`），跨站写 403 并记审计。
- 变更趋势图：概览页新增第三张柱状图，`GET /api/audit/trend?hours=` 按小时聚合写操作（失败叠红）。
- 界面中英双语：`cfp_lang` cookie + 左下角 `EN`/`中` 切换，字典按「中文原文→英文」精确替换，服务端渲染 `<html lang>` 与导航文案。
- 未登录访问页面跳转 `/login?next=`（API 仍返回 401 JSON）。
- 测试：API 100 项 + 页面 70 项。

## v0.9.0

- **Backend split**: `src/server.js` 2543 → ~800 lines; logic moved into 15 focused modules under `src/core/`
  (`paths`, `util`, `state`, `registry`, `auth`, `caddy`, `pusher`, `tunnels`, `insight`, `bench`, `probe`,
  `integrations`, `notify`, `web`, `monitor`, `audit`). No behavioural change intended; verified by the full suite.
- **State sharing**: `state.js` now exports a live `stateProxy` plus `setState()` so导入/回滚 takes effect everywhere
  (a stale destructured `state` used to make `/api/state` report the wrong route/exit counts).
- **Audit log**: every state-changing request and every failed `/api` call is recorded (actor, real client IP,
  action, status, duration). Ring buffer of 500 + append-only `data/audit.log` (JSON Lines, rotated at 2 MB).
  New endpoint `GET /api/audit?limit=&q=`; new card on the Observe page with search and pagination.
- **Fixes**: `src/core/paths.js` resolved `web/`, `ui.html` and `package.json` one level too shallow after the move.
- Tests: 86 API + 57 DOM assertions (143 total).

## v0.8.1

**安全**
- 修：`POST /api/settings` 的回包把 Cloudflare API token / 通知 webhook 明文吐了回来（`/api/state` 早就脱敏了，这个回包漏了）。现在统一走 `publicSettings()`，只回 `hasToken` / `hasUrl`。

**工程**
- `docker-compose.yml`：面板容器改以宿主机 uid 运行（`user: "${PUID:-1000}:${PGID:-1000}"`），`data/state.json` 不再是 root 属主；Caddy 镜像锁到 `2.11.9-alpine`（面板生成的 JSON 依赖该版本字段名）。
- `Dockerfile`：基础镜像锁版本（`node:22.23.5-bookworm-slim`、`cloudflared:2026.10.7`），并支持 `--build-arg` 覆盖镜像与 npm 源。
- 中文说明改名 `README.zh-CN.md`，`README.md` 改为英文默认版，两页顶部可互相切换。
- 新增 `CHANGELOG.md`、GitHub Actions 冒烟测试。
- 新增 2 条接口断言（设置回包脱敏）。

## v0.8.0

- 前端重做为多页面（概览 / 隧道 / 规则 / 工具 / 观测 / 设置）+ 设计系统（深色默认、响应式、1200/720 断点）。
- 新增：流量趋势图、出口在线历史、通知发送记录、系统信息表、只读账号、Ctrl+K 命令面板、规则搜索、
  作用域记忆、访问统计筛选、日志暂停/只看错误。
- 修：导入脱敏配置会把面板密码清空；概览 SVG 用了不存在的 CSS 变量名；jsdom 测试绕过鉴权导致误判。
- 测试入库：`test/api.test.mjs`（78）+ `test/dom.test.cjs`（54）。

## v0.7.9

- Cloudflare API 集成做厚：`/api/cf/verify`（验证 token、自动带出账号/域名）、隧道详情（含边缘连接）、
  取隧道 token、DNS 增删查；README 补齐「能做什么 / 做不到什么」与错误对照表。

## v0.7.8

- 修分享链接 `/s/<token>` 被 `/` 兜底规则吃掉（分享路由现在插在业务规则之前）。

## v0.7.7

- 面板内置测速（`/__bench/ping`、`/__bench/blob`、`/api/bench/local`），工具箱一键测延迟与吞吐。

## v0.7.6

- 修代理规则页编辑时被 5 秒轮询覆盖（脏标记 + 焦点保护）；`/api/tunnels` 补 `publicUrl`。

## v0.7.5

- Tunnel token 粘贴容错：粘整条 `cloudflared service install ...` 命令会自动抠出 token 并校验。

## v0.7.4

- cloudflared 报 `token is not valid` / 连续 5 次启动失败 → 标记 fatal 并停止自动重试（此前每 5 秒重启刷日志）。

## v0.7.3

- 命名隧道接入；面板登录 + 8 次错密码锁 10 分钟；Caddy `trusted_proxies`(Cloudflare 22 段) + `CF-Connecting-IP`
  取真实客户端 IP（否则 IP 白名单在隧道后面形同虚设）；导入保留密钥。

## v0.7.2

- WebSocket 自测、通知冷却与静默时段、备份对比、Prometheus 指标规范化 + Grafana 面板。

## v0.7.1

- 上游健康探测、规则遮蔽检测、Caddy 配置预览、CSP 等安全头、`/api` 限流、ETag/gzip。

## v0.7.0

- 多页面架构落地（侧边导航 + 页面片段 + 共享设计系统），旧单页保留在 `/legacy`。

## v0.6.0

- B/C/D 三档：Docker 容器一键加规则、一次性分享链接、维护模式、IP 黑名单、限流开关、掉线通知
  （generic/钉钉/飞书/Bark）、Cloudflare API、`/metrics`、`/badge.svg`、日志下载。

## v0.5.0

- 规则自检三件套（测上游 / 模拟匹配 / 访问统计）、一键回滚、访问日志落盘。

## v0.4.x

- 出口绑定规则、左右两栏布局、出口切换做成顶部 tab。

## v0.3.x

- 多隧道出口并行（state v3）、顶部 tab、根路径提示条。

## v0.2.x

- 多页面前身：脏标记防轮询覆盖、Cloudflare 配置教程写进面板与文档。

## v0.1.0

- 首个可用版本：单隧道 + 路径分流 + 面板 CRUD。
