#!/usr/bin/env bash
# 滚动升级：两个实例同时活着，先把新代码起在第二个槽位，确认就绪后让老实例退场，
# Caddy 靠「双上游 + 主动健康检查」把流量切过去，整个过程不中断。
#
# 用法：
#   tools/rolling-upgrade.sh                 # 干跑：只做 preflight 并打印计划
#   tools/rolling-upgrade.sh --apply         # 真做
#   tools/rolling-upgrade.sh --apply --prune # 真做，成功后删掉老容器
#
# 前提（很重要）：
#   1) 正在跑的面板必须带 PANEL_SLOT_PEERS=<接班槽位>，否则面板规则是单上游，
#      Caddy 不知道还有个新实例 —— 这时脚本会退化成「先停后起」，有 1~3 秒 5xx。
#   2) 数据目录必须共享（同一个 ./data），两个实例靠租约文件决定谁是 leader。
set -euo pipefail

NAME=${NAME:-cf-tunnel-panel}
NEXT_NAME=${NEXT_NAME:-cf-tunnel-panel-next}
DATA=${DATA:-$(cd "$(dirname "$0")/.." && pwd)/data}
SRC=${SRC:-$(cd "$(dirname "$0")/.." && pwd)}
IMAGE=${IMAGE:-cf-tunnel-panel:local}
CUR=${CUR:-8090}
NEXT=${NEXT:-8095}
PANEL_HOST=${PANEL_HOST:-}
CADDY_ADMIN=${CADDY_ADMIN:-http://127.0.0.1:20190}
CADDY_LISTEN=${CADDY_LISTEN:-:8080}
UIDGID=${UIDGID:-1000:1000}
READY_TIMEOUT=${READY_TIMEOUT:-60}

APPLY=0; PRUNE=0
for a in "$@"; do
  case "$a" in
    --apply) APPLY=1 ;;
    --prune) PRUNE=1 ;;
    -h|--help) sed -n '2,22p' "$0"; exit 0 ;;
    *) echo "未知参数: $a" >&2; exit 2 ;;
  esac
done

say() { printf '%s\n' "$*"; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
code() { curl -s -o /dev/null -w '%{http_code}' --max-time 3 "$@" || true; }
mode_of() { curl -s --max-time 3 "http://127.0.0.1:$1/healthz" | sed -n 's/.*"mode":"\([a-z]*\)".*/\1/p'; }
wait_mode() { # wait_mode <port> <want> <timeout>
  local port=$1 want=$2 t=$3 i=0
  while [ $i -lt "$t" ]; do
    [ "$(mode_of "$port")" = "$want" ] && return 0
    sleep 1; i=$((i+1))
  done
  return 1
}

# ---------------------------------------------------------------- preflight
say "== preflight =="
docker inspect "$NAME" >/dev/null 2>&1 || die "容器 $NAME 不存在"
[ -f "$SRC/src/server.js" ] || die "$SRC 里没有 src/server.js（用 SRC=… 指定源码目录）"
[ -d "$DATA" ] || die "数据目录 $DATA 不存在（用 DATA=… 指定）"

CUR_HEALTH=$(code "http://127.0.0.1:$CUR/healthz")
[ "$CUR_HEALTH" = "200" ] || die "当前实例 http://127.0.0.1:$CUR/healthz 返回 $CUR_HEALTH"
say "当前实例 :$CUR 健康"

if ss -ltn 2>/dev/null | grep -q ":$NEXT "; then die "接班槽位 :$NEXT 已被占用"; fi
say "接班槽位 :$NEXT 空闲"

SLOTS=$(docker inspect "$NAME" --format '{{range .Config.Env}}{{println .}}{{end}}' | sed -n 's/^PANEL_SLOT_PEERS=//p')
ZERO_DOWNTIME=0
if echo ",$SLOTS," | grep -q ",$NEXT,"; then
  ZERO_DOWNTIME=1
  say "老实例已预留槽位（PANEL_SLOT_PEERS=$SLOTS）→ 可以零中断切换"
else
  say "警告：老实例没有预留 $NEXT（当前 PANEL_SLOT_PEERS=${SLOTS:-<未设置>}）"
  say "      切换会退化成「先停后起」，期间 Caddy 无上游，约 1~3 秒 5xx"
  say "      想零中断：把 compose 里的 PANEL_SLOT_PEERS 设成 $NEXT 后重建一次实例"
fi

if [ "$APPLY" != "1" ]; then
  say ""
  say "== 计划（干跑，没动任何东西）=="
  say "1) 用 $SRC 的源码在 :$NEXT 起 $NEXT_NAME（共享 $DATA，先当 standby）"
  say "2) 等它 /healthz 200 且 mode=standby"
  say "3) 停掉 $NAME（:${CUR}），租约释放 → 新实例 5 秒内变 leader"
  say "4) 把 $NEXT_NAME 改名成 $NAME$( [ "$PRUNE" = "1" ] && echo "，并删掉老容器" )"
  say "5) 验证 http://127.0.0.1:8080/healthz${PANEL_HOST:+（Host: $PANEL_HOST）}"
  say ""
  say "确认无误后加 --apply 执行"
  exit 0
fi

# ---------------------------------------------------------------- 起新实例
say ""
say "== 1/5 起新实例 :$NEXT =="
docker rm -f "$NEXT_NAME" >/dev/null 2>&1 || true
docker run -d --name "$NEXT_NAME" \
  --network host --user "$UIDGID" --restart unless-stopped \
  -e PORT="$NEXT" -e LOG_STDOUT=1 -e TZ=Asia/Shanghai \
  -e CADDY_ADMIN="$CADDY_ADMIN" -e CADDY_LISTEN="$CADDY_LISTEN" \
  -e PANEL_INSTANCE="slot-$NEXT-$(date +%s)" \
  -e PANEL_SLOT_PEERS="$CUR" \
  -v "$DATA:/data" -v /var/run/docker.sock:/var/run/docker.sock:ro \
  -v "$SRC/src:/app/src:ro" -v "$SRC/tools:/app/tools:ro" \
  -v "$SRC/package.json:/app/package.json:ro" \
  "$IMAGE" >/dev/null
say "已启动 $NEXT_NAME"

say "== 2/5 等它就绪（standby）=="
if ! wait_mode "$NEXT" standby "$READY_TIMEOUT"; then
  docker logs --tail 30 "$NEXT_NAME" 2>&1 || true
  die "新实例没有在 ${READY_TIMEOUT}s 内进入 standby（先看上面的日志）"
fi
say "新实例已就绪，模式 standby（老实例仍是 leader，此时流量没变）"

# ---------------------------------------------------------------- 切换
say "== 3/5 让老实例退场 =="
docker stop -t 10 "$NAME" >/dev/null
say "老实例已停（租约立即释放）"

if ! wait_mode "$NEXT" leader 40; then
  say "新实例没能接管，回滚：重启老实例"
  docker start "$NAME" >/dev/null || true
  die "接管失败，已尝试回滚；新实例保持运行以便排查（docker logs $NEXT_NAME）"
fi
say "新实例已接管（mode=leader）"

# ---------------------------------------------------------------- 换名
say "== 4/5 换名 =="
STAMP=$(date +%Y%m%d-%H%M%S)
docker rename "$NAME" "$NAME-old-$STAMP"
docker rename "$NEXT_NAME" "$NAME"
say "老容器保留为 $NAME-old-$STAMP（回滚就 docker start 它）"

# ---------------------------------------------------------------- 验证
say "== 5/5 验证 =="
OK=1
NEW_HEALTH=$(code "http://127.0.0.1:$NEXT/healthz")
NEW_MODE=$(mode_of "$NEXT")
say "  新槽位 :$NEXT/healthz → $NEW_HEALTH，mode=$NEW_MODE"
[ "$NEW_HEALTH" = "200" ] && [ "$NEW_MODE" = "leader" ] || { say "警告：新槽位没接管成功"; OK=0; }
# 经 Caddy 的验证只有知道面板域名时才有意义（没 Host 头会命中兜底 404，那是正常的）
if [ -n "$PANEL_HOST" ]; then
  for u in /healthz /assets/app.css; do
    c=$(code -H "Host: $PANEL_HOST" "http://127.0.0.1:8080$u")
    say "  :8080$u（Host: $PANEL_HOST）→ $c"
    [ "$c" = "200" ] || OK=0
  done
else
  say "  （没给 PANEL_HOST，跳过经 Caddy 的验证；要验证就加 PANEL_HOST=你的面板域名）"
fi
if [ "$PRUNE" = "1" ]; then
  docker rm "$NAME-old-$STAMP" >/dev/null && say "已删除老容器 $NAME-old-$STAMP"
fi
say ""
say "完成。新实例 = $NAME（:$NEXT），老槽位 :$CUR $( [ "$(mode_of "$CUR")" = "standby" ] && echo '作为热备待命' || echo '已停止' )"
say "下次升级反着来：NEXT=$CUR tools/rolling-upgrade.sh --apply"
[ "$OK" = "1" ] || die "验证有失败项，请检查上面输出"
