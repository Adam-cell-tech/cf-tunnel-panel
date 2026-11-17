# Changelog

按日期倒序。功能细节与实测数据见 [docs/ROADMAP.md](docs/ROADMAP.md)。

## v0.24.0

两件事：监控图不再只能局域网看，通知不再只能配一条。

### 新增
- **通知多通道**：`settings.notify.channels[]`（最多 8 条），每条独立 `name / format / url / secret / enabled`，一条通知会发给所有启用的通道；设置页「掉线通知」改成通道表，每行可单独测试/删除/停用。`POST /api/notify/test` 支持 `{channelId}` 只测一条。
  - 兼容：老的 `notify.url / format / secret` 在读取时虚拟成一条「默认通道」，老配置不用迁移也能继续发；`migrateState()` 会顺手把它们写成 `channels[0]`。
  - 保存时按每条通道自己的 `format` 校验地址（钉钉必须 `oapi.dingtalk.com/robot/send`、飞书必须 `open-apis/bot/v2/hook`、bark 必须 `host/key`），密钥留空=保留旧值、`clearSecret` 才清空，id 重复直接 400。
- **Grafana 走 HTTPS**：`grafana.jianghugs.shop` 经由 Caddy（`→ 127.0.0.1:3000`）与同一条隧道暴露，Grafana 容器补 `GF_SERVER_ROOT_URL` / `GF_SERVER_DOMAIN`，面板 `settings.grafana.url` 改成 https —— 首页 iframe 不再被混合内容拦截，`/d/…` 分享链接也指向公网域名。

### 变更
- 面板 `frame-src` 会跟随 `settings.grafana.url` 的源动态放行；关闭嵌入时回到 `frame-src 'self'`。
- 新增 28 条界面词条。

### 注意
- Grafana 是**匿名只读**：同网段 / 公网任何人都能看这些图（看不到配置、改不了东西）。不想公开就关掉隧道里的 `grafana` 公共主机名，只保留局域网 `:3000`。

## v0.23.0

把两处「数据都在、但要人手工搬」的地方接上了：看到谁在砸门就能直接封，看到哪个出口在吃流量也能直接读。

### 新增
- **可疑访问一键封禁**：观测页「可疑访问（401/403）」每一行来源 IP 后面新增「封禁 / 解封」按钮，直接写进 `security.ipDeny` 并立刻下发 Caddy（`POST /api/security/deny|allow`）。内网/环回地址会额外提示「可能把你自己挡在外面」，CIDR 支持 `/32`、`/128`、`/24` 等写法，最多 200 条。
- **出口流量（按域名）**：隧道页新增一张表，把访问日志里的 Host 归属到具体出口 —— 请求数、5xx、4xx、p95、流量，支持 1/6/24/72 小时窗口（`GET /api/tunnels/stats?hours=`）。不属于任何出口的主机名会单独汇总在表格下方。

### 变更
- operator 角色可以封禁/解封 IP（属于日常运维动作，不需要管理员）。
- 新增 15 条界面词条（出口流量表 + 封禁按钮）。

## v0.22.0

按「角色 / 导出 / 英文」三条线索收的一轮尾巴，重点是让界面**先说清楚能不能改**，而不是点了才报错。

### 新增
- **角色下发**：`/api/state` 返回 `role` 与 `canWrite`；前端据此在顶栏显示「只读账号 / 运维账号」标签，主按钮禁用，点写操作直接提示，不再等 403 才知道。
- **备份单份下载**：`GET /api/backups/download?file=`（附件下载，文件名白名单，拒绝路径穿越）。
- **访问日志 CSV**：`GET /api/access.csv?limit=`，BOM + CRLF + Excel 公式注入防护；观测页「导出 CSV」跟随当前筛选条数。
- **规则一键复制**：规则卡新增「复制」，插在当前规则后面（自动换 id、名字加「副本」），保存后生效。
- **Grafana 混合内容提示**：https 页面里嵌 http 的 Grafana 会被浏览器拦截，卡片现在直接说明原因与两条出路，而不是显示两块白板。

### 变更
- 语言按钮在英文模式下显示「中文」（原来是个孤零零的「中」）。
- 词典 lookup 增加「空白归一化」兜底：页面里带缩进的文本节点也能命中，英文模式残留中文从 `/settings` 8.0% 降到 0%。

### 修复
- `/api/audit` 的 `limit` 未夹紧（`?limit=99999` 能拉 370KB）→ 夹到 2000。
- `/api/security/attempts` 的 `hours`/`limit` 未夹紧 → 夹到 0.1–168 小时、100–5000 条。

## v0.21.0 附：本机监控栈（tools/monitoring）

- 新增 `tools/monitoring/`：Prometheus(v2.55.1) + Grafana(11.3.0) 的 compose，host 网络、
  `restart: unless-stopped`，Prometheus 抓 `127.0.0.1:8090/8095`，Grafana 自动预置
  数据源（uid `prom-main`）与仪表盘（uid `cfp-main`），并开匿名只读 + `allow_embedding`。
- `docs/grafana-dashboard.json` 补显式 panel id（1–12），`dashboards/` 下生成可直接预置的副本。
- 踩坑记入 `tools/monitoring/README.md`：数据目录要归 uid 1000（用 `--entrypoint sh` 以容器 root 改属主，
  不加 `--entrypoint` 会把 Grafana 当服务跑起来抢 3000 端口）。

## v0.21.0 — 把 Grafana 的图嵌进首页

- **首页新增「监控面板」卡**：把 Grafana 单个 panel 用 `/d-solo/` 直接嵌进来（只给一张图，
  不带 Grafana 自己的时间选择器和侧栏，尺寸可控）。设置页「监控嵌入」里填 Grafana 地址、
  仪表盘 `uid/slug`、最多 3 个 `panelId`（可加标题与高度），保存后首页出现。
- **CSP 跟着配置走**：页面的 `frame-src` 只在开启嵌入时放行「你填的那个源」，
  关掉或没填就退回 `'self'` —— 不用 `*`，也不允许任意站点被嵌进来。
- 校验都在服务端：地址必须 http(s)（拒绝 `javascript:`）、仪表盘要 `<uid>/<slug>`、
  高度夹到 140–600、最多 3 个；开启但少任何一项直接 400 并说明缺什么。
- Grafana 侧需要 `allow_embedding = true` + 面板可匿名只读（org_role=Viewer），
  否则 iframe 里会是 Grafana 自己的登录页。

测试：API 262 项、DOM 118 项。

## v0.20.0 — 审计留档按天、告警模板、Grafana 集群面板

三件都是「出了事能查、平时能看」的东西。

- **审计日志按天分文件 + 保留策略**：以前是单个 `data/audit.log`，超过 2MB 只留最后 3000 行，
  等于只记得最近几小时 —— 「上周三谁改的规则」根本查不到。现在每天一个
  `data/audit/audit-YYYY-MM-DD.jsonl`，单文件超 8MB 截断到 5000 行，默认保留 30 天
  （`PANEL_AUDIT_DAYS` 可调，启动与每小时各清一次）。老文件首次启动自动搬进新目录，不丢历史。
  观测页审计卡多了日期下拉（默认「最近两天」），导出 CSV 也跟着筛选走；接口新增
  `GET /api/audit/days`，`/api/audit` 与 `/api/audit.csv` 都支持 `date=YYYY-MM-DD`。
- **告警规则模板** `docs/prometheus-alerts.yml`：10 条，覆盖面板抓不到、没有主实例、主实例频繁切换、
  代码漂移、出口掉线、Caddy 下发失败、业务 5xx 占比、面板自身 5xx、面板被扫、通知发送失败。
  每条都写了「看到它该去查什么」。
- **Grafana 面板重做** `docs/grafana-dashboard.json`：12 个 panel —— 主实例 / 在线出口 / Caddy 下发 /
  代码漂移 / 历史采样 / 面板请求六个数字，集群角色时间线、面板请求速率、业务请求、通知结果四张时序图，
  出口状态与构建信息两张表。

测试：API 251 项、DOM 116 项。

## v0.19.0 – v0.19.2 — 历史共享 + 集群指标

- **v0.19.0**：出口采样与通知记录落盘共享（`data/history/samples.jsonl`、`notify.jsonl`），
  两台实例读同一份；`/api/history`、`/api/notify/history` 响应带 `shared:true`。
- **v0.19.1**：采样触发改成「距上一条 ≥55 秒」而不是数 tick —— 原来进程重启相位归零，
  滚动升级切主时曲线会空整一分钟。
- **v0.19.2**：`/metrics` 升级为集群视角（`cf_role`/`cf_leader_info`/`cf_build_info`/`cf_code_drift`/
  `cf_history_samples`/`cf_notify_total`/`cf_panel_requests_total`），另加面板自身请求计数。

## v0.18.0 — 横向扩展收口：两个实例终于「像一份系统」

这一版几乎全是 bug 修复 —— 起因是「两个进程同时活」之后，很多以前不会暴露的假设开始漏气：
会话只在内存里、配置只读一次、告警两个实例各发一份、审计只在重启前有效。

- **会话跨实例共享**：`sessions.json` 变成共享事实源。会话表以磁盘为准，取会话时做限流合并
  （1.5 秒最多读一次盘），未命中再强制读一次；撤销用**共享墓碑**（文件格式升级到 v2：
  `{version, sessions, revoked}`，旧的纯数组仍能读）。修掉三个具体故障：①在 A 登录、请求被
  Caddy 轮到 B → 401 掉登录；②在 A 踢人、B 那边还能用；③改只读账号口令把管理员自己也踢下线。
- **配置跨实例可见**：`maybeReloadState()` 按 `state.json` 的 mtime 增量重载（2 秒节流，页面渲染
  1 秒），改完规则切到另一个实例的页面不会再看到旧配置。
- **告警只由 leader 发**：`monitor.js` 的通知统一走 `alertOnlyLeader()`。两个实例读同一份
  access.log，之前一条 5xx 尖峰会发两遍、出口恢复也会报两次。采样仍各实例本地做。
- **审计日志读文件**：`/api/audit` 改成读 `data/audit.log`（跨实例、重启后仍在），而不是只看
  本进程的 200 条环形缓冲。
- **权限**：只读/运维账号不能再 `/api/export?full=1`（GET 对它们本来都放行，之前能一键导出
  隧道 token、CF API token、TOTP 密钥）；设置只读/运维账号只踢**该账号**的会话（新增
  `session.revokeUser()`），不再是 revokeAll。
- **审计 CSV 一直是空的**：处理函数读的是 `list().items`，实际字段叫 `rows` —— 从 v0.14.0 起
  这个导出只有表头。顺带给单元格加 Excel 公式注入防护（`= + - @` 开头垫单引号）。
- **链路自测发不出 Host**：`fetch`/undici 不允许覆盖 `Host`，所以「指定域名测规则」永远是错的
  （看起来像规则没配好）。改用 `http.request` 手写 Host，回显里能看到真正发出的域名。
- **静默失效变显式警告**：勾了限流但镜像里的 Caddy 没有 `rate_limit` 模块时，保存设置会回
  `warnings` 并在界面上提示（之前只是日志里说一次，用户以为开了）。
- `/api/qr?text=` 加 1200 字符上限（再长二维码密到扫不出来，也顺便挡掉拿它当存储的用法）。
- 测试：**229 接口 + 113 页面 + 32 真 Caddy e2e**（e2e 新增「备份实例认得 leader 登录的会话」
  「备份实例看到 leader 刚改的配置」两条跨实例断言）。

## v0.19.2 — 监控指标升级成「集群视角」

`/metrics` 以前只描述“这台实例自己”：抓的是 standby 就只能看到它那份出口状态，
而且面板自己的 `/api` 请求根本不在 Caddy 的 access.log 里，被扫描时看不出来。

- 新增指标：
  - `cf_role{role="leader|standby"}`、`cf_leader_info{id}` —— 一眼看出这台是谁、谁是主；
  - `cf_build_info{version,code,mode}`、`cf_code_drift` —— 版本/代码指纹/是否跑着镜像外的代码；
  - `cf_history_samples`、`cf_notify_total{status}` —— 读共享历史文件，两台抓出来的数一致；
  - `cf_panel_requests_total{status}`、`cf_panel_uptime_seconds` —— 面板自身请求（按状态类），
    静态资源、`/healthz`、`/metrics`、`/badge.svg`、`/__bench/*` 都不计入，避免健康检查把 2xx 刷成噪声。
- `GET /api/system` 增加 `panelRequests {total, since, byStatus, top[10]}`；
  设置页「关于」多两行：面板请求合计与最热路径、历史采样/通知条数。
- 计数是**每实例内存**（进程重启归零），要长期审计看 `audit.log`，两者用途不同。

## v0.19.1 — 采样按「上一条有多旧」触发，主备切换不再漏一分钟

v0.19.0 把曲线落盘后立刻暴露一个瑕疵：采样是 `histTick % 12 === 0`（每 12 个 5 秒 tick）
触发的，进程一重启相位就归零 —— 滚动升级切主时那条曲线上会**空掉整整一分钟**。

- 改成看「文件里最后一条采样有多旧」：`Date.now() - last.t >= 55000` 才采。
  新 leader 起来后立刻补一个点，历史由 `history.js` 按分钟去重，所以不会重复也不会漏。
- 实测蓝绿切换前后：`17:37 blue → 17:38 blue → 17:39 blue → 17:40 green → 17:41 green`，
  曲线连续，点的来源字段 `inst` 显示两台都写过同一个文件。

## v0.19.0 — 历史数据落盘共享（两台实例看到同一份曲线）

横向扩展之后还剩一处「两台不一样」：出口在线曲线（`/api/history`）和通知发送记录
（`/api/notify/history`）都攒在各自进程内存里 —— 刷新页面落在哪台就看哪份，
重启还会清零。这版把它们搬到 `DATA_DIR/history/`：

- `samples.jsonl`：每分钟一条 `{t,running,total,caddyOk,req,inst}`，**只由 leader 写**
  （standby 也写就会两家互相覆盖），读取时按分钟去重，leader 切换不会出现重复点。
- `notify.jsonl`：通知结果 `{seq,event,title,status,extra,text,inst}`，seq 用毫秒时间戳，
  跨实例不撞车；「重发」按 seq 找记录，重启后仍能重发。
- 两个文件都是追加写 + 超 512KB 自动重写成最后 2000 行（临时文件 + rename），
  读的时候只读末尾 256KB；跨实例刷新节流 2 秒，不会每个请求都读盘。
- `/api/history`、`/api/notify/history` 响应加 `shared:true`；`/api/system` 多一段
  `history {dir,inited,samples,notifies,*Bytes}`，排障时能直接看到文件长到多大。

顺带：`sampleHistory()` 现在由 `monitor.js` 在 `safeLeader()` 为真时才调，
避免 standby 写出「自己这边 0 个出口在线」的假低谷。

## v0.18.3 — 镜像重建，`drift` 归零

前面几版都是用 `docker cp` 热替换容器里的代码（改一行、重启一次，十几秒见效果），
代价是镜像里还是老代码 —— `/healthz` 的 `drift:true` 就是在说这件事。这版把两者对齐：

- 用当前工作区重建镜像，并核对镜像内 `.code-hash` 与工作区 `node tools/codehash.js` 完全一致
  （`902d6faf08cdbaa2`），再用 `MOUNT_SRC=0 tools/rolling-upgrade.sh --apply` 滚两轮，
  两台实例都跑镜像里的代码，`/healthz` → `drift:false`、`code == imageCode`。
- 修 `Dockerfile` 的默认 `CADDY_ADMIN`：原来写 `127.0.0.1:2019`，而 `caddy.bootstrap.json`
  现在监听 `20190`。走 compose 时由 compose 覆盖所以看不出来，但**直接 `docker run` 这个镜像**
  会推不动配置（v0.16.0 起 pusher 不再回退旧端口）。改成 `20190`。
- 镜像同时打 `cf-tunnel-panel:local`（脚本默认引用）与 `cf-tunnel-panel:0.18.3`（便于回滚）。

## v0.18.2 — 备份实例不再「悄悄失败」

横向扩展之后 Caddy 会把页面请求轮流分给两台实例，轮到备份实例时写操作会被 409 拦住，
但界面只弹一句「当前连的是备份实例」，用户不知道该怎么办。

- `api()` 识别 `409 STANDBY`：提示「这次请求落在备份实例上（只读），已自动刷新」，
  900ms 后自动刷新页面（此时主实例通常已接管或本就该在它上面），用户重做一次即可。
- 顶栏健康点会显示 **「备份实例 · N/M 出口在线」**，黄点 + hover 说明，不再让人误以为出口全挂了。
- `/healthz` 增加 **`leader`**（当前主实例 id）、`/api/state` 增加 **`mode`**：
  监控/脚本不用猜「这次请求落到哪台」，也能一眼看出谁在当主。

## v0.18.1 — 修 CI：e2e 不再抢 8080/20190，失败时能看懂原因

CI 从 v0.16.2 起一直是红的，但本地三套测试全绿——差别在端口与环境：

- `test/caddy.e2e.json` 原来监听 `:8080`、admin `127.0.0.1:20190`，和「本机已有 Caddy」的
  场景撞车，GitHub runner 上又可能被别的进程占用 → 改成 e2e 专用端口
  **业务 `:8180`、admin `127.0.0.1:20290`**，与本地验证用的组合完全一致。
- CI 的 e2e 作业补 `CADDY_PORT=8180`、`CADDY_LISTEN=:8180`、`PANEL_ALLOW_FRESH_PUSH=1`，
  否则面板会把「默认 `:8080`」的配置推给只监听 8180 的 Caddy，随后所有断言 `fetch failed`。
- e2e 断言加 `timeout 600` 兜底，避免某个断言挂住把作业拖到 6 小时超时。
- 失败时打印 Caddy 容器日志 + 面板日志末尾 80 行 + **当前 Caddy 运行配置**（前 2KB），
  以后红一眼能看出是「配置没下发」还是「服务没起来」。

## v0.17.0 — 升级改成 blue/green 固定命名，不再和 compose 抢名字

以前脚本收尾会把新实例改名成 `cf-tunnel-panel`，于是「容器名」既是 compose 的服务名、
又是当前 leader 的名字 —— 下次 `docker compose up -d` 必然报 name conflict，
而且「cf-tunnel-panel 到底指哪一代实例」也没法从名字看出来。

- 容器名固定成一对：`cf-tunnel-panel-blue`（:8090）/ `cf-tunnel-panel-green`（:8095）。
  每次升级只是「在另一色上起新实例 → 停当前色」，**从不改名**，跑多少遍名字都稳定。
- 新增 `--bootstrap`：机器上还没有任何实例时用它创建蓝色槽位（不写 `--bootstrap` 就报错，
  避免手滑把正式环境起成空白状态）。
- `docker-compose.yml` 的 panel 服务移到 `profiles: ["bootstrap"]`：裸跑
  `docker compose up -d` 只管 Caddy 与演示服务，不再与脚本争容器名/端口。
  首次部署用 `docker compose --profile bootstrap up -d panel` 或脚本的 `--bootstrap`。
- `--prune` 现在删除的是「停下来的那一色」（如果那是旧式单容器则保留并提示手工删）。
- 修 `set -euo pipefail` 下的 bootstrap 崩溃：`CUR_NAME` 为空时 `docker inspect ""` 失败，
  经 `pipefail` 让整条管道非 0，脚本直接退出。
- 脚本起容器时补上 compose 项目标签，`docker compose ps` / 面板的宿主机信息都能看懂它是谁。

## v0.16.2 — 把「两个进程同时活」也纳入端到端

- e2e 新增双实例段（5 条）：用同一个 `data/` 起第二实例，断言它拿到 `standby` 身份、能读
  `/api/state`、写 `/api/settings` 被 `409 STANDBY` 拦住、409 里写明谁是 leader、
  以及原实例仍是 leader。真 Caddy 段总计 **28 条**。
- `tools/rolling-upgrade.sh` preflight 增加两条提示：容器若由 compose 创建，切换后
  `docker compose up -d` 会因容器名冲突而失败（先 `docker rename` 即可）；容器若挂载了
  宿主源码，升级后的 `code` 反映的是工作区而不是镜像（想验镜像请走 compose）。

## v0.16.1 — 镜像不再是「另一份代码」

终于把镜像 rebuild 通了，之前每次 `docker compose up -d` 都会把面板退回 v0.5.0，`/healthz` 的 `drift` 也一直报警。

- 修 `Dockerfile` 里 `ARG NODE_IMAGE` 的作用域：它写在 `FROM ${CF_IMAGE}` 之后，到 `FROM ${NODE_IMAGE}` 时已经取到空串，构建直接报 `base name (${NODE_IMAGE}) should not be blank`。所有出现在 `FROM` 里的 ARG 现在都在第一个 `FROM` 之前。
- 修 `COPY` 带进来的文件权限：宿主机上被脚本写成 `600` 的文件（`src/core/audit.js`、`lease.js`、`web/assets/app.js` 等）会被原样复制进镜像，容器以 uid 1000 运行时直接 `EACCES open`，面板反复重启。现在末尾统一 `RUN chmod -R a+rX /app`。
- 新增**面板槽位自愈**：leader 接管时，如果「面板自己」那条规则的 upstream 端口属于面板槽位但不是本实例端口（滚动升级换槽位后必然发生），自动改成本实例端口并落盘。否则状态里存着一个不存在的端口，看的人困惑，保存护栏的 `panelExposed` 判断也会失效。
- 自动重试时保留上一次失败原因（`startTunnel(id, { keepError: true })`），手动点「启动」才清空 —— 之前「启动中」那一小段界面上什么提示都没有，看起来像隧道凭空消失。
- 测试：把两条依赖 Cloudflare 快速隧道配额的断言放宽（只要求「running 时必有地址」「失败要留原因」），本地/CI 不再随机红。

## v0.16.0 — 2026-11-16

- **滚动升级（零中断）**：新增 `src/core/lease.js` —— 基于租约文件的主备选主（5s 心跳 / 15s TTL），
  持有者才写 state、下发 Caddy、跑 cloudflared；其余实例以 standby 运行，写操作返回
  `409 {code:"STANDBY"}` 并报出 leader。leader 退出即刻让权，standby 约 5s 接管。
- **Caddy 双槽位**：面板自己那条规则下发成两条上游（`PORT` + `PANEL_SLOT_PEERS`），
  `selection_policy: first` + `/healthz` 主动健康检查，切换时 Caddy 自动跳过不健康的上游。
- **新增 `tools/rolling-upgrade.sh`**：ping-pong 双槽位升级，含 preflight、standby 就绪等待、
  接管检测、容器改名、验证、`--prune` 清理；接管失败自动回滚。
- **`/healthz` 增加 `mode`（leader/standby）与 `instance`**，`docker ps` 之外也能一眼看出谁在当班。
- **修两个会咬人的问题**：
  1. `CADDY_ADMIN` 原来会「挨个试 2019/20190」，一个把 admin 指向假端口的测试实例能靠兜底打到
     线上 Caddy 并用它的空白配置覆盖生产规则 —— 现在只认 `CADDY_ADMIN`（`PANEL_ADMIN_FALLBACK=1` 恢复旧行为）。
  2. `reverse_proxy.fail_duration` 在 Caddy 2.11.9 里不存在，写上去整份配置 400 下发失败
     （表面现象是「推送成功但线上没变」），已移除。
- **空状态保护**：启动时 `state.json` 不存在则拒绝首次 Caddy 下发（`PANEL_ALLOW_FRESH_PUSH=1` 可放行）。
- **bootstrap 兜底从 200 改成 503 + `Retry-After`**：以前占位页返回 200，会让「线上是否可用」的检查全部假绿。
- **备份实例常驻 cloudflared 热备连接器**（仅命名隧道）：交接时隧道不会丢掉最后一个 connector。
  线上实测切换窗口从 **7 次 530（≈6s）** 降到 **1 次 530（≈0.25s）**；负载均衡策略也从 `first`
  改成 `round_robin` + `try_duration 3s`（`first` 会在健康检查尚未剔除死上游时反复重试同一台）。
- `docker-compose.yml` 增加 `PANEL_SLOT_PEERS`（默认 8095）。
- 测试：API 216、DOM 113、e2e 23。

## v0.14.2 — 2026-11-16

- **英文界面收口**：词典 229 → 502 条（从 jsdom 渲染出的 6 个页面采文案）；英文模式残留中文从 7%~32% 降到 0~3%，剩余为用户数据（规则名/出口名）。
- **动态文案翻译**：`toast/confirm/alert/prompt` 全部包一层 `t()`；新增 `MutationObserver` 对新挂载节点补扫（原来只在加载后 700ms 扫一次），另加 2.5 秒兜底扫描。
- **带数字的句子**：`app.js` 新增约 30 条正则（`NUMPAT`）+ 单位词兜底（`WORDS`），覆盖图表 tooltip、分页、在线数、采样数等拼接文案。
- 允许单字文本节点翻译（`测`/`删` 这类按钮此前被 `key.length > 1` 挡掉）。
- 测试：API 196、DOM 102、e2e 23。

## v0.14.3 — 2026-11-16

- **一键新建出口**：`POST /api/cf/tunnels/quick` —— 建隧道 → 取 token → 写 ingress（公共主机名）→ 建 CNAME → 可选落成本机出口并启动 → 轮询公网自测（最多 15 秒），逐步骤返回 `{name, ok, detail}`。
- **修最容易踩的坑**：只建 CNAME 不写 ingress 会 1033，现在同一步完成（保留已有 ingress 条目与末尾 `http_status:404`）。
- **只演练模式**：`dry:true` 返回 5 步计划（含具体接口路径），不调 Cloudflare。
- 校验：主机名必须是带点的完整域名、上游必须带协议，均返回 400 人话提示。
- 工具箱新增「一键新建出口」卡（`#btnQuick/#qkHost/#qkSvc/#qkName/#qkLocal/#qkDry/#btnQkRun/#qkOut`），结果以表格展示。
- 测试：API 200、DOM 106、e2e 23。

## v0.15.2 — 2026-11-16

- **规则拖动排序**（`src/web/assets/rules.js` + `app.css`）
  - 卡片 `draggable="true"` + 抓手 `.drag`（`⠿`，title 说明「顺序就是优先级」）
  - `dragstart` 记住源索引、`dragover` 按落点上半/下半给 `.dropbefore`/`.dropafter` 蓝线、`drop` 里 `splice` 重排后 `markDirty()` + `render()`
  - 从 `input/select/textarea/button/a` 起手一律 `preventDefault`（那是选文字，不是拖排序）
  - 只动同作用域：跨作用域卡片本来就不显示，天然隔离
- 快照 cron 落地：宿主机 `*/15 * * * * … tools/git-snapshot.sh`，实测首次提交 `426236c`、二次「配置没变化，跳过提交」
- 测试：DOM **113**（+3：卡片可拖拽 / 有抓手 / 保留 ↑↓），API 214、e2e 23

## v0.15.1 — 2026-11-16

- **保存前的护栏**（`src/core/guard.js`，新增）
  - `shadowIssues(routes)`：找出被前面规则遮蔽的规则（兜底 `/`、更宽前缀、同 host 同路径重复），判定与 Caddy 首条命中一致
  - `panelExposed(routes, panelPort)`：新规则集里是否还有一条指向面板自身端口
  - `POST /api/routes` 与 `POST /api/config/apply` 命中即 **409 `{code:'GUARD', issues:[…]}`**，`force:true` 放行；`apply` 的 `dry` 把同样内容放进 `warnings`
- 前端：`api()` 抛错时带 `err.status` / `err.payload`；规则页与「配置即代码」卡的保存失败走确认框，逐条列原因后带 force 重试
- `validateRoutes` 加严上游：必须是 `host:port` 或 `http://host:port`（此前 `parseUpstream('not-a-url')` 不报错）
- `tools/git-snapshot.sh` 重写：提交 `data/config/*.json`（脱敏声明式快照）而非只提交 state.json，保留 120 份、幂等；`STATE=1` 才连 `state.json` 一起提交
- 修正：`guard` 的「面板入口」只在**本来能进、改完就进不去**时才拦（比较新旧规则集），否则首次搭 Caddy 或 CI 里不挂面板的场景会被误判
- 测试：API **214**（+4：顺序护栏 409 / 演练 warnings / 面板入口护栏 / 被拦时线上不变）、DOM 110、e2e 23

## v0.15.0 — 2026-11-16

- **配置即代码**：新增 `src/core/configcode.js` + 五个接口
  - `GET /api/config`：state → 声明式 JSON（settings 公开字段 / tunnels 带 hasToken / routes 无哈希 / shares）
  - `POST /api/config/apply`：routes 全量替换、tunnels 按 id 合并（导出不含 token 也不会抹掉），写 `before-apply` 快照；`dry:true` 只算差异
  - `GET /api/config/drift`：与 `last-applied.json` 比对，用于发现手改
  - `POST /api/config/snapshot` / `GET /api/config/snapshots` / `GET /api/config/snapshot?file=`：快照存取（保留 80 份，文件名白名单防穿越）
- 设置页新增「配置即代码」卡（载入/预览/应用/存快照/看漂移 + 快照表一键填回编辑器），并加入分区导航。
- 实测：把 `/api/config` 原样 apply 回去 → `{added:0,removed:0,changed:0}`、Caddy 仍 5 条路由、两条隧道不重启；drift 立刻一致。
- 测试：API 210、DOM 110、e2e 23。

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
