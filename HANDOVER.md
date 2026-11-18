# 交接文档 · cf-tunnel-panel

> 写给接手这个项目的下一位 agent。读完这一份，你应该能：拉代码 → 改 → 测 → 发版 → 排障，全程不需要再问人。
> 最后更新：2026-11-18（v0.29.10 已发布，v0.29.11 的改动还在工作区没提交，见 §11）。

---

## 0. 三条先看

1. **不是玩具项目**：这是跑在自己服务器上的生产面板（公网 `https://panel.jianghugs.shop`），一台机器上正在承载真实流量。改完不要「先删了再说」，先看 §5 的不变量。
2. **每个版本都有测试**：`test/api.test.mjs` + `test/dom.test.cjs` + `test/e2e-caddy.mjs`。发版前必须全绿（§7）。
3. **当前工作区有未提交的 v0.29.11 改动**（8 个文件）。先把它收尾发掉，再开新分支做别的（§11 有逐条清单）。

---

## 1. 项目是什么

一个**自己维护的 Cloudflare 隧道 + 反向代理面板**：用 Docker 起 `cloudflared` + `Caddy` + 面板本体，在网页上管理「哪个域名/路径 → 打到哪个本机服务」。

- 为什么不用现成的：DockFlare / Cloudflared-web 都只满足一半（要么只有隧道没分流，要么分流要 Cloudflare API Token）。本项目的卖点是 **token 托管命名隧道 + 可视化多服务分流 + 规则级鉴权/限流/黑白名单**，并且能自己改。
- 技术栈：Node 22（零框架，原生 `http`）+ 原生 JS 前端（无构建步骤）+ Caddy 2.11.9 + cloudflared，全部 `network_mode: host`。
- 代码规模：`src/server.js` 2262 行（路由装配）+ `src/core/` 27 个模块 + `src/web/pages/` 7 个页面 + `src/web/assets/` 共享 CSS/JS。

**功能地图**（页面 ↔ 后端）：

| 页面 | 干什么 | 主要后端 |
|---|---|---|
| `/` 总览 | 健康、流量/错误趋势、访问路径 Top、最近日志、快速动作 | `/api/state` `/api/audit/trend` `/api/logs` |
| `/tunnels` 隧道出口 | 建/启停出口、二维码、按出口统计 | `/api/tunnels` `/api/cf/*` `/api/exit/stats` |
| `/rules` 代理规则 | 规则增删改、模板、模拟匹配、自检三件套 | `/api/routes` `/api/match` `/api/rules/test` |
| `/tools` 工具箱 | Docker 容器一键加规则、分享链接、curl 自测、缓存预热、一键新建出口 | `/api/docker/*` `/api/shares` `/api/probe` `/api/cf/tunnels/quick` |
| `/observe` 观测 | 访问日志（含 5xx）、可疑访问一键封禁、导出 CSV | `/api/accesslog` `/api/security/attempts` |
| `/monitor` 监控 | Prometheus 目标/告警、Grafana 嵌入、**一键体检** | `/api/monitor/status` `/api/selfcheck` `/api/alerts/*` |
| `/settings` 设置 | 口令/TOTP/角色、通知通道、配置即代码、备份、会话 | `/api/settings` `/api/config/*` `/api/backups/*` |

---

## 2. 拿到代码、把服务跑起来

### 2.1 拉代码

```bash
git clone git@github.com:jianghugs/cf-tunnel-panel.git
cd cf-tunnel-panel
```

- 仓库是 `jianghugs/cf-tunnel-panel`（**同一账号从 Adam-cell-tech 改名而来**，旧地址 301，Secrets/包/Issue 全部继承）。
- SSH 推送：本机已有可用密钥（`ssh -T git@github.com` 应显示 `Hi jianghugs!`）。git 身份已设为 `jianghugs / jianghugs@users.noreply.github.com`。
- 服务器上的现有工作副本在 `/mnt/sdb1/wechat_bot/cf-tunnel-panel`（与本机 Docker 共享数据目录 `./data`），**接手时优先用它**，因为 `data/` 里有 state、审计、历史采样。

### 2.2 起服务（三容器，全部 host 网络）

```bash
docker compose up -d caddy demo        # caddy:8080、演示服务:8091
bash tools/rolling-upgrade.sh --bootstrap --apply   # 面板第一个槽位（蓝:8090）
```

| 容器 | 作用 | 端口 |
|---|---|---|
| `cf-tunnel-panel-blue` | 面板槽位 A | 8090 |
| `cf-tunnel-panel-green` | 面板槽位 B | 8095 |
| `cf-tunnel-caddy` | 反向代理，规则的实际执行者 | 8080（+ admin 20190） |
| `cf-tunnel-demo` | 演示上游 | 8091 |

健康检查：`curl -s 127.0.0.1:8090/healthz` → `{"version","mode":"leader","code","imageCode","drift"}`。

### 2.3 必须知道的环境变量

| 变量 | 默认 | 作用 |
|---|---|---|
| `PORT` | 8090 | 面板监听端口（两槽位分别是 8090/8095） |
| `DATA_DIR` | `<repo>/data` | 状态/审计/历史/备份全在这里，**两槽位必须共享同一个** |
| `CADDY_ADMIN` | `http://127.0.0.1:2019` | 生产实际用 **20190**；`src/core/pusher.js` 不回退，配错就下发不出去 |
| `PANEL_SLOT_PEERS` | 空 | 另一槽位地址，例如 `127.0.0.1:8095`；不设则规则单上游，滚动升级会掉 1–3 秒 5xx |
| `PANEL_ALLOW_FRESH_PUSH` | 空 | `1` 才允许 state.json 不存在时首次下发（CI/全新机器用） |
| `PANEL_INSTANCE` / `PANEL_LEASE_TTL_MS` | 自动 / 15000 | 实例标识与租约 TTL |
| `PANEL_TLS_CERT` / `PANEL_TLS_KEY` | 空 | 给面板自己上 HTTPS 用 |
| `LOG_STDOUT` | 空 | `1` 时日志同时打到标准输出（容器里看 `docker logs`） |

---

## 3. 目录地图

```
src/
  server.js           # 2262 行：路由装配 + 启动；业务都在 core/
  core/
    paths.js          # 端口/数据目录/常量/版本；改路径先看这里
    state.js          # state.json 读写、默认值、校验（validateRoutes 等）、publicSettings 投影
    store.js          # 通用 JSON 落盘（原子写）
    caddy.js pusher.js guard.js   # 配置生成 / 下发（带 Origin）/ 规则遮蔽检测
    tunnel.js         # cloudflared 进程管理（token 归一化、致命错误停止重启）
    auth.js sessions.js totp.js perm.js ident.js   # 认证、会话（跨实例）、TOTP、角色、代码指纹
    audit.js history.js notify.js                  # 审计（按天）、历史采样、多通道通知
    monitor.js alerts.js selfcheck.js              # Prometheus 查询、告警静默/回调、**一键体检**
    configcode.js shares.js docker.js cfapi.js metrics.js probe.js backup.js ratelimit.js lease.js i18n.js
  web/
    pages/*.html      # 7 个页面（服务端注入变量后返回）
    assets/*.js|css   # 共享 app.js/app.css + 每页一个 js
test/
  api.test.mjs        # 服务端接口回归（约 327 项）
  dom.test.cjs        # jsdom 前端回归（176 项）
  e2e-caddy.mjs       # 真 Caddy 端到端（39 项，含双实例 standby）
  caddy.e2e.json      # e2e 专用配置（:8180 / admin :20290）—— 与生产的 8080 隔离
tools/
  rolling-upgrade.sh  # 蓝绿滚动升级（唯一正确的部署方式）
  release.sh          # 一键发版（升版本→CHANGELOG→提交→tag→push→构建→滚动）
  codehash.js         # 代码指纹（写 /app/.code-hash 与 /healthz 比对，识别 docker cp 漂移）
  clean-audit.cjs     # 审计清洗（默认演练，--apply 才动，备份到 data/backups/audit-cleanup/）
  sync-release-notes.py # 用 CHANGELOG 重写所有 GitHub Release 正文
  monitoring/         # Prometheus + Alertmanager + Grafana 的 compose 与配置
docs/                 # ROADMAP、PROMETHEUS-GRAFANA 等
data/                 # 运行时数据（git 忽略）
```

---

## 4. 运行时数据布局（`DATA_DIR`）

| 路径 | 内容 | 谁写 |
|---|---|---|
| `state.json` | 全部配置：settings/routes/tunnels/shares | 仅 leader |
| `sessions.json` | v2 `{version,sessions[],revoked[]}`，跨实例共享 | 任何实例 |
| `audit/audit-YYYY-MM-DD.jsonl` | 审计，按天分文件，保留 `PANEL_AUDIT_DAYS`(30) 天 | 各实例 |
| `history/samples.jsonl` | 出口采样（每分钟一条，按分钟去重） | 仅 leader |
| `history/notify.jsonl` | 通知记录 | 各实例 |
| `selfcheck/last.json` + `history.jsonl` | 体检结果（v0.29.11 新增，最多 200 条） | leader |
| `config/*.json` | 配置即代码快照（`last-applied.json` 是基线） | leader |
| `backups/` | 备份；`backups/audit-cleanup/` 是审计清洗的原始备份 | 手动/定时 |
| `caddy-logs/access.log` | Caddy 访问日志（JSON 行） | Caddy |
| `lease.json` | 租约（心跳时间戳，不看 pid） | 各实例 |

---

## 5. 不变量与禁区（踩过的坑，别再踩）

| # | 不变量 | 为什么 | 怎么自查 |
|---|---|---|---|
| 1 | **state.json / Caddy 下发 / cloudflared 只能有一个属主**。第二实例是只读备份，写请求返回 `409 {code:'STANDBY'}` | 两实例同时写会把配置写坏、两个 cloudflared 会抢同一条隧道 | `/healthz` 的 `mode` 只会有一个 `leader` |
| 2 | 跨实例共享的东西**一律以磁盘为事实源**（会话、state、历史采样），内存缓存只做节流 | 早期会话在内存里 → A 实例登录，B 实例不认 | 见 `sessions.js` 的 1.5s 节流读盘与墓碑 |
| 3 | **规则 `path: '/'` 必须排在最后**，否则同域名其他路径全被它吃掉（表现为 401 或 Cloudflare 530） | Caddy 是前缀匹配，先命中先赢 | 面板有 `guard.js` 遮蔽检测；体检的「规则遮蔽」项也会报 |
| 4 | 面板下发 Caddy 配置**必须带 `Origin` 头** | Caddy admin 端点校验 Origin，否则 403 | `pusher.js`；体检的「Caddy 管理接口」项会验 |
| 5 | **不回退 Caddy admin 端口**（只用 `CADDY_ADMIN`） | 曾因回退，让测试实例用空白配置覆盖生产 | 只有显式 `PANEL_ADMIN_FALLBACK=1` 才回退 |
| 6 | `state.json` 不存在时**拒绝首次下发** | 同上，防止把生产推成空配置 | `PANEL_ALLOW_FRESH_PUSH=1` 才放行 |
| 7 | 轮询刷新**只更新 live 区域 + 脏标记**，不整页重绘 | 5 秒一刷会把用户没保存的输入清掉 | 新增页面照抄这个模式 |
| 8 | 前端不许解构 `state`（用 `stateProxy`） | 会拿到 loadState 之前的默认对象 | 只在 server 端相关 |
| 9 | 负载均衡字段是 `selection_policy`（**不是 `selection`**），用 `round_robin` 不要 `first` | `selection` 会 400；`first` 会反复重试死上游（3–5 秒 502） | `caddy.js` |
| 10 | 认证有三条路径（Basic admin / Basic viewer / login），**改一条必须全改** | 曾只改了 login，Basic 还是明文比对 | `auth.js` + `test/api.test.mjs` 的认证段 |
| 11 | 测试流量必须带 `x-cfp-test: 1`，否则会污染审计 | 审计「变更趋势」显示过 2476 次假改动 | `server.js` 的 `res.on('finish')` 里有判断 |
| 12 | e2e 必须用**独立端口**（`:8180` / admin `:20290`） | 否则面板会把生产 `:8080` 配置推给测试 Caddy，全链路 fetch failed | `test/caddy.e2e.json` |

---

## 6. 改代码的三种循环（选最轻的）

| 场景 | 做法 | 生效方式 | 代价 |
|---|---|---|---|
| 改前端（HTML/CSS/JS） | 直接改 `src/web/**`，容器里已挂载时刷新即可 | 刷新浏览器 | 0（`MOUNT_SRC=1` 默认挂载） |
| 改后端小改（调试） | `docker cp <file> cf-tunnel-panel-green:/app/<path>` | `docker restart cf-tunnel-panel-green` | 会导致 `/healthz` 的 `drift: true`（**发版前必须消掉**） |
| 正常发版 | `docker compose build panel --build-arg GIT_SHA=$(git rev-parse --short HEAD)` → `tools/rolling-upgrade.sh --apply` | 滚动切换，窗口约 0.25s | 几十秒构建 |

**代码指纹**：`tools/codehash.js` 把 `src/` + `package.json` 算 SHA1 前 16 位；镜像构建时写进 `/app/.code-hash`，`/healthz` 会给出 `code`（运行中代码）、`imageCode`（镜像里）、`drift`（两者不一致）。**`drift: true` 是唯一能证明「你改的代码真的跑起来了」的信号**，发版后必须是 `false`。

---

## 7. 测试

```bash
# 1) 服务端接口（必须对着 leader 跑；脚本会先快照规则、结束时还原）
PANEL_URL=http://127.0.0.1:8095 PANEL_PASS='<管理员口令>' node test/api.test.mjs

# 2) 前端 DOM（需要 jsdom；本机已装在 /tmp/jsd）
PANEL_URL=http://127.0.0.1:8095 PANEL_PASS='<口令>' NODE_PATH=/tmp/jsd/node_modules node test/dom.test.cjs

# 3) 真 Caddy 端到端（会自动起一个 :8080 之外的测试 Caddy）
node test/e2e-caddy.mjs
```

要点：

- **快照还原铁律**：任何会改线上配置的测试，开跑前把 `data/state.json` 或规则快照到 `/tmp`，`finally` 里还原。曾经有清理脚本把线上 6 条规则清空。
- jsdom 测试里**不要用固定等待**判断异步渲染，用轮询（`for (...) { await sleep(500) }`）。已因此修过 3 处假失败：健康指示、出口流量表、可疑访问空列表。
- 空列表不是错误：审计被清洗后「可疑访问」是空的，断言要接受「说明态」。
- 前端断言可以读源码（`fs.readFileSync('src/web/assets/xxx.js')`）来验证绑定是否存在，比抓 DOM 稳。
- 单次跑不过先重跑一次，看是不是端口/时序问题；**连续两次同一项失败才算真 bug**。

---

## 8. 发版（一条命令）

```bash
# 先把这次要写进 Release 的说明写好（markdown 列表）
cat > /tmp/notes-02911.md <<'EOF'
- 定时体检：每 5 分钟自动跑一遍 12 项检查，出问题走通知通道
- 体检结果留痕：侧栏和监控页都能看到「上次体检 N 分钟前」
EOF

bash tools/release.sh 0.29.11 --notes-file /tmp/notes-02911.md --build
```

脚本会依次做：改 `package.json` → 把 notes 插到 `CHANGELOG.md` 顶部 → 提交（`release: vX.Y.Z`）→ 打注释 tag → push 分支与 tag → 构建镜像 → 打 `cf-tunnel-panel:X.Y.Z` → `tools/rolling-upgrade.sh --apply` → 断言 `/healthz`（会自动探 8090/8095 找当前 leader，校验 version / leader / drift=false，任一不满足硬退出）。

**坑（都踩过）**：

| 坑 | 说明 |
|---|---|
| `CHANGELOG 里已经有该版本段` | 脚本会拒绝。**别事先手写 CHANGELOG**，让脚本插；已经写了就删掉再跑 |
| 工作区脏 | 脚本要求干净；调试残留用 `--force` 跳过，但**别带进发版提交** |
| Release/镜像要等 1–2 分钟 | workflow 是异步的；立刻查会看到 `release: None` 与 ghcr 404 |
| ghcr 短 tag | `0.29.4` 之前没有不带 `v` 的短 tag（`0.29.3` 是 404）；`SHORT_TAG_FROM=(0,29,4)` 在 `sync-release-notes.py` 里控制 |
| 手动打 tag 时 | **一次 push 多个 tag 不触发任何 workflow**，必须逐个 `git push origin :refs/tags/vX && git push origin vX` |

`--dry` 看计划，`--no-push` 只本地，`--force` 放宽检查。

发版后自查：

```bash
curl -s https://panel.jianghugs.shop/healthz        # version / mode / drift
curl -sL "https://api.github.com/repos/jianghugs/cf-tunnel-panel/releases/tags/v0.29.11" | head -c 200
```

---

## 9. CI 与仓库

- `.github/workflows/ci.yml`：每 push 跑 API/DOM/e2e + lint（`node --check`）。
- `.github/workflows/release.yml`：tag 触发；**有门控**——只有「当前 tag 是最新版本」才构建镜像，历史 tag 只建 Release（避免把 `latest` 刷成老代码）。镜像用 `${{ github.repository }}`，不要硬编码 owner。
- `.github/workflows/sync-release-notes.yml`：CHANGELOG 改动后自动重写所有 Release 正文。
- Secrets：`GITHUB_TOKEN` 自带即可；推 ghcr 用 `GITHUB_TOKEN`（已配 `packages: write`）。
- 查 CI 用 `api.github.com/repos/jianghugs/cf-tunnel-panel/actions/runs?per_page=1`（本机没有 `gh`）。

---

## 10. 本机环境（重要约束）

- Ubuntu 20.04 aarch64 / 8GB / **glibc 2.31、g++ 9**：`better-sqlite3`（要 glibc 2.33 / `-std=c++20`）与 Univer（要 2.35）**在本机永久不可用**，别再尝试装。
- **没有图形栈**（无 X、无 Chrome 桌面版），截图/量测必须用容器：

  ```bash
  docker run --rm --network host -v /tmp:/scripts -v /tmp/shot:/out -v /tmp/pptr:/tmp/pptr \
    zenika/alpine-chrome:with-puppeteer node /scripts/shot390.js <url> <out> 390 844
  ```

  已有脚本：`/tmp/shot390.js`（移动端，报 `{vw,scrollW,wide[]}`）、`/tmp/shotov.js`（概览）、`/tmp/shotcheck.js`（点体检按钮）、`/tmp/authproxy.js <up> <port> <user> <pass>`（把 Basic 凭据注入，给 puppeteer 用；SSE 会打桩）。
  **注意**：Chrome CLI 的 `--window-size=390` 实际按 500px 布局，移动端必须用 puppeteer 的 `setViewport`，否则会误判「溢出」。
- **`pkill -f xxx` 会杀掉自己的 shell**（命令行里含同串）。用 `ss -ltnp | grep :8099` 取 pid 再 `kill`。
- 定时任务/看门狗用 cron（`crontab -l` 可看），dsh 自己的移动访问链路在 `~/.dsh-data/mobile-access/`。

---

## 11. 当前未完成的工作（接手第一件事）

工作区有 **8 个已改未提交**文件，属于 **v0.29.11：定时体检 + 结果留痕**：

| 文件 | 改动 |
|---|---|
| `src/core/selfcheck.js` | 新增 `persist()` / `lastResult()` / `history(n)`，写 `data/selfcheck/last.json` 与 `history.jsonl`（最多 200 条）；出口探测超时 3s→6s，超时只算「注意」不算「失败」（过 Cloudflare 本来就慢，误报太吵） |
| `src/server.js` | 抽出 `selfcheckContext()`；`_lastSelfcheck` 接上次结果；`selfcheckAlert()` / `selfcheckRecovered()`；`runSelfcheckQuiet()`（只在 leader 跑、状态翻转才通知）；启动后 45 秒首跑、之后每 5 分钟；新增 `GET /api/selfcheck/history?limit=`；`/api/state` 的 runtime 带 `selfcheck` 摘要 |
| `src/core/state.js` | `notify.events` 默认值加 `selfcheck: true` |
| `src/web/assets/app.js` | 侧栏 `paintHealth()` 追加「· 体检 N/M」，title 里写上次体检时间与失败项 |
| `src/web/assets/monitor.js` | 新增 `paintLastCheck()`：页面打开就显示「上次体检 X 分钟前，12 项全部通过」或失败横幅 |
| `tools/clean-audit.cjs` | 备份目录改到 `data/backups/audit-cleanup/`（原来放在 `data/audit/` 里，保留期清扫不认，会一直堆） |
| `test/api.test.mjs` | +4 条：留痕、`/api/selfcheck/history` 结构、项数一致、`/api/state` 带摘要 |
| `test/dom.test.cjs` | +1 条：监控页带「上次体检」逻辑；顺手把 3 处固定等待改成轮询（健康指示、出口流量表、可疑访问空列表） |

**已验证**：`test/api.test.mjs` **331/331 通过**、`test/dom.test.cjs` **176/176 通过**（2026-11-18 实跑，对着 8095 的 leader）。

**收尾 4 步**：

```bash
cd /mnt/sdb1/wechat_bot/cf-tunnel-panel

# ① 顺手复跑一遍（代码没再动的话可跳过）
PANEL_URL=http://127.0.0.1:8095 PANEL_PASS='<口令>' node test/api.test.mjs
PANEL_URL=http://127.0.0.1:8095 PANEL_PASS='<口令>' NODE_PATH=/tmp/jsd/node_modules node test/dom.test.cjs

# ② 补文档（README 英/中加 v0.29.11 小节、docs/ROADMAP.md 加一行）——CHANGELOG 交给 release.sh 插

# ③ 发版（脚本会 bump 到 0.29.11、提交、打 tag、构建、滚动升级）
bash tools/release.sh 0.29.11 --notes-file /tmp/notes-02911.md --build

# ④ 校验：/healthz 的 version=0.29.11、mode=leader、drift=false；Release 与 ghcr 四种 tag 都是 200

# ④ 更新 MEMORY / 交接记录
```

> 当前线上的实际情况：`green(:8095)` 是 leader，跑着 v0.29.10 + 我 docker cp 进去的未提交改动（所以 `drift: true`）；`blue(:8090)` 是停着的备份槽。发版后 `drift` 会回到 `false`。

---

## 12. 下一步可做的事（按我认为的价值排序）

1. **体检历史可视化**：`/api/selfcheck/history` 已有数据，可以在监控页画一条「过去 24 小时体检通过率」的细条。
2. **图表无障碍**：canvas 目前没有文本替代，给每个图加 `role="img"` + `aria-label`（用已有的一行摘要文本），屏幕阅读器能念出来。
3. **Grafana 反向代理**：现在嵌入要过 Cloudflare 隧道（首次 40s），若在面板里加 `/grafana/*` 同源反代，可省掉跨站与 CORS 问题。
4. **告警收敛**：Prometheus 目前同时抓两个槽位，停着的那色必然 DOWN；可以改成只抓稳定入口 `127.0.0.1:8080/metrics`（Caddy 转发到当前 leader）。
5. **备份加密**：`data/backups/` 里的导出是明文 JSON（含 bcrypt 哈希与隧道 token），加一个 `--encrypt` 用口令派生密钥（scrypt+AES-256-GCM）。
6. **规则变更审计回放**：审计里已有 before/after，可以做成「点一条记录看当时改了什么」。

---

## 13. 排障速查

| 症状 | 先查什么 | 常见原因 |
|---|---|---|
| 域名返回 **530** | `docker logs cf-tunnel-caddy --tail 50`；`curl -H 'Host: <域名>' 127.0.0.1:8080<路径>` | cloudflared 掉线 / ingress 没写 / 规则遮蔽（`path:/` 排前面） |
| 面板某个路径 **401** | 同上，看是不是被面板自己的 Basic 认证拦了 | 规则把请求打到了面板（8090/8095）而不是目标服务 |
| **1033** | Cloudflare 后台看隧道 ingress | 只建了 DNS CNAME 没写隧道 ingress（`/api/cf/tunnels/quick` 会一起写） |
| 写操作 **409 STANDBY** | `/healthz` 的 `mode` | 连到了备份实例，属正常；等租约或直接连 leader 端口 |
| `/healthz` 的 **drift: true** | `docker exec … cat /app/.code-hash` 对比 `node tools/codehash.js` | 用过 `docker cp`；重新 build + 滚动升级即可 |
| Caddy 下发 **403** | `pusher.js` 的 `Origin` 头 | Caddy admin 校验 Origin |
| 审计「变更次数」虚高 | `node tools/clean-audit.cjs --dry` | 历史上测试流量被计入（v0.29.0 前的记录）；清洗后只统计真实写操作 |
| Grafana 嵌入是灰板 | 浏览器控制台 CSP 报错 | `frame-src` 没放行对应源（正式地址与 `lanUrl` 都要放） |
| 嵌入慢到 40s | 是否走 `https://grafana.jianghugs.shop` | 配 `settings.grafana.lanUrl`（`http://192.168.1.55:3000`）后，在本机 http 打开面板时会直连 |
| 隧道一直重连 | `docker logs … | grep -i 'token\|error'` | token 粘错（应只有 `eyJ…`）、或凭证失效；致命错误不会自动重启 |
| 体检报「出口：xxx 超时」 | 手动 `curl -m 10 <公网地址>` | 过 Cloudflare 本来就慢（1.5–2.5s，偶尔 6s+）；连续失败才查 cloudflared |

---

## 14. 新 agent 的第一组命令

```bash
cd /mnt/sdb1/wechat_bot/cf-tunnel-panel
git status && git log --oneline -3      # 确认 §11 的未提交改动还在
for p in 8090 8095; do curl -s --max-time 3 127.0.0.1:$p/healthz; echo; done   # 谁是 leader
git ls-remote --heads origin            # 远端是否已同步

# 确认工具链
node -v && docker ps --format '{{.Names}}\t{{.Status}}'
```

口令等敏感信息不在仓库里，向项目所有者索取（管理员口令、TOTP 恢复码、Cloudflare 隧道 token 都在 `data/state.json` 与 `~/.dsh-data/mobile-access/` 下，后者与面板无关，属于 dsh 自身）。

祝顺利。有问题先看 `docs/ROADMAP.md` 与 `CHANGELOG.md`——每个版本的「为什么」都写在里面。
