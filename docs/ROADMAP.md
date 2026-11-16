# 技术路线图 · cf-tunnel-panel

本文分三部分：**① 为什么这样选型**（含被否掉的方案）、**② 版本路线**（已完成/计划）、
**③ 已知边界与不打算做的事**。

---

## ✅ v0.14.1 — 轮询变轻、断网有话说

| 项 | 实现 |
| --- | --- |
| 协商缓存 | `sendJson` 输出 `W/"len-sha1[-gz|-id]"` + `private,no-cache`；304 无正文 |
| 离线页 | `sw.js` v2 + `offline.html`（navigate 失败兜底，缓存本地） |
| 设置搜索 | `#cardSearch` 过滤 `.card[id^="sec-"]`，chips 联动 |
| 窄屏图表 | `.chart{height:126px}`、`.chart-x{font-size:10px}` |

测试：API 193、DOM 97、e2e 23。

## ✅ v0.14.0 — 从看到数字到能追下去

| 项 | 实现 |
| --- | --- |
| 统计时间窗 | `/api/routes/stats?hours=`（1..168）+ 规则页 `#hitHours`（持久化） |
| 图表悬停 | `barsSvg` 每列包 `<g><title>`；`drawHist` 每个点加 `<circle><title>` |
| 出口恢复 | `monitor.js` 的 `prevTunnelStatus` 状态机 → `notify('tunnelUp')` |
| 审计导出 | `GET /api/audit.csv`（BOM + 附件头，`limit`/`q` 沿用） |
| IP 筛选 | `#accIp` + `?ip=` + 表格内可点链接 |
| 潜伏 bug | 访问日志补 `at` 字段（5xx 尖峰告警此前从未生效） |

测试：API 186、DOM 95、e2e 23。

## ✅ v0.13.9 — 图表重做

| 项 | 实现 |
| --- | --- |
| 刻度不再被拉伸 | `chartLabels(keys)` 输出 `.chart-x > span{left:%}`，与 SVG 绘图区解耦 |
| 柱子不被切 | `CPAD = 1.2`（viewBox 单位）左右留白，柱宽 `bw*0.68` |
| 网格与余量 | `gridLines()` 画顶/中/基线；`max*1.08` 防止峰值顶边 |
| 单点不空白 | `drawHist` 在 `points.length < 2` 时给明确说明 |
| 布局 | 概览三图 `.grid2` → `.grid3` |

测试：API 180、DOM 94、e2e 23。

## ✅ v0.13.8 — 修好登录（并堵住口令泄漏）

| 项 | 实现 |
| --- | --- |
| 内联脚本被 CSP 拦 → 登录退化成 GET 提交 | 登录逻辑移到 `src/web/assets/login.js`，表单用 `data-next` 传跳转目标 |
| 语言包内联也被拦 | 新增 `GET /boot.js`（gzip、`no-store`、鉴权之前），八页 + 登录页引用 |
| 防回归 | API：任何页面不得有内联 `<script>`；DOM：登录页必须引用 `login.js` 与 `/boot.js` |
| 善后 | 访问日志 4 条 `password=` 明文已打码 |

测试：API 180、DOM 91、e2e 23。

## ✅ v0.13.7 — 谁在敲你的门

| 项 | 实现 |
| --- | --- |
| 按规则/按 IP 聚合 401·403 | `insight.securityAttempts(hours, limit)`，读日志末 4MB，`simulateMatch` 归属 |
| 接口 | `GET /api/security/attempts?hours=&limit=`（hours 0.1–168） |
| 页面 | 观测页「可疑访问」卡：规则的拒绝次数 + 主要来源 IP，IP 维度表；规则名链到 `/rules?focus=` |
| 告警 | 单 IP 10 分钟 ≥20 次 → `authScan` 通知，30 分钟冷却 |

测试：API 176、DOM 87、e2e 23。

## ✅ v0.13.6 — 从日志直接跳进规则

| 项 | 实现 |
| --- | --- |
| 行级归属 | `/api/access` 对每行跑 `simulateMatch`，命中则附 `rule{id,name}` |
| 行可点 | 观测页路径单元格 → `/rules?focus=<id>`（复用 v0.13.5 的定位高亮） |
| 规则命中量 | 规则卡片徽标：`命中 N · 错 M · p95 Xms`，数据源 `/api/routes/stats` |

测试：API 171、DOM 84、e2e 23。

## ✅ v0.13.5 — 从「看到」到「跳过去」

| 项 | 实现 |
| --- | --- |
| 分组带 id | `trafficByPath` 的每组补 `id / path / tunnelId`（来自 `simulateMatch` 命中的规则） |
| 图例即链接 | `.tag.jump` → `/rules?focus=<id>`，hover 有下划线提示 |
| 定位高亮 | `rules.js` 读 `focus` → 切作用域 → `scrollIntoView` → `data-focused` + `.flash` 动画；规则不在了给 toast |

测试：API 169、DOM 83、e2e 23。

## ✅ v0.13.4 — 看得见「谁在吃流量」

| 项 | 实现 | 实测 |
| --- | --- | --- |
| 按规则聚合 | `insight.trafficByPath(hours, top)`：2MB 日志尾部 → `simulateMatch` 归属 → 每小时分桶 | 12 小时：面板 92、ttyd 24、Adminer 3、whoami 1 |
| 未匹配单列 | `unmatched:{total,err}` 不计入图例 | 318 次（健康检查/`/qa` 探针），其中 5xx 29 |
| 图 | 概览「按规则看流量」堆叠柱 + 图例（规则名 · 总量 · 5xx） | 4 组配色取自 `--acc/--warn/--err/--dim` |
| 部署提醒 | 预热写 `state.warm{code,at,host}`，概览比对 `/healthz.code` | 不一致时出黄条并链到工具箱 |

测试：API 168、DOM 81、e2e 23。

## ✅ v0.13.3 — 缓存生命周期闭环

| 项 | 实现 | 实测 |
| --- | --- | --- |
| 资源指纹 | `web.js` 的 `AV()` 给每个 `<link>/<script>` 拼 `?v=<codeHash[0:8]>` | 登录页输出 `app.css?v=a366b028` |
| 一年 immutable | `server.js` 的 `/assets/` 分支检测 `?v=` → `max-age=31536000, immutable` | 带指纹 `immutable`，无指纹仍 `300` |
| 预热 | `POST /api/cf/cache/warm`，并发拉关键 URL，回 `cf-cache-status/age/colo/ms` | 资源 `MISS 1109ms` → `HIT age=19 260ms` |
| 通知模板 | `notify.template` + `applyTemplate()`，`{text}` 缺失时自动附原正文 | 端到端打到本地 sink：标题 `[tunnelDown] host`，正文含时间与在线数 |
| 事件开关回归 | `notify.events` 之前只回写 4 项，会把关掉的 `errorSpike/loginFail` 又打开 | 现在 6 项都保留 |

测试：API 163、DOM 79、e2e 23。

## ✅ v0.13.2 — 传输层与体验收尾

| 项 | 实现要点 |
| --- | --- |
| 边缘缓存 | 资源头 `public, max-age=300` + `Cloudflare-CDN-Cache-Control: 86400`；`GET/POST /api/cf/cache/rule`（Cache Rule）、`POST /api/cf/cache/purge`；实测 DYNAMIC→MISS→HIT |
| 静态资源免登录 | 移到 `checkAuth` 之前（登录页要 app.css；也让 CF 能公开缓存） |
| JSON gzip | `sendJson` >1KB 且接受 gzip 时压缩，`/api/state` 降 68% |
| ETag 分编码 | `-gz` / `-id` 后缀，避免代理把压缩体发给不支持的客户端 |
| 通知重发 | `POST /api/notify/resend`（force + ignoreDisabled）+ 设置页按钮 |
| 分区导航 | 设置页 `.subnav` 吸顶 13 锚点 |
| 测试 | API 156（+9：缓存头/匿名资源/ETag/gzip/重发/缓存规则）、DOM 78（+3：子导航/锚点/重发按钮） |

## ✅ v0.13.1 — 恢复码轮换 + 端到端测试补齐

| 项 | 实现要点 |
| --- | --- |
| 恢复码重新生成 | `POST /api/totp/recovery`（验证码或旧恢复码换 10 个新码，只存哈希）；设置页按钮 + 一次性展示 |
| E2E 23 项 | strip / keep / basicAuth(401,401,200) / Host 隔离（含未登记 404）/ WS 101 / 404 / 维护 503+Retry-After / IP 黑名单 403 / admin 20190 / access log / trusted_proxies / 还原校验 |
| 审计去重 | 兜底记录遇到同请求的人话记录（1 秒内同 method+path+status）即丢弃 |
| 测试修复 | 探针前缀改成不嵌套；Host 断言用原始 socket（fetch 不能改 Host）；补 chunked 解码 |

## ✅ v0.13.0 — 二次验证 + 角色细分 + 真 Caddy 的 CI

| 方向 | 实现要点 | 实测 |
| --- | --- | --- |
| TOTP | `core/totp.js` 自实现 base32/HOTP/TOTP（±1 步窗口）、`newRecovery(10)` 一次性恢复码只存 sha256 | 19 项端到端：生成→扫→开启→两段登录→恢复码→关闭 |
| 两段登录 | `login()` 返回 `{needTotp, challenge}`（HMAC-SHA256 签名、5 分钟），`completeTotp()` 校验验证码/恢复码后建会话 | 口令对但不发会话；错码 401；恢复码用掉后余量 -1 |
| 登录页 | 验证码框默认隐藏，口令通过才显示；新增「记住这台设备」 | DOM 测试 75/75 |
| 角色 | `core/perm.js` 白名单：operator 可改隧道/规则/分享/curl/主机名/退出，其余 403 并说明原因；viewer 只读 | operator 改规则 200、改设置/口令/导入/回滚全 403 |
| 运维账号 | `POST /api/operator`（用户名正则、密码 ≥6、留空关闭），保存即 `session.revokeAll()` | 设置后可读可改规则、关闭后 Basic 立刻 401 |
| CI e2e | `test/e2e-caddy.mjs` + `.github/workflows/ci.yml` 的 `e2e` 作业：真 caddy:2.11.9-alpine（admin :20190） | 本地 8/8；抓 `load_balancing` 之类字段错 |
| 脚本健壮性 | e2e 先把规则快照到 `/tmp`，finally 还原 | 已验证「还原规则表 5 vs 5」 |

**测试**：API 141/141、DOM 75/75、e2e 8/8。

## ✅ v0.12.0 — 从配置页到小运维台

| 方向 | 实现要点 | 实测 |
| --- | --- | --- |
| 会话登录 | `core/session.js` 重写：cookie 值只存 sha256、落盘防抖、`remember` 30 天 / 普通 7 天、空闲 12h 过期 | 重启容器后带同一 cookie 仍 200；磁盘上无明文 id |
| 踢设备 | `GET /api/sessions`、`POST /api/sessions/revoke`、`/revoke-others`、`/revoke-all`；改口令自动踢光 | 改口令后旧 cookie 401、返回 `relogin/revoked` |
| 未保存守卫 | `app.js` 全局 `unsaved` + `beforeunload` + 站内 `<a>` 拦截；三个页面 `__cfpSetUnsaved` 联动 | DOM 测试：输入后 6s 轮询不丢、出现「未保存」 |
| 单实例锁 | `state.acquireLock()`：pid + `/proc/<pid>/cmdline` 校验，`exit` 释放 | 第二个实例打印 `[fatal] 已有面板实例在运行` 并退出 1 |
| Caddy admin | 端口 2019 → 20190，`ADMIN_LISTEN` 跟随 `CADDY_ADMIN`，`pusher` 多地址回退（含各自 Origin） | 迁移后 `20190` 200、`2019` 关闭，6 条路由正常 |
| 主机名管理 | `GET .../ingress`、`POST .../hostnames`、`POST .../hostnames/delete`，保留兜底 `http_status:404`，可选建/删 CNAME | 加 `demo2.jianghugs.shop` → 12s 后公网 200；删除后 404 |
| 按规则统计 | `GET /api/routes/stats`：用 `simulateMatch` 归属日志行，输出 count/err4/err5/upgraded/p50/p95/max/bytes + 未命中 | 面板规则 134 次 0 错误；ttyd 9 次全是 WS 101（`upgraded`） |
| 更多告警 | `monitor.js` 每 5 分钟体检：5xx 占比 ≥10%（样本 ≥20）、10 分钟内登录失败 ≥5，事件 `errorSpike`/`loginFail` | 事件键已进默认 state 与设置页复选框 |
| YAML 导出 | `GET /api/export.yaml`：自写小 YAML 序列化器，只输出 settings/tunnels/routes 的公开字段 | 导出含 `routes:` 且无 `pass:` / `$2b$` / `cfat_` |
| PWA | `assets/manifest.webmanifest` + `icon.svg` + `sw.js`（只缓存 `/assets/*`），`app.js` 在 https 下注册 | 三个静态资源 200 |
| GHCR | `.github/workflows/release.yml`：`v*` 标签构建 amd64+arm64 推 ghcr.io | 工作流已入库 |
| 删旧页 | 移除 `/legacy` 路由、入口与 `src/ui.html`（96KB） | 测试改为断言 `/legacy` 返回 404 |

**测试**：`test/api.test.mjs` 116/116、`test/dom.test.cjs` 75/75。
**未做（留在下一批）**：TOTP 二次验证；admin / 只读之外的角色权限细分；CI 里跑真 Caddy 的端到端。

## ✅ v0.11.1 — 通知格式与加签

| 项 | 说明 |
| --- | --- |
| 按格式校验地址 | 钉钉/飞书/Bark 的正则校验，填错直接 400 并给出该平台正确样例 |
| 加签 | `settings.notify.secret`；钉钉 `timestamp`+`sign` 进 URL，飞书进 body，均为 HMAC-SHA256 base64 |
| UI 自适应 | 切格式改标签/占位符/提示；密钥字段仅钉钉飞书可见；可单独清空密钥不动其它字段 |
| 回归 | API 111、DOM 75 |

## ✅ v0.11.0 — 双语收尾与会话安全

| 项 | 说明 |
| --- | --- |
| 帮助文案双语 | 171 条页面文案 + 属性文案入库，字典 229 条；文本节点级精确替换，翻不到保持中文 |
| 会话换 IP 告警 | 同一 cookie 换来源 IP → 审计 + 通知 + 会话表「换过 IP」标记 |
| 退出全部设备 | `POST /api/sessions/revoke-all` + 设置页按钮 |
| 改口令踢会话 | 改面板口令 / 只读账号后 `revokeAll()`，前端跳 `/login` |

## ✅ v0.10.0 — 会话登录 / 变更趋势 / 中英界面
| 项 | 实现 |
| --- | --- |
| 会话式登录 | `/login` + `cfp_sid`（HttpOnly、SameSite=Lax、HTTPS 加 Secure），7 天 / 12 小时闲置失效；Basic 保留 |
| 会话可见可踢 | `/api/sessions`、`/api/sessions/revoke`、`/api/sessions/revoke-others`，设置页表格 + 逐行踢掉 |
| CSRF | 会话写请求校验 `Sec-Fetch-Site`/`Origin`，跨站 403 并记审计 |
| 变更趋势 | `/api/audit/trend` + 概览第三张柱状图（失败叠红） |
| 中英界面 | `cfp_lang` cookie、左下角切换、服务端 `<html lang>` 与导航翻译，前端 161 条字典精确替换 |
| 未登录跳转 | 页面 302 → `/login?next=`，API 保持 401 JSON |

## ✅ v0.9.0 — 拆模块 + 审计日志

| 项 | 结果 |
| --- | --- |
| `server.js` 拆分 | 2543 行 → 约 800 行（只剩路由表 + 装配 + 启动），逻辑搬进 `src/core/` 15 个模块 |
| 模块边界 | 常量/工具/状态/注册表/鉴权/Caddy 配置/下发/进程池/可观测/测速/探测/集成/通知/页面/巡检/审计，依赖单向无环 |
| 拆分方式 | 按顶层声明做块级搬运（不重写逻辑），跨模块引用用 acorn 做自由变量分析自动补 `require` |
| 状态共享 | `state.js` 导出 `stateProxy`（Proxy 读写同一个对象）+ `setState()`，避免"解构出旧对象"这类坑 |
| 审计日志 | 记录改状态请求与失败的 API 调用：人 / IP / 动作 / 状态码 / 耗时；内存 500 条 + `data/audit.log`（2MB 轮转） |
| 审计查询 | `GET /api/audit?limit=&q=`，观测页新增「审计日志」卡片（搜索 + 10 条/页分页） |
| 测试 | API 86 项（+6 审计）+ 页面 57 项（+3 审计）全绿 |
| 顺手修的坑 | `paths.js` 里 `__dirname` 变了导致 `web/`、`ui.html`、`package.json` 路径错一层（本地跑会 404 / 版本号变 0.0.0） |

## ✅ v0.8.1 — 安全修补 + 工程底座

| 项 | 内容 |
| --- | --- |
| 安全 | 修 `POST /api/settings` 回包把 Cloudflare token / webhook URL 明文回显（`/api/state` 早已脱敏，这个回包漏了）→ 统一 `publicSettings()`；新增 2 条接口断言 |
| 运行身份 | 面板容器改 `user: "${PUID:-1000}:${PGID:-1000}"`，`data/state.json` 不再 root 属主（实测 chown 后 POST 设置可写） |
| 镜像 | `Dockerfile` 基础镜像锁版本 + `--build-arg` 可覆盖；`caddy:2.11.9-alpine` 锁版本（生成的 JSON 依赖其字段名） |
| 文档 | `README.md` 改英文默认、原中文版改名 `README.zh-CN.md`，两页顶部互相切换；新增「更新时要 rebuild，否则 compose up 会把代码退回镜像版本」警告（实测踩到：面板自己退回 v0.5.0） |
| 工程 | 新增 `CHANGELOG.md`、`.github/workflows/ci.yml`（语法检查 + 无 Caddy 冒烟：healthz/6 页面/静态资源/badge/metrics） |

## ✅ v0.8.0 — 体验补齐（P0→P3 全量）

| 档 | 项 | 落地 |
| --- | --- | --- |
| P0 | 4 处 `prompt()` 改成内联表单 | 规则导入 → textarea；云端建隧道 → 内联表单（名字/域名/CNAME/加本地出口四个控件）；CNAME 指向 → 下拉选隧道 |
| P0 | 规则页搜索 | `#ruleFilter` 实时过滤 name/path/upstream/host/note，无匹配有提示 |
| P0 | 作用域记忆 | `selectedExit` → `localStorage['cfp-scope']`，刷新回到上次出口 |
| P0 | 观测页筛选 | 状态（2xx/3xx/4xx/5xx/仅错误）+ 路径子串 + 时间范围（5m/1h/24h/全部） |
| P0 | 日志可暂停 | 「暂停 / 继续」+「只看错误」，暂停后不再追加也不再滚动 |
| P1 | 流量趋势图 | `/api/traffic` 按小时聚合，手写 SVG 柱状（红叠 4xx/5xx），6/12/24 小时可切 |
| P1 | 出口在线历史 | 每分钟 `sampleHistory()`（含当分钟请求数），`/api/history` 出折线 |
| P1 | 通知发送记录 | `notifyHistory`（50 条，含静默/冷却拦下的），设置页表格 |
| P1 | 变更时间线 | 备份列表把 reason 翻成中文 + 本地时间 |
| P2 | 响应式 | 新增 1200px（4 列→2 列）/ 720px（表格变卡片 `.stackable`、顶栏换行、图高收缩） |
| P2 | 无障碍 | 跳转主内容链接、`.nav`/按钮 `aria-label`、`:focus-visible` 描边、`role=status` |
| P2 | 只读账号 | `state.viewer` + `POST /api/viewer`，`checkAuth` 返回 `readonly`，非 GET 一律 403 + 顶部横幅 |
| P2 | Ctrl+K | 页面/出口/规则统一搜索，↑↓ 回车跳转 |
| P2 | i18n | 仍然押后（6 个页面 + 1500 行中文文案，投入产出比最低） |
| P3 | 测试入库 | `test/api.test.mjs`(78) + `test/dom.test.cjs`(54) + `npm test`，凭据走 `PANEL_PASS` |
| P3 | 系统信息 | `/api/system` + 设置页表格（版本/Node/运行时长/state 大小/备份数/日志大小/内存） |

顺带修的坑：

- 导入脱敏配置会**把面板密码清空**（导出里 `panel.pass` 是空的）→ 导入时「同名用户 + 空密码」沿用旧密码；只读账号同理。
- jsdom 测试里硬编码 `127.0.0.1:8090` 的请求绕过了鉴权代理 → 统一走 `BASE`。
- 概览页 SVG 用了不存在的 CSS 变量（`--accent/--danger/--muted`）→ 改回 `--acc/--err/--dim`，否则图上不了色。
- Caddy 的 `ts` 是 Unix 秒浮点（不是 ISO 串），流量分桶一开始全是 0。

## ✅ v0.7.9 — Cloudflare API 集成做厚（已完成）

**新增端点**
| 端点 | 作用 |
| --- | --- |
| `GET /api/cf/verify` | 试 `/user/tokens/verify` + `/accounts` + `/zones`，任一成功即算可用；返回 `suggest{accountId,zoneId}` 与域名表格 |
| `GET /api/cf/tunnels/<id>` | 隧道详情（含连接的 `colo_name` / 客户端版本 / 建立时间） |
| `POST /api/cf/tunnels/<id>/token` | 取隧道 token（面板里一键复制） |
| `GET /api/cf/dns?name=` | 查 DNS 记录（支持按名字过滤） |
| `POST /api/cf/dns` | 建记录（CNAME→`cfargotunnel.com` / A→VPS），`proxied` 可关 |
| `POST /api/cf/dns/<id>/delete` | 删记录 |

**前端**（工具箱页 CF 卡）：验证按钮 + 域名表「用这个」自动填 Zone ID；隧道表加「连接数」「复制 token」；新增 DNS 记录表格与增删；两段说明文字点明「公共主机名只能在后台加」。

**文档**：README §6.8 从一屏扩成六小节（能做什么/做不到什么、五步接上、Token 最小权限表、每个按钮对应的 API、DNS 小抄、错误对照表 7 行、安全须知）。

**验证**：真实 token 下 `verify` 返回「有效（…够用）」并带出 `<account-id>` / `<zone-id>`；`/api/cf/dns` 列出 8 条真实记录（含 `demo.example.com → <tunnel-id>.cfargotunnel.com`）；API 测试补 read-only 断言，71/71。

## ✅ v0.7.8 — 一次性分享链接被兜底规则挡住（已完成）

**症状**：`/s/<token>` 打开 401（撞面板登录）或 404。

**根因**：`buildCaddyConfig()` 把分享路由 push 在业务规则之后；Caddy 顺序命中，任何 `path=/` 的兜底规则（面板 `/` → 8090、静态站 `/` → 8088…）先吃掉 `/s/<token>`。

**修法**：新增 `securityTail` 记录「安全层（IP 黑名单 / 维护模式 / 限流）之后的长度」，分享路由先收进 `shareRoutes` 再 `routes.splice(securityTail, 0, ...shareRoutes)`；匹配同时覆盖 `/s/<token>` 与 `/s/<token>/*`。

**验证**：`/api/caddy/config` 里分享路由位于 index 0–2；公网 `https://panel.example.com/s/<token>` 无凭据 200、子路径 200；回归新增 3 条（创建、面板域名下可达、子路径透传），68/68 通过。

## ✅ v0.7.7 — 面板内置测速 + 轮询排查收尾（已完成）

**为什么做**：之前测速只能在宿主机跑 `tools/bench.sh`，还得会 curl；「到底有多快」是这套系统最常被问的问题。

**新增**
| 能力 | 位置 |
| --- | --- |
| `GET /__bench/ping` | 返回 `{ok,colo,t}`，`colo` 从 `cf-ray` 解出边缘机房（不经 Cloudflare 时为空） |
| `GET /__bench/blob?mb=N` | 流式 N MB 零字节（上限 32MB，`no-store`，带 `X-Bench-Bytes`） |
| `POST /api/bench/local {n}` | 服务端打 `127.0.0.1:${CADDY_PORT}`，返回 ttfb `{min,median,max}` |
| 工具箱「测速」卡 | 一键测：延迟中位/p95、本机对照、下载 MB/s、估算 Mbps、结论文案、机房 |

**顺带修（同类 bug 排查）**：`observe.js` 的 8 秒自动刷新加三道守卫（后台标签页不刷、光标在访问表内不刷、正在选中文字不刷）；`tools.js` 的分享列表轮询在后台标签页不刷；其余页面（总览/设置/侧栏健康点）确认无表单，不会被轮询覆盖。

**实测**（公网 `https://panel.example.com`）：`colo=AMS`，延迟中位 1.43s / p95 3.0s，5MB 下载 15.79s = 0.32 MB/s（2.66 Mbps），首字节 1.60s；本机 → Caddy 4ms。回归 65/65（API）+ 28/28（DOM）。

## ✅ v0.7.6 — 规则页编辑不再被轮询顶掉（已完成）

- `rules.js`：新增 `isEditingRules()`（看 `document.activeElement.closest('#ruleList')`）；`refresh()` 在 `dirty || isEditingRules()` 时只刷 `renderWarns()`，绝不重建规则列表；`#ruleList` 上的 `input`/`change` 事件委托直接 `markDirty()`。
- 顺带确认其他轮询不会咬人：`observe.js` 访问表保留当前页码（只做越界夹取）、`tools.js` 只刷分享列表、`overview.js` 无表单、`settings.js` 没有轮询。
- `/api/tunnels` 补上 `publicUrl`（命名隧道用 `publicHostname` 推），和 `/api/state` 保持一致；之前只有 `/api/state` 有，脚本调 `/api/tunnels` 会以为所有出口都没地址。
- 回归：`/tmp/domtest.cjs` 新增两条（输入后 6.5 秒值不变、出现「未保存」提示），28/28。

## ✅ v0.7.5 — Tunnel Token 粘贴容错（已完成）

| 问题 | 处理 |
| --- | --- |
| 用户从 Cloudflare 复制的是整条 `docker run … --token eyJ…` 命令，粘贴后 cloudflared 报 `Provided Tunnel token is not valid` | 新增 `normalizeTunnelToken()`：正则抠出 `eyJ…` 候选 → base64 解码 → 校验 `{a,t,s}` 三字段；存进去的是裸 token，日志里记一行「已自动抠出」 |
| 不知道手里这个 token 属于哪条隧道 | token 解码出的隧道 id 存为 `tokenTunnelId`，卡片里显示「当前 token 属于隧道 `0cbc1a01…`」；对不上就是拿错了 |
| 粘了垃圾内容也照存 | 解析失败直接 400：「这段内容里找不到隧道 token…」；已存的坏 token 在卡片上标红「解析不了，请重新粘贴」 |

实测：把 `docker run … --token eyJ…` 整条粘进去 → 创建成功且 `tokenTunnelId` 正确；粘 `eyJhbGciOiJub25lIn0`（无 a/t/s）→ 400 人话提示。

## ✅ v0.7.4 — 命名隧道可用性（已完成）

| 问题 | 处理 |
| --- | --- |
| token 错/被吊销时每 5 秒重启一次 cloudflared，日志刷屏 | 识别 `token is not valid` / `invalid tunnel secret` / `unauthorized` → 标记 `fatal`，**停止自动重试**，`lastError` 写成人话（去哪里重新复制 token） |
| 其他死循环（端口冲突、二进制坏）无声重试 | 兜底：连续 5 次启动失败 → 也停止重试并提示「修好后点启动」 |
| 出口卡片不告诉你缺什么 | 新增标签：`还没填 Token` / `还没填公网域名` / `Token 无效 · 已停止自动重试`；Token 输入框 placeholder 改「已配置，留空不改」；公网域名旁注明必须与 Cloudflare 公共主机名一致 |
| `/api/state` 的 runtime 没有致命标记 | `runtimeOf()` 增加 `fatal` |

实测：无效 token 的出口在 45 秒窗口内只产生 5 行日志（此前 25 秒 20 行），随后保持 `error` 不再重启；`panel.example.com` 公网 `/`、`/tunnels`、`/rules`、`/settings`、`/assets/*`、`/metrics` 全部 200，无凭据 401。

## ✅ v0.7.3 — 公网可用性加固（已完成）

| 能力 | 说明 |
| --- | --- |
| 真实客户端 IP | 下发 `trusted_proxies`（内置 Cloudflare 22 段）+ `client_ip_headers: [CF-Connecting-IP]`，隧道后的 IP 白名单/黑名单、访问统计、登录锁定都按真实访客算；`CLOUDFLARE_IPS` 可覆盖段表 |
| 面板登录防爆破 | 同 IP 10 分钟错 8 次 → 锁 10 分钟（429 + `Retry-After`）；密码正确的请求不受影响；失败与锁定写日志 |
| `/metrics` 免登录 | 面板开了登录后，Prometheus 仍能直接抓取（内容只有聚合计数） |
| 命名隧道友好 | 前端展示命名隧道的公网地址（`publicUrl` 来自 `publicHostname`），不再显示"还没有公网地址" |

实测：`curl -H 'CF-Connecting-IP: 203.0.113.9'` 且临时信任 `127.0.0.1/32` 时，access log 里 `client_ip=203.0.113.9`、`remote_ip=127.0.0.1`，证明取 IP 链路正确。

回归：`/tmp/apitest.mjs` 59/59、`/tmp/domtest.cjs` 26/26。

## ✅ v0.7.2 — 自检再进一步（已完成）

| 能力 | 说明 | 接口 / 位置 |
| --- | --- | --- |
| WebSocket 自测 | 经本机 Caddy 发一次真实 WS 握手，直接判定「能升级 101 / 不能升级」 | `POST /api/ws-test` · 工具箱 |
| 通知冷却 | 同一事件 N 秒内只提醒一次，其余写日志，避免掉线刷屏 | `settings.notify.cooldownSec` |
| 静默时段 | 支持跨零点与多段（`23:00-07:00`、`12:00-13:30,23:00-07:00`），格式错误保存即报错 | `settings.notify.quietHours` |
| 备份对比 | 每份备份可「对比当前」，列出新增/删除/改了哪些字段，先看清楚再决定回滚 | `GET /api/backups/diff` · 设置页 |
| Prometheus 指标规范化 | 每个指标都带 `HELP`/`TYPE`，补齐 `cf_caddy_ok`、`cf_tunnel_requests_total` 的元数据 | `GET /metrics` |
| Grafana 接入 | 抓取示例 + 可直接导入的面板 JSON + 两条建议告警 | `docs/PROMETHEUS-GRAFANA.md`、`docs/grafana-dashboard.json` |
| 顺带修 | 绑定到「还没公网域名」出口的规则会被误报成「被前面的规则拦住」——改为只进 `skipped`，不再产生假红条 | `shadowReport()` |

测试：`/tmp/apitest.mjs` 55/55、`/tmp/domtest.cjs` 26/26。

## ✅ v0.7.1 — 自检与可观测增强（2026-11-15）

| 项 | 实现 | 为什么值得做 |
| --- | --- | --- |
| 上游健康探测 | 服务端每 60s 对每条规则的上游做 TCP connect（900ms 超时），结果进 `/api/state` 的 `runtime.upstreams`；规则卡上游旁显示绿/红/灰小圆点，总览页汇总 | 502 是最常见故障，之前只能靠“测上游”一个个点 |
| 规则遮蔽检测 | `shadowReport()` 用每条规则自己的路径 + 域名跑一遍 `simulateMatch`，若命中的不是自己就是被前面挡住了；`runtime.caddy.shadowed` 暴露给前端显示红条 | `/` 兜底规则排中间会静默吃掉后面所有规则，这坑真实发生过 |
| 模拟匹配修正 | 出口没有公网域名时，专属规则在 Caddy 里根本不下发 → `simulateMatch` 现在同样跳过（之前会误判成“任意域名都匹配”） | 模拟结果必须和真实 Caddy 行为一致，否则误导排查 |
| Caddy 配置预览 | `GET /api/caddy/config` + 工具箱里的「生成并查看 / 复制」 | 看得到最终下发的东西，等于把黑盒打开 |
| 限流退避 | 检测 cloudflared 输出里的 `status 429`，退出后按 30s·2^n 退避（上限 15 分钟），退出原因写成人话 | 快速隧道被 Cloudflare 限流时，原来每 5 秒重试一次，越撞越久 |
| 安全响应头 + CSP | 页面与静态资源都带 CSP / nosniff / no-referrer / SAMEORIGIN | 面板本身就可能是公网入口 |
| /api 限流 | 同源每分钟 >1200 次 → 429 | 防误点与暴力枚举，代价为零 |
| 出口运行时长 / 重连次数 | `runtimeOf` 增加 `uptimeSec`、`reconnects` | 判断“隧道稳不稳”不用去翻日志 |
| 静态资源 ETag + gzip | `serveText()`：`If-None-Match` 命中 304；文本 >512B 走 gzip（`app.css` 12.5KB → 3.7KB） | 移动网络下首屏明显更快 |
| 属主修复脚本 | `tools/fix-perms.sh`（`docker exec` 改 `/data` 属主 + 放开 access.log 读权限） | 宿主机读 state.json 不再 Permission denied |
| 回归测试 | `/tmp/apitest.mjs` 49 项、`/tmp/domtest.cjs` 24 项（jsdom 真 DOM 交互） | 每次改完跑一遍，避免又出现“JS 插错位置”这类事故 |

## 一、技术选型与理由

### 1. 为什么是「cloudflared + Caddy + 面板」这三件套

| 候选方案 | 结论 | 理由 |
|---|---|---|
| 路由器端口映射 + DDNS | ❌ 否 | 需要公网 IPv4；本机在 CGNAT 后面（出口只有 IPv6），根本拿不到公网 v4；而且把内网端口直接暴露在公网 |
| frp / nps（自建中转） | ❌ 否 | 要一台有公网 IP 的服务器当中转，多一跳、多一份运维；还得自己搞证书 |
| Tailscale / ZeroTier | ❌ 否（部分场景 | 只能"装客户端的设备"访问，不能给家人朋友发个链接就看；Funnel 有域名和配额限制 |
| Cloudflare Tunnel（quick） | ✅ 采用 | 零账号、30 秒出域名，适合试跑和演示 |
| **Cloudflare Tunnel（named）+ 本地反代** | ✅ **主推** | 自有域名、稳定、TLS 在边缘终结（隐藏源站 IP）、可叠加 WAF/Access；出站隧道穿 NAT |

**结论**：隧道负责"把公网流量送到我机器"，**分流交给本地反代**。这两件事分开，各自都能替换
（比如将来把 Caddy 换成 Traefik，隧道侧一行不用动）。

### 2. 为什么分流放在 Caddy，而不是"云端 ingress"

Cloudflare 的 token 托管隧道（`cloudflared tunnel run` + `TUNNEL_TOKEN`）有一个硬约束：
**ingress 规则由云端下发**，本地配置文件被忽略。也就是说，想"加一条路径规则"就得去网页后台点，
或者调 Cloudflare API（要 API Token，权限还给得很大）。

所以本项目的做法是：

> 云端只配**一条**路由：`域名 → http://localhost:8080`（本地 Caddy）。
> 之后所有按路径/域名/方法/IP 的分流，全部在本地 Caddy 做，面板热加载。

好处：
- 改规则**毫秒级生效**，不需要动隧道、不需要 API Token、不需要重连（公网域名不会变）
- 规则和面板数据都在本地 `data/state.json`，可导出、可版本化、可迁移
- 将来换隧道提供商（cpolar / FRP / 自建）也不影响分流层

### 3. 为什么 Caddy 而不是 Nginx

- **配置即 JSON，可热加载**：`POST /load` 一次替换整份配置，原子生效，不用 reload 进程、不掉连接。
  Nginx 需要写文件 + `nginx -s reload`，还要自己管模板。
- **自动 HTTPS**：将来如果把 Caddy 直接暴露在公网（不走隧道），一句 `automatic_https` 就有证书。
- **内置基础认证 / 头改写 / 负载均衡 / 上游健康检查**，不用额外模块。
- 单二进制、镜像小、arm64 官方支持好。

代价：Caddy 的 JSON schema 版本间会变（本项目已踩过 v2.11 把
`load_balancing.selection` 改名成 `selection_policy` 的坑），需要跟着适配。

### 4. 为什么三个容器都用 `network_mode: host`

隧道上游是 `127.0.0.1:8080`。桥接网络下容器里的 `127.0.0.1` 指向容器自身，连不到 Caddy，
更连不到宿主机上只监听本机的服务（Jellyfin、Home Assistant、DSM 通常都只监听本机/内网）。
host 网络是最省事且最不容易出错的选择；代价是端口不隔离（8090/8080/8091 不能和别的服务撞）。

### 5. 为什么面板后端是"零依赖 node:http"

- 目标机器是 arm64 + glibc 2.31，**原生模块基本装不动**（本项目在同类环境下实测过
  glibc 2.33/2.35 依赖全都缺），所以只允许纯 JS 依赖：`qrcode`、`bcryptjs`。
- 面板逻辑就是"读 JSON 状态 → 生成 Caddy 配置 → POST 过去 → SSE 推日志"，
  用框架反而增加构建体积和踩坑面。
- 单文件 `ui.html`（无打包、无 npm 前端依赖），改完刷新即生效，小白也看得懂。

### 6. 状态与备份策略

- 单一事实来源：`data/state.json`（0600，含 token 与面板口令哈希）
- 每次变更落 `data/backups/<ISO时间>-<原因>.json`，**滚动 20 份**
- 导出默认**剥离 token**（`?full=1` 才带），避免"发给朋友看配置"时泄露凭据
- 密码只存 bcrypt 哈希，永不回显

---

## 二、版本路线

### ✅ v0.1.0 — 跑通最小闭环（已完成）

- 三容器 compose（panel / caddy / demo，全 host 网络）
- 快速隧道 + 命名隧道（token）
- 规则：host / path / strip / 上游
- Caddy 热加载、SSE 日志、二维码
- 实测：`/demo` 200、404 文案、规则增删即时生效、停启隧道换域名

### ✅ v0.2.0 — 配置灵活 + 小白友好（已完成，本版）

配置能力（后端）
- 规则高级项：请求方法、来源 IP(CIDR)、超时、**备用上游 + 负载均衡策略**、请求/响应头改写、**基础认证（bcrypt）**、备注
- 全局设置：Caddy 监听地址、面板标题、404 文案
- 隧道高级项：传输协议（auto/quic/http2/http2_ws）、日志级别、metrics 端口、额外参数
- 导出/导入（`?full=1` 才含 token）、滚动备份 20 份、配置迁移（`deepDefault`）

可用性（前端）
- 顶部「3 步跑起来」向导
- 每条规则一张卡片 + 高级折叠（不吓到新手）
- 模板下拉：whoami / DSH / Jellyfin / qBittorrent / 群晖 / Home Assistant / Immich / Gitea / Nextcloud
- 每条规则「复制公网链接」
- 面板登录保护、运行信息卡片、日志来源分色

实测清单（本地 + 公网各一遍）
| 项 | 本地 | 公网 |
|---|---|---|
| `/demo` 200 + `X-Panel-Route` | ✅ | ✅ |
| 基础认证 401 / 200 / 错密码 401 | ✅ | ✅ |
| IP 白名单外 → 404 | ✅ | — |
| 备用上游故障切换（主 9999 不通） | ✅ 200 | — |
| 请求头注入 + 响应头改写 | ✅ | ✅ |
| 方法限制（GET 404 / POST 200） | ✅ | — |
| 自定义 404 文案 | ✅ | ✅ |
| 导出/导入/备份/面板鉴权 | ✅ | — |

### ✅ v0.2.1 — 模板扩容 + 三类服务实测（已完成）

模板从 9 个扩到 **30 个**，按 5 组分类（`<optgroup>`）：

| 分组 | 内容 |
|---|---|
| 通用网页 | whoami、静态站点、Node/Python 应用、后端 API、WordPress |
| 运维/开发 | DSH、宝塔、Portainer、Grafana、Uptime Kuma、Gitea、code-server |
| 媒体/家庭 | Jellyfin、Plex、qBittorrent、Transmission、群晖、Home Assistant、Immich、Navidrome、Nextcloud |
| 数据库 Web 面板 | Adminer、phpMyAdmin、pgAdmin、mongo-express、RedisInsight、InfluxDB、MinIO 控制台 |
| 网页终端 | ttyd、Wetty、Shellinabox |

模板不只是"填三个框"：还带默认 `note`（卡片上显示用法提示）、视频类自带 `timeoutSec: 300`、
危险类带 `sensitive: true` —— 选中时面板**自动展开高级选项**并提示先填基础认证。

实测（`test/docker-compose.test.yml` 起了 nginx 静态站 + MariaDB 11.8 + Adminer + ttyd）：

| 类型 | 验证内容 | 结果 |
|---|---|---|
| 网页 | 公网 `/site/` 200、正文正确、**子路径资源** `/site/pixel.svg` 200 | ✅ |
| 数据库面板 | 公网 `/db/` 无凭证 401 → 带凭证 200 → 带 CSRF token 提交登录 → `Database: demo - db - Adminer`，库表列出 | ✅ 真实登录 MariaDB |
| WebSocket | 公网 `/term/ws` 升级 → `101 Switching Protocols`（本地同） | ✅ WS 透传 |
| 网页终端 | 公网 `/term/` 无凭证 401 → 带凭证 200（`ttyd - Terminal`） | ✅ |
| 反例 | 把 MySQL 3307 当 HTTP 上游 → 公网/本地**都 502**（二进制握手对不上） | ✅ 已写进 README §7.9 |

结论沉淀：**HTTP + WebSocket 的一切都能走本面板；原生 SSH / MySQL 端口不能**，
需要"Web 外壳"（ttyd/Adminer）或走 Cloudflare 的 TCP 路由（`cloudflared access ssh`）。

### ✅ v0.2.2 — 修「选了命名隧道，几秒后自己跳回快速隧道」（已完成）

**现象**：在面板把「隧道模式」切到 *命名隧道*，不点保存，几秒后下拉框自己回到 *快速隧道*；
网络一波动、SSE 一推送，正在填的 origin / 域名也可能被清掉。

**根因**：面板前端每 5 秒 `refresh()` 一次拿 `/api/state`，无条件 `fillForm()` 用服务端值覆盖所有表单控件。
原来的守卫只保护规则区：

```js
const active = document.activeElement;
if (!active || !active.closest || !active.closest('#rules')) { fillForm(); renderRules(); }
```

隧道卡片和设置卡片完全没保护，于是"用户的选择"每 5 秒被"服务端旧值"打回一次。

**修法**（三层，缺一不可）：

1. **脏标记**：`const dirty = { tunnel:false, settings:false }`，隧道卡片/设置卡片内任何 `input`/`change`
   事件（事件委托，不用逐个绑）都置脏，按钮旁显示「● 有未保存的改动（隧道设置），自动刷新已暂停」。
2. **回填守卫**：`refresh()` 只在「未脏 且 焦点不在这两张卡里」时才 `fillForm()`；
   保存成功后由 `fillForm()` 统一清脏并回填服务端真值。
3. **规则保护加强**：编辑规则期间，`refresh()` 不再用服务端 `routes` 覆盖本地 `S.routes`
   （`if (editingRules) d.state.routes = S.routes;`），否则边填边被旧数据顶掉。

**验证**：用桩 DOM 跑四组场景——切 named 后连刷 3 次仍是 named；保存后正确回填；焦点在隧道卡片时不回填；
编辑规则时 `S.routes` 不被覆盖。线上 `v0.2.2` 已 rebuild 生效。

**顺带说明**：命名隧道未填 Token 就点保存，服务端会保留 `mode: named` 并把隧道状态置 `error`
（提示「命名隧道模式需要先填写 Tunnel Token」），不会悄悄退回快速隧道 —— 之前的"跳回"纯粹是前端回填造成的假象。

### ✅ v0.2.3 — 把「Cloudflare 后台怎么配」搬进面板与文档（已完成）

用户反馈："cloudflare 那里如何添加设置也需要在网页中讲明白"——即**配隧道的人不该再去翻文档**。

- **面板内**（`src/ui.html` 隧道卡片底部）新增折叠指南 `<details class="guide">`：
  「4 步 + 每个字段填什么」，含中英文字段对照表、`服务 URL 必须是 HTTP 127.0.0.1:8080` 的原因、
  「不要执行 `cloudflared.exe service install`」的告警、多子域名正确姿势、1033/502/404 排错口诀、token 安全提示。
  默认折叠，不干扰老手；点开即用，不需要跳出去。
- **文档侧**（README §5.2）从原来 6 行步骤扩成 10 个小节：中英文界面对照、先决条件自检表、
  创建隧道拿 token、公共主机名逐字段填值表、链路 ASCII 图（浏览器→边缘→隧道→cloudflared→Caddy→服务）、
  四条分层验证命令 + 结果对照表（200/401/502/404/1033/530/1016）、多服务规划（子域名 vs 子路径）、
  可选 Cloudflare Access（含"会挡掉 App 和 curl"的坑）、常见问题表、token 安全与轮换。
- 排障速查表补 2 行（1033 / 530 / 1016 指向 §5.2.5）。

### ✅ v0.3.0 — 多隧道出口并行（已完成）

用户反馈：「我的意思是可以同时有多个隧道出口」——不是要一份更长的单隧道教程，而是**面板里同时跑多条 cloudflared**。

- **数据模型**：state 升到 v3，`state.tunnel`（单对象）→ `state.tunnels`（数组，最多 8 条），
  每条 `{id,name,enabled,mode,token,origin,publicHostname,protocol,loglevel,metricsPort,extraArgs}`；
  `migrateState()` 自动把旧配置升级成「主隧道出口」，老用户升级后不用重配。
- **运行时**：`runtimes = Map<id, {proc,status,pid,url,startedAt,lastError,desired}>`，
  每个出口独立 spawn/kill、独立日志前缀 `[名称]`、退出后按 `enabled` 5 秒自愈重启；
  metrics 端口撞车提前告警。
- **接口**：`POST /api/tunnels`（新建）、`POST /api/tunnels/<id>`（改+重启）、
  `<id>/{start,stop,restart,delete}`、`/api/tunnels/{start-all,stop-all}`（注意这两条必须排在 id 路由之前，
  否则 `start-all` 会被当成隧道 id）；旧 `/api/tunnel*` 保留兼容。
- **面板 UI**：隧道卡片改成出口列表，每条出口一张卡（名字/模式/quick 指向 or named token+域名/
  高级四件套/自启/保存·启动·停止·二维码·复制·删除），顶部「＋ 新增隧道出口 / 全部启动 / 全部停止」，
  徽章显示 `隧道：N/M 在线`；脏标记跟踪改为 `dirty.tunnels`（多卡批量编辑时轮询不再覆盖输入）。
- **实测**：同时跑两条快速隧道 → 两个 `trycloudflare.com` 地址同时在 `/demo` 返回 200、
  `/` 返回自定义 404、`/site/` 200、`/db` 401、`/term` 401（分流规则与出口数量无关）；
  单出口 stop/start 换新域名、delete 后回到 1 条；命名隧道不填 token → 状态 `error` +
  「命名隧道模式需要先填写 Tunnel Token」；旧 `/api/tunnel/stop|start` 仍可用。
- **文档**：README 新增 §5.3「同时跑多个隧道出口」（三种组合、四条操作步骤、出口≠服务、
  metrics 冲突、绕过 Caddy 的代价、删除不动云端）。

### ✅ v0.3.1 — 布局与「出口没有规则」的解释（已完成）

用户反馈：「新隧道出口为什么没有匹配的代理规则」。这其实是设计使然 ——
**出口只负责把公网流量送进 Caddy，具体给哪个服务由规则决定**，新建出口的根路径 `/`
当然没有规则。但面板不该让人猜，所以：

- 新增**根路径提示条**：没有任何规则匹配 `/` 时，隧道卡片里直接出现黄色提示
  「新出口点开会是 404，这是正常的」，并给两个按钮：一键加一条 `/` 的规则（预填演示上游）、跳到规则区。
- **布局重排**（桌面双栏 / 手机单栏）：`向导` 折叠成一条 → `隧道出口 | 运行信息` → `代理规则`（整行，
  字段多） → `设置 | 实时日志`。标题栏带计数（`N 个出口`、`x/y 条生效`），窄屏内边距收紧。
- 出口卡片头部改成 flex 行（名字 · 状态 · 地址 · 操作按钮同一行，窄屏自动换行），表单改两列；
  空列表有引导文案。

### ✅ v0.4.0 — 左出口 / 右规则（出口绑定规则）

用户要求：「左侧点击隧道，右侧就是隧道的规则」。

- **布局**：`main` 改成两列 —— 左栏 340px 是「隧道出口」列表（全局 + 每条出口，带状态圆点、
  在线地址、规则条数），右栏上半是选中出口的设置、下半是它的规则；运行信息进左栏，
  设置与日志整行铺底。窄屏（<1080px）自动堆成一列。
- **数据模型**：规则新增 `tunnelId`（空 = 全局）。旧规则自动是全局，无需迁移。
- **下发**：`buildCaddyConfig()` 里对 `tunnelId` 非空的规则，用 `tunnelHostOf(id)` 取该出口当前域名
  （命名隧道取 `publicHostname`，快速隧道从运行时 URL 里解析）作为 `Host` 匹配；`buildMatch(r, forcedHost)`
  在你手填的「域名」优先、否则用出口域名。拿不到域名的规则进 `lastSkipped`，`/api/state` 的
  `runtime.caddy.skipped` 返回，界面显示黄条「有规则没生效」。
- **自动重下发**：出口上线 / 掉线 / 快速隧道换域名时 `schedulePush()`（500ms 防抖）重发 Caddy 配置，
  否则绑定规则会指向旧域名。
- **实测**：出口 A `/own1` 200、出口 B `/own1` 404；出口 B `/own2` 200、出口 A `/own2` 404；全局 `/demo` 两边都 200。
  绑定到不存在的出口 → `skipped` 返回「所属出口已被删除」。

## ✅ v0.7.0 — 前端重做成多页面（2026-11-15）

单文件长页面在功能堆到十几个卡片后已经不可用（滚动几屏、脚本互相干扰），整体重写为多页 + 设计系统。

| 项 | 做法 |
|---|---|
| 结构 | `src/web/assets/`（app.css / app.js + 每页一个 js）、`src/web/pages/`（每页一段 HTML 片段），服务端 `pageShell()` 拼外壳 |
| 路由 | `/`、`/tunnels`、`/rules`、`/tools`、`/observe`、`/settings`；静态资源 `/assets/*`；旧单页保留 `/legacy` |
| 设计系统 | CSS 变量、深色默认 + 浅色覆盖、236px 侧栏、卡片/表格/按钮/标签/分页/toast 全套复用类；900px 以下侧栏转顶部 |
| 公共 JS | `api/esc/toast/initTheme/fmtTime/statusPill/PER_PAGE/pagerHtml/bindPager/copyText/loadState/rtOf/tunnelUrl/caddyOk/openLogStream/paintHealth` |
| 隔离 | 每个页面脚本 IIFE 包裹，避免多脚本共享全局词法环境时 `let ST` 重声明报错 |
| 回归测试 | jsdom 真实加载线上页面跑交互：20/20 通过（导航高亮、健康指示、主题切换+localStorage、出口卡片=2、规则添加后跨两轮 5s 轮询不消失、访问表分页、备份分页、版本号渲染） |
| 顺带修 | `readAccess()` 之前把 admin/tls 日志也当访问记录（method/uri 全空、状态 0），改为只收 `http.log.access`；`scrollIntoView` 加存在性判断 |

新增文件：`src/web/assets/{app.css,app.js,overview.js,tunnels.js,rules.js,tools.js,observe.js,settings.js}`、`src/web/pages/{overview,tunnels,rules,tools,observe,settings}.html`。

## ✅ v0.6.0 — 运维台：从"能配"到"能日常用"

上一版把规则做扎实了，这一版补的是**每天都会用到的手脚**：加规则、给链接、挂维护牌、挡扫描、收通知。

#### B 档：日常运维（全部已实现并实测）

| 功能 | 实现要点 | 实测 |
|---|---|---|
| Docker 一键加规则 | 挂 `/var/run/docker.sock:ro`，读 `/containers/json` + 每容器 `/containers/<id>/json` 取 `HostConfig.NetworkMode` 与 `Config.ExposedPorts`；端口猜测顺序：发布端口 → host 网络 + 像 Web 的 EXPOSE 端口 → 容器 IP | 11 个容器全部列出，`t-adminer` 正确给出 `127.0.0.1:8082` |
| 一次性分享链接 | 独立 `state.shares`，Caddy 侧 `/s/<token>` + `strip_path_prefix` + `reverse_proxy`；15 秒 janitor 清过期并自动重下发 | 生成 → `GET /s/<token>` 直接回源 200；到期自动消失 |
| 维护模式 | Caddy 最前面一条 `static_response 503` + `Retry-After`；隧道不用停 | 开启后 `/demo` → `503`，头里有 `Retry-After: 600`；关掉 → 200 |
| 全局 IP 黑名单 | 比一切规则更早匹配 `remote_ip.ranges` → `403` | `127.0.0.1/32` → 403，清空后 200 |
| 限流 | 标准 Caddy 无 `rate_limit` 模块，故**有开关但不乱下发**：只有 `CADDY_RATELIMIT=1` 且勾选时才写进配置，否则日志提示一次 | 见 [RATELIMIT.md](RATELIMIT.md)（xcaddy 编镜像步骤） |
| 掉线通知 | 5 秒采样出口状态/域名 + Caddy 下发结果；4 种格式（通用 JSON / 钉钉 / 飞书 / Bark） | 未配置时 `configured:false`；配置后逐事件推送并可「发送测试通知」 |
| 面板 HTTPS | `PANEL_TLS_CERT/KEY` 存在即用 `https.createServer`，读不到证书自动退回 HTTP 并记日志 | 无证书时正常 HTTP 启动，日志带 http/https 标识 |
| 手机端 + 深色 | 变量化配色 + `html[data-theme=light]` + 头部 🌗 按钮（localStorage 记住）；`max-width:720px` 下工具网格单列、输入框 16px 防 iOS 缩放、表格收窄 | 静态校验通过（本机无图形栈，观感待人工确认） |

#### C 档：产品化（已完成 3/5，另 2 项降级处理）

| 功能 | 状态 |
|---|---|
| Cloudflare API 集成 | ✅ 列隧道 / 建隧道（自动取 token）/ 建 CNAME / 删隧道；未配 token 时给明确提示而非静默失败 |
| /metrics + 徽章 | ✅ Prometheus 文本格式（面板、出口、规则、状态码计数）+ 免鉴权 `/badge.svg` |
| 非 HTTP（SSH/TCP/UDP） | ✅ 以"引导 + 命令生成"形式交付（面板内说明 + README §7.8/§7.9 三条正路）：Caddy 只做 HTTP，原生 TCP 端口挂 HTTP 上游必然 502（已实测反例） |
| 配置即代码 | ✅ 降级为宿主机脚本 `tools/git-snapshot.sh` + crontab（面板镜像里不带 git，避免为一个功能胖 50MB） |
| i18n | ⏸ 暂缓：UI 约 1300 行中文文案，做半套（只翻标题）反而更乱；等有真实英文用户再整体抽 `lang.js` |

#### D 档：细节（全部已实现）

| 功能 | 说明 |
|---|---|
| 面板内测试器 | `POST /api/curl` 打本机 Caddy，回状态码/耗时/字节/响应头/正文预览，可自定义 Host —— 用来区分"隧道断"还是"规则错" |
| 出口复制 | 出口卡片「复制出口」：按当前配置（含 token）新建一条，快速验证多出口/换账号 |
| 日志过滤 / 下载 | 关键字实时过滤 + `/api/logs/download` 整份下载 |
| 状态徽章 | `GET /badge.svg`，绿=有出口在线，红=全挂 |
| 重命名 | 出口卡片里直接改名字保存即可（本就有，这版补了"复制"补齐语义） |

#### 已知边界（这一版之后仍然存在）

- 限流依赖自定义镜像；标准镜像只能靠黑名单 + Cloudflare 侧规则。
- `data/state.json`、`data/caddy-logs/access.log` 仍是 root 所有，宿主机普通用户读要 sudo 或走 API。
- 快速隧道域名每次重启都会变（分享链接里的域名也一起变，token 不变但域名变了——分享给别人的链接失效）。
- i18n 未做。

### ✅ v0.5.0 — 规则自检三件套 + 一键回滚

用户挑的 A 档六项，全部落地并实测（`/healthz` → `"version":"0.5.0"`）。

| 功能 | 实现要点 |
|---|---|
| **测上游** | 新接口 `POST /api/rules/test {upstream}`：`net.connect` 探 TCP（2.5s 超时）+ 一次 HTTP GET 取状态码，返回 `{ok,tcpMs,totalMs,status,error}`。规则卡片上一个「测上游」按钮，结果就地显示。实测：`8091` → `TCP 5ms / HTTP 200`；`9999` → `端口 9999 没人监听（connection refused）`；非 URL → 提示格式 |
| **模拟匹配** | 新接口 `POST /api/match {path,host,method}`：用面板自己的规则表按「先域名、再方法、再路径前缀」推一遍，返回命中序号与规则详情；限定域名的规则会返回 `needHost` 提示。实测：`/db/index.php` → 第 1 条；`/zzz` → 第 3 条（`/` 兜底）；域名规则无 host 时提示补域名 |
| **访问统计** | Caddy 配置加 `logging.logs.default.writer{output:file,filename:/logs/access.log,roll_size_mb:10,roll_keep:3}` + 每个 server `logs:{}`；compose 把 `./data/caddy-logs` 挂到 Caddy 的 `/logs`。面板读同一份文件（`/data/caddy-logs/access.log`），新接口 `GET /api/access?limit=100` 解析成表格 + 状态码/路径/域名汇总 |
| **一键回滚** | 新接口 `POST /api/backups/restore {file}`：文件名白名单（`path.basename` + 正则）、`migrateState`→`deepDefault`→`validateRoutes`、保存后再 `syncTunnels()` 让新增/变更/删除的出口各自启停。实测：回滚成功、坏文件名 400、不存在的备份 400 |
| **调顺序** | 每条规则卡加 **↑ / ↓**，只在同一作用域内相邻交换（跳过别的出口的规则），置脏等保存 |
| **单条导入导出** | 「导出」把一条规则复制成 JSON（不含口令哈希）；「导入单条」粘贴 JSON 追加，`tunnelId` 自动落到当前作用域 |

顺带修掉的技术债：`VERSION` 改成从 `package.json` 读（热替换后 `/healthz` 不再显示旧版本号）。

已知限制：`data/caddy-logs/access.log` 由 Caddy 容器以 root 写入（宿主 `user` 直接读会 Permission denied，面板容器内读没问题）；`state.json` 同样是 root 所有。

### ✅ v0.4.3 — 出口切换做成顶部 tab 条

用户要求：「隧道出口这里应该是 tab，美观一些」。

- **结构**：原来左栏那张「隧道出口」卡片拆掉，改成 `main` 顶部整行 `nav.tabsbar` ——
  左边 `#exitList` 是一排 tab（`.tab` / `.tab.active`：圆点状态、名称、`快速 · N 条` 小标签，
  `title` 里带运行状态与公网地址），右边是「＋ 新增出口 / 全部启动 / 全部停止」。
- **样式**：新增 `.tabsbar` / `.tabs`（横向可滚动）/ `.tab` 全套 CSS，激活态是蓝底 + 蓝边；
  顺便补上了此前一直缺失的 `.tag`（全局/专属、命名/快速、作用域标签）与 `.guide>summary` 样式。
- **左栏**回归「设置 + 运行信息」，Cloudflare 配置指南移到页面底部整行（和 3 步向导并排，默认收起）。
- 窄屏（<720px）tabsbar 变上下两行，按钮靠右。

### ✅ v0.4.2 — 出口在左、规则在右（一屏看完）

用户要求：「规则是在隧道出口右侧，而不是下面」。

- **布局**：`main` 改成 `minmax(300px,360px) | 1fr`。左栏 `.leftcol` 用 flex 竖排三个卡片：
  出口列表 → **`<details>` 折叠的「⚙️ 出口设置」** → 运行信息；右栏整块是 `#rulesCard`（`min-height:72vh`），
  点左侧出口，右侧直接就是它的规则，不用再往下滚过设置卡。
- **顺带**：Cloudflare 配置指南从页首移到页底（默认收起，需要时展开），向导里的「右下角日志」改成「页面下方的实时日志」。
- 屏幕 <1080px 仍自动单列（左栏在上、规则在下）。

### ✅ v0.4.1 — 未保存的规则不再消失 + 作用域看得见

用户反馈：「添加规则的时候，等待一会规则就没了」。

- **真因**：`refresh()` 每 5 秒把 `/api/state` 的 `state.routes` 整体赋给 `S`，只有焦点在规则区里
  才保留本地副本 —— 用户点「+ 添加规则」后焦点在按钮上，于是刚加的规则在 ≤5 秒内被服务端旧数据覆盖，
  再 `renderRules()` 重画就"没了"。
- **修法**：新增 `dirty.rules` 脏标记，`renderRules` 里任何输入 / 添加 / 删除 / 改作用域都置脏；
  `refresh()` 变成 `if (editingRules || dirty.rules) d.state.routes = S.routes`，且脏的时候不重画规则区；
  保存成功（`d.caddy.ok`）才清脏。按钮旁新增 `#rulesDirty` 黄字提示。
- **作用域可见**：标题旁 `#scopeTag` 显示当前在编辑「全局」还是「出口：X」；每张规则卡右上角有
  「全局 / 专属」标签；规则卡「高级」新增「作用出口」下拉（可在全局与各出口之间搬移，搬完提示记得保存）。
- **万能前缀告警**：路径 `/` 命中所有请求，若不在最后一条，`#orderWarn` 黄条提示"后面 N 条永远匹配不到"
  并给「把这条移到最后」按钮；`addRootRule()` 也改成追加到末尾而不是插到最前。
- **回归测试**：抽出 `refresh()` 用桩对象跑两组断言 —— 脏时本地 3 条不被服务端 2 条覆盖且不重画；
  不脏时正常覆盖并重画。`updateOrderWarn()` 也跑了三组（`/` 在前提示、在后不提示、没有 `/` 不提示）。

### 🚧 v0.3.x — 多入口与可观测（进行中）

- [x] **多隧道**：同时跑多条 quick / named 出口，各自启停、自愈、独立日志
- [ ] **规则级出口绑定**（可选）：让某条规则只从指定出口进来（现在是所有出口都进 Caddy，按规则分流）
- [x] **速度基线 + 自测工具**：`tools/bench.sh`（机房/TTFB/吞吐一键对照），README §9「速度实测」记录
      代理层仅 +0.8 ms、本地 300 MB/s+、公网 0.45 MB/s 的瓶颈定位（家宽上行 & 入口机房）
- [ ] **Caddy 侧访问日志 → 面板流量统计**（按路径/状态码聚合，不必接 Prometheus）
- [ ] **规则导入/导出单条**（现在只能整份）
- [ ] **规则排序拖拽**（顺序即优先级，现在靠删了重建）
- [ ] **上游连通性自检**：保存时顺手 `curl` 一下上游，直接提示"端口不通"
- [ ] **变更历史回滚 UI**（备份文件已在，缺一键回滚按钮）
- [ ] WebSocket 明确支持验证（部分应用依赖 ws 升级）

### 🔭 v0.4 — 安全与多用户

- [ ] **Cloudflare Access 集成**：面板里填 Audience/AUD，自动加 `Cf-Access-Jwt-Assertion` 校验
- [ ] **多用户**：查看者/编辑者角色，操作审计日志
- [ ] **TOTP 二次验证**（面板登录）
- [ ] 规则级**速率限制**（Caddy `rate_limit` 模块需自行编译，或用 `crowdsec`）

### 🌱 v1.0 — 通用化

- [ ] 支持 **TCP/UDP** 服务（`cloudflared access tcp/ssh`，如 SSH、Minecraft、MySQL 原生端口）：
      需要本地隧道配置或云端额外主机名，面板负责读态与生成客户端连接指引，不代管 Cloudflare API
- [ ] 支持 **自定义 cloudflared 版本**（面板内下载/切换二进制）
- [ ] 支持**外部 Caddy**（已有 Caddy 实例时，只接管某个 server block）
- [ ] Helm chart / 一键脚本（`curl | bash`，自动装 docker + 起栈）
- [ ] i18n（中/英）

---

## 三、已知边界（不打算做 / 做不了）

| 边界 | 说明 |
|---|---|
| **不管理 Cloudflare DNS/隧道** | 需要高权限 API Token，且容易误删用户的 DNS 记录。本项目坚持"云端手工配一次，其余本地做"。这也正是它和 DockFlare/cloudflared-manager 的定位差异。 |
| **不做 TLS 终结** | 公网 TLS 在 Cloudflare 边缘完成；本地 Caddy 明文监听 `:8080`，避免"双重证书"配置地狱。若确实需要本地证书，可自行在 Caddy 里加 `tls` 并让隧道指向 `https://`。 |
| **快速隧道不保证稳定/不变域名** | Cloudflare 的设计如此，本项目不做"固化为命名隧道"的自动迁移（涉及账号授权）。 |
| **面板不是多租户** | 单实例、单管理员（可加一个基础认证口令）。要多人协作请等 v0.4。 |
| **端口不隔离** | host 网络是刻意选择，8090/8080/8091 需自行避让。 |

---

## 四、参考

- Cloudflare Tunnel 文档：<https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/>
- Caddy JSON 结构（v2.11）：`https://caddyserver.com/docs/json/`
- 同类项目（定位不同，可对照）：
  - `ChrispyBacon-dev/DockFlare` —— Docker label 驱动，自动建隧道/DNS（需高权限 API Token）
  - `cocardoso/cloudflared-manager` —— 浏览器管理隧道 + DNS CNAME（需 API Token）
  - `WisdomSky/Cloudflared-web` —— 单一镜像 + 极简启停面板（无分流能力）

## ✅ v0.11.2 — 口令哈希、清 require、代码指纹

| 项 | 做法 | 结果 |
| --- | --- | --- |
| 口令明文 | `src/core/secret.js`（bcrypt）+ 启动迁移 `migrate-secrets` | `state.json` 里只剩 `$2b$10$…` |
| Basic 认证变慢 | 成功凭据内存缓存 10 分钟，改口令即清空 | 页面加载 5.8s → <1s，`/api/state` 175ms → 10ms |
| 模块冗余 require | 逐条按「绑定名是否被引用」清理（含 `...X` 展开的正确匹配） | 18 个模块共删 121 条 |
| 镜像/运行代码漂移 | `tools/codehash.js` + `src/core/ident.js` + `/healthz` 的 `code/imageCode/drift` | 热替换会被识别为 `drift: true` |
| 拆分遗留 bug | `monitor.js` 的 `histTick` 改为模块内 `let` | 出口采样/掉线通知/历史曲线恢复工作 |
| Node 版本声明 | `package.json` 加 `engines.node >= 20` | — |

