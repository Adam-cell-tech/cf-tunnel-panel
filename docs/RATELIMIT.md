# 限流（rate limit）：为什么默认没有，怎么开

## 为什么默认下不了

限流在 Caddy 里**不是核心模块**。官方镜像 `caddy:2-alpine` 只编了标准模块（`reverse_proxy`／`rewrite`／
`basic_auth`／`static_response` 这些），里面**没有** `rate_limit`。

如果面板不管三七二十一就把 `rate_limit` 写进配置，`POST /load` 会整体失败（`unrecognized handler module: rate_limit`），
**连正常的规则一起挂掉** —— 所以面板的做法是：勾了开关、但没检测到自定义镜像时，只在日志里提示一行，不写进配置。

## 怎么开（两步）

### 1. 编一个带限流模块的 Caddy 镜像

`xcaddy` 会把模块编进二进制，第一次构建约 3~8 分钟（要拉 Go 依赖）：

```dockerfile
# Dockerfile.caddy-ratelimit
FROM caddy:2-builder AS builder
RUN xcaddy build --with github.com/mholt/caddy-ratelimit

FROM caddy:2-alpine
COPY --from=builder /usr/bin/caddy /usr/bin/caddy
```

```bash
docker build -f Dockerfile.caddy-ratelimit -t caddy-ratelimit:local .
```

验证模块真的进去了：

```bash
docker run --rm caddy-ratelimit:local caddy list-modules | grep rate_limit
# http.handlers.rate_limit
```

### 2. 换镜像 + 打开开关

`docker-compose.yml` 里把 caddy 服务的 `image:` 换成 `caddy-ratelimit:local`（或者加 `build:` 指向上面那个 Dockerfile），
并在 **panel** 服务里加一行：

```yaml
CADDY_RATELIMIT: "1"
```

```bash
docker compose up -d
```

然后面板「设置 → 安全」里勾上限流、填每秒请求数和突发，保存。面板会下发：

```json
{ "handler": "rate_limit",
  "zones": [ { "key": "{remote_host}", "events": 20, "window": "1s" } ] }
```

## 它会怎么影响你

- 按**来源 IP**（`{remote_host}`）计数，每个 IP 每秒最多 `events` 个请求。
- 超了返回 **429 Too Many Requests**，客户端稍后重试即可。
- 经 Cloudflare 进来时，看到的来源 IP 是 Cloudflare 的地址段 —— 想按"真实用户 IP"限流，需要在 Caddy 前面信任
  `CF-Connecting-IP`（本项目没做，因为那需要额外的 `real_ip` 配置；对家用场景按"整体入口"限流通常就够了）。
- 面板自己的 `/healthz`、`/metrics` 不走 Caddy，不受影响。

## 不想编镜像的替代方案

| 方案 | 说明 |
|---|---|
| Cloudflare 后台 **Rate limiting** | 免费套餐有一定额度，按路径/国家限，规则在 Cloudflare 侧生效，改面板不用动 |
| Cloudflare **WAF 自定义规则** | 比如"同 IP 10 秒内 > 50 次就 challenge" |
| 只做黑名单 | 面板的全局 IP 黑名单已经够挡大多数扫描器（命中直接 403，零成本） |
