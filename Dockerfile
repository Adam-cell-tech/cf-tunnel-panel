# 多阶段：把官方 cloudflared 二进制搬进来，面板容器内直接 spawn
#
# 两个基础镜像都锁版本（latest 会让构建结果随时间漂移）。
# 国内拉不动/镜像站坏掉时可以覆盖：
#   docker build --build-arg NODE_IMAGE=node:22-bookworm-slim \
#                --build-arg CF_IMAGE=cloudflare/cloudflared:latest \
#                --build-arg NPM_REGISTRY=https://registry.npmjs.org .
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
COPY package.json ./
RUN npm config set registry ${NPM_REGISTRY} \
 && npm install --omit=dev --no-audit --no-fund

COPY src ./src

ENV TZ=Asia/Shanghai \
    PORT=8090 \
    DATA_DIR=/data \
    CADDY_ADMIN=http://127.0.0.1:2019 \
    CADDY_LISTEN=:8080 \
    CLOUDFLARED_BIN=/usr/local/bin/cloudflared

VOLUME ["/data"]
EXPOSE 8090
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD curl -fsS http://127.0.0.1:8090/healthz || exit 1
CMD ["node", "src/server.js"]
