# Changelog

按日期倒序。功能细节与实测数据见 [docs/ROADMAP.md](docs/ROADMAP.md)。

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
