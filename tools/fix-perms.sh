#!/usr/bin/env bash
# 把 data/ 与 caddy 日志的属主改成当前宿主机用户，方便在宿主机上直接看 state.json / access.log。
# 面板容器以 root 运行，只会写数据、不会改属主，所以跑一次就行（每次 docker cp / restart 后再跑一次也无害）。
set -euo pipefail
UID_GID="${SUDO_UID:-$(id -u)}:${SUDO_GID:-$(id -g)}"
DIR="$(cd "$(dirname "$0")/.." && pwd)"

echo "▶ 把 $DIR/data 的属主改成 $UID_GID"
docker exec cf-tunnel-panel sh -c "chown -R $UID_GID /data && chmod 600 /data/state.json 2>/dev/null || true"

if docker ps --format '{{.Names}}' | grep -qx cf-tunnel-caddy; then
  echo "▶ 让 caddy 的 access.log 宿主机可读"
  docker exec cf-tunnel-caddy sh -c "chmod 644 /logs/access.log 2>/dev/null || true; chmod 755 /logs 2>/dev/null || true"
fi

echo "✔ 完成。现在宿主机上可以直接：cat $DIR/data/state.json / tail -f $DIR/data/caddy-logs/access.log"
