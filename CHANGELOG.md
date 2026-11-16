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

## v0.14.1 — 2026-11-16

### 新增
- Service Worker 离线兜底页 `src/web/assets/offline.html`（缓存版本升到 v2，navigate 失败时返回）。
- 设置页卡片搜索 `#cardSearch`：按标题 + 正文过滤 13 个分区，chips 同步隐藏并显示命中计数。
- 窄屏（≤720px）图表高度 96 → 126px、刻度字号 10px。

### 变更
- **JSON 响应统一加 ETag 并支持 304**：`sendJson` 输出弱 ETag（按 gzip/identity 分后缀）+ `Cache-Control: private, no-cache`，`If-None-Match` 命中返回 304 且无正文。原来写的是 `no-store`，浏览器因此从不发起协商缓存，这也是这条优化以前做不成的原因。

### 修复
- 清理 README（中英）里 `/legacy` 的过时描述。

## v0.14.0 — 2026-11-16

### 新增
- `/api/routes/stats?hours=`：按 1/6/24 小时时间窗统计；规则卡显示「命中 N · 错 M · p95 Xms」并可切窗口。
- 图表悬停提示：柱子与在线率采样点都带 `<title>`（原生 SVG tooltip），显示该小时的具体数字。
- `tunnelUp` 通知事件：出口从非 running 恢复到 running 时发一条带地址的消息，设置页可开关。
- `GET /api/audit.csv`：审计日志导出 CSV（UTF-8 BOM，Excel 友好），观测页有按钮。
- 观测页 IP 筛选：来源 IP 可点，或直接 `/observe?ip=`。

### 修复
- **访问日志行缺 `at` 字段**，`monitor.js` 的「最近 5 分钟」过滤永远为空 → 5xx 尖峰告警自上线以来从未触发。现在 `readAccess()` 每行带 `at`，并支持 `{since, maxBytes}` 参数。
- `readAccess()` 只读末 512KB，24 小时窗口会被截断；带 `hours` 时改读 4MB。

## v0.13.9 — 2026-11-16

### 修复
- **概览页图表显示错乱**：SVG 用 `preserveAspectRatio="none"` 横向拉伸，导致刻度文字被压扁、贴住卡片底边；首尾柱子被卡片边缘切掉；三张图塞在两列网格里，第三张换行留白；「出口在线历史」只有 1 个采样点时 `polyline` 画不出来，整块卡片是空白。
- 现在：绘图区留在 SVG，刻度用 HTML 绝对定位（`.chart-x`，字号恒定、自动对齐柱子中心）；柱子左右留 `CPAD=1.2`；统一 `gridLines()` 基线/中线；峰值乘 1.08 留余量；采样点 <2 时显示明确说明。

### 变更
- 概览页三张图表卡从 `.grid2` 改到 `.grid3`（宽屏一行三张，窄屏自动堆叠）。

## v0.13.8 — 2026-11-16

### 修复
- **登录页点「登录」没反应**（严重）：`loginPage` 的表单逻辑写在 HTML 内联 `<script>` 里，被 v0.7.1 加上的 CSP `script-src 'self'` 直接拦掉。浏览器于是走原生表单提交（`GET /login?username=…&password=…`），页面刷新一次、口令明文进了 URL 和访问日志。现已把脚本移到 `/assets/login.js`（同源外部脚本，CSP 允许），并用 `data-next` 传跳转目标。
- **英文切换静默失效**：`window.__CFP_LANG`/`__CFP_DICT` 也是内联注入，同样被 CSP 拦。改为 `/boot.js`（gzip + `no-store`），八页与登录页都引用。
- 清理：访问日志里 4 条带明文口令的记录已就地打码（`password=REDACTED`）。

### 新增
- API 套件新增「所有页面无内联 `<script>`」「`/boot.js` 可用且不缓存」「`/assets/login.js` 可访问」四个断言；DOM 套件新增登录页引用检查。测试总数 180 API + 91 DOM。

## v0.13.7 — 2026-11-16

### 新增
- **可疑访问统计** `GET /api/security/attempts?hours=&limit=`：把访问日志里的 401/403 按规则与来源 IP 聚合，含每条规则的前 5 个来源、全局前 20 个 IP；观测页新增卡片（窗口 6h/24h/3d/7d，规则名可点回规则页）。
- **扫描告警 `authScan`**：`monitor.js` 每 5 分钟检查 10 分钟窗口，单 IP 被拒 ≥20 次触发通知，30 分钟冷却；`settings.notify.events.authScan` 可在设置页关掉。

### 修复
- 设置页「通知事件」的保存补上 `authScan`，避免勾选被静默丢弃。

## v0.13.6 — 2026-11-16

### 新增
- **访问记录可点进规则**：`/api/access` 为每行附加 `rule: {id, name}`（`simulateMatch` 归属），观测页路径单元格渲染成 `/rules?focus=<id>` 链接，hover 提示命中的规则名。
- **规则卡片显示命中量**：`rules.js` 在 `render()` 后拉 `/api/routes/stats?limit=2000`，把 `命中 N · 错 M · p95 Xms` 填进每条规则的徽标（有错误转黄色，没数据则隐藏）。

## v0.13.5 — 2026-11-16

### 新增
- **按规则流量图例可点**：`/api/traffic/paths` 的分组里补 `id/path/tunnelId`，概览页图例渲染成 `/rules?focus=<id>` 链接；规则页读取 `focus` 参数、必要时切换到对应作用域、滚动到卡片并高亮（`data-focused` + 1.6s 闪烁动画）。规则已被删掉时给人话提示而不是静默无反应。

## v0.13.4 — 2026-11-16

### 新增
- **按规则看流量** `GET /api/traffic/paths?hours=&top=`：读 access log 后用 `simulateMatch` 把每条请求归属到规则，按小时分桶输出；未命中的请求单独用 `unmatched` 计数（健康检查、未知路径常占大头，混进图例会挤掉真服务）。概览页新增「按规则看流量」堆叠柱状图 + 图例（规则名 · 总量 · 5xx）。
- **部署提醒**：预热成功时把代码指纹写进 `state.warm`，概览页发现「运行代码 ≠ 上次预热指纹」就提示重新预热。

### 修复
- 按规则归属一开始全落到「未匹配」：原始 Caddy 日志里 `host/uri/method` 在 `request` 子对象内（`readAccess` 才拍平），直接读 `o.host` 拿到的是 `undefined`。改为 `o.request.host` 兜底。

## v0.13.3 — 2026-11-16

### 新增
- **资源指纹 + 一年 immutable 长缓存**：页面引用 `/assets/*` 时带 `?v=<代码指纹前 8 位>`，这类请求回 `Cache-Control: public, max-age=31536000, immutable` 与一年期的 `CDN-Cache-Control`；无指纹的请求保持 `max-age=300`。代码一改 URL 就变，天然绕开旧缓存。
- **缓存预热** `POST /api/cf/cache/warm`：按当前指纹从公网域名拉 `/login` + 关键资源（可传 `paths` 覆盖，最多 12 条），逐条返回 `cf-cache-status` / `age` / 机房 / 耗时，工具箱加「预热缓存」按钮。
- **通知文案模板**：`notify.template {title, text}`，占位符 `{event} {title} {text} {host} {time} {running} {total}`；正文不含 `{text}` 时自动把原正文附在末尾。

### 修复
- `POST /api/settings` 的 `notify.events` 之前只回写四项，会把手动关掉的 `errorSpike` / `loginFail` 又打开；现在六个开关都保留。

## v0.13.2 — 2026-11-16

### 新增
- **Cloudflare 边缘缓存**：静态资源响应加 `Cache-Control: public, max-age=300` + `Cloudflare-CDN-Cache-Control: public, max-age=86400`；新增 `GET/POST /api/cf/cache/rule`（自动建/删「/assets/* 边缘缓存 1 天」的 Cache Rule）与 `POST /api/cf/cache/purge`（按 URL 或整域名清边缘缓存）；工具箱页新增「边缘缓存」操作区。实测公网 `cf-cache-status` 由 `DYNAMIC` → `MISS` → `HIT`（`age` 递增）。
- **通知重发**：`POST /api/notify/resend {seq}`，设置页「通知发送记录」每行加「重发」按钮（绕过静默时段/冷却/事件开关，用于验证 webhook 到底通不通）。
- **设置页分区导航**：卡片加 `#sec-*` 锚点并新增吸顶 `.subnav`，13 个卡片可一键跳转，窄屏横向滚动。

### 变更
- `/assets/*` **不再要求登录**（放在鉴权之前）：登录页自己也要加载 `app.css`，之前未登录时 CSS 是 401，登录页等于无样式；顺带让 Cloudflare 能把这些 URL 当公开资源缓存。
- JSON 响应 gzip：`sendJson` 在体积 >1KB 且客户端接受 gzip 时压缩（`/api/state` 4851B → 1559B，降 68%）。
- 文本响应的 ETag 区分编码（`-gz` / `-id` 后缀），避免中间缓存把压缩字节发给不支持 gzip 的客户端。

### 修复
- `/api/cf/cache/rule` 取 Cloudflare 返回值时多套了一层 `.result`（`cfApi` 已经解包），导致规则建好了却报 `rules: 0`。
## v0.13.1 — 2026-11-16

### 新增
- `POST /api/totp/recovery`：用「当前验证码或一个旧恢复码」换一批新的 10 个恢复码，旧的全部作废（只存 sha256）；设置页「二次验证」卡新增输入框 + 「重新生成恢复码」按钮，新码只在页面显示一次。
- 端到端测试（真 Caddy）从 8 项扩到 **23 项**：strip 前缀、不 strip 原样透传、基础认证三种情况、按 Host 域名隔离（含未登记域名 404）、WebSocket 101 升级、未命中 404、维护模式 503 + `Retry-After` + 关闭恢复、IP 黑名单 403 + 清空恢复、admin 不监听 2019、配置含 access log writer 与 `trusted_proxies`、规则表与设置还原。

### 变更
- 审计日志去重：同一次请求若已被 handler 显式记账（人话 action），收尾兜底那条「POST /api/xxx」不再重复写，列表里不再成对出现。
- e2e 探针路径改成互不嵌套的前缀（`/e2strip`、`/e2keep`、`/e2auth`、`/e2host`、`/e2ws`）——Caddy 是前缀匹配，`/e2e` 会吃掉 `/e2ek`，之前这类失败是测试写法问题而非实现问题。
- 域名隔离断言改用原始 socket 手写请求（`fetch`/undici 不允许覆盖 `Host` 头），并补 `Transfer-Encoding: chunked` 解码。

### 修复
- `/api/totp/recovery` 首次实现误用 `newRecovery()` 返回值（它返回 `{plain, hashed}` 而不是数组）→ 500。

## v0.13.0

### 新增
- **二次验证（TOTP，RFC 6238）**：自实现（只依赖 node:crypto），登录两段式；10 个一次性恢复码；允许 ±30 秒时钟偏移；关闭需当前验证码或恢复码；密钥不出现在 `/api/state`。
- **角色细分 admin / operator / viewer**：`src/core/perm.js` 用写接口白名单，operator 可管隧道/规则/分享/维护模式/主机名，碰不到凭证类设置与导入回滚；403 带具体原因。
- **运维账号**：`POST /api/operator`，保存即踢掉所有旧会话。
- **真 Caddy 端到端测试**：`test/e2e-caddy.mjs` + CI `e2e` 作业（caddy:2.11.9-alpine，admin :20190），验证下发的配置真能加载、真能转发、未命中仍是 404。
- 登录页新增「记住这台设备（30 天）」勾选与二次验证码输入框（口令通过后才显示）。

### 变更
- 登录接口 `POST /api/login` 支持两段：第一段返回 `{needTotp, challenge}`（5 分钟有效、HMAC 签名），第二段带 `challenge + code` 换会话。
- `/healthz` 之外的写权限判断统一走角色矩阵（readonly 判断被 `perm.check` 取代）。

### 修复
- e2e 脚本还原逻辑改为从 `/tmp` 快照还原（原来从当前 state 还原，中途崩溃会把线上规则清空）。
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
