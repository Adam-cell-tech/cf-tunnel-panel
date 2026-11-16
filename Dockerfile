# 多阶段：把官方 cloudflared 二进制搬进来，面板容器内直接 spawn
#
# 两个基础镜像都锁版本（latest 会让构建结果随时间漂移）。
# 国内拉不动/镜像站坏掉时可以覆盖：
#   docker build --build-arg NODE_IMAGE=node:22-bookworm-slim \
#                --build-arg CF_IMAGE=cloudflare/cloudflared:latest \
#                --build-arg NPM_REGISTRY=https://registry.npmjs.org .
ARG GIT_SHA=dev
ARG CF_IMAGE=cloudflare/cloudflared:2026.10.7
FROM ${CF_IMAGE} AS cf

ARG NODE_IMAGE=node:22.23.5-bookworm-slim
FROM ${NODE_IMAGE}

ARG NPM_REGISTRY=https://registry.npmmirror.com

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl tzdata \
 && rm -rf /var/lib/apt/lists/*

# cloudflared 走 Cloudflare 的网络，容器内需要能访问 7844/443 出站
COPY --from=cf /usr/local/bin/cloudflared /usr/local/bin/cloudflared
RUN cloudflared --version

WORKDIR /app
ENV GIT_SHA=${GIT_SHA}
COPY package.json ./
RUN npm config set registry ${NPM_REGISTRY} \
 && npm install --omit=dev --no-audit --no-fund

COPY src ./src
COPY tools ./tools
# 把「镜像里这份代码」的指纹写死进镜像；运行时再算一次，不一致就在 /healthz 里报 drift
RUN node tools/codehash.js > .code-hash

ENV TZ=Asia/Shanghai \
    PORT=8090 \
    DATA_DIR=/data \
    CADDY_ADMIN=http://127.0.0.1:2019 \
    CADDY_LISTEN=:8080 \
    CLOUDFLARED_BIN=/usr/local/bin/cloudflared

VOLUME ["/data"]
EXPOSE 8090
# 端口跟着 $PORT 走：滚动升级时面板会在 8090/8091 两个槽位之间来回搬
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD curl -fsS "http://127.0.0.1:${PORT:-8090}/healthz" || exit 1
CMD ["node", "src/server.js"]
