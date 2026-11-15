# 多阶段：把官方 cloudflared 二进制搬进来，面板容器内直接 spawn
FROM cloudflare/cloudflared:latest AS cf

FROM node:22-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl tzdata \
 && rm -rf /var/lib/apt/lists/*

# cloudflared 走 Cloudflare 的网络，容器内需要能访问 7844/443 出站
COPY --from=cf /usr/local/bin/cloudflared /usr/local/bin/cloudflared
RUN cloudflared --version

WORKDIR /app
COPY package.json ./
RUN npm config set registry https://registry.npmmirror.com \
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
