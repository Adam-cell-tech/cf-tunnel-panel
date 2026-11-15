#!/usr/bin/env bash
# cf-tunnel-panel 自带测速脚本
#   ./tools/bench.sh                          # 测当前配置的隧道 + 本地 Caddy
#   ./tools/bench.sh https://app.example.com  # 测指定公网域名
#   ./tools/bench.sh https://app.example.com 5 # 额外指定测试文件大小（MB，默认 5）
#
# 输出：边缘机房(cf-ray)、TTFB、单流吞吐，以及"本地直连 vs 经 Caddy"的对照。
set -u
PANEL="${PANEL:-http://127.0.0.1:8090}"
CADDY="${CADDY:-http://127.0.0.1:8080}"
URL="${1:-}"
SIZE="${2:-5}"

hr() { printf '%.0s─' {1..58}; echo; }

if [ -z "$URL" ]; then
  URL=$(curl -s "$PANEL/api/state" | python3 -c 'import json,sys;print(json.load(sys.stdin)["runtime"]["publicUrl"] or "")' 2>/dev/null)
  [ -z "$URL" ] && { echo "面板里没有可用的公网地址，请先启动一个隧道出口，或直接把域名当参数传进来"; exit 1; }
fi
HOST=${URL#https://}; HOST=${HOST%%/*}

hr; echo "目标：$URL"; hr

echo "① 边缘机房"
curl -s -o /dev/null -D - "$URL/" 2>/dev/null | grep -i '^cf-ray:' | sed 's/^/   /' || echo "   （没拿到 cf-ray，可能不是 Cloudflare 代理）"

echo
echo "② 延迟（各 10 次，单位 ms）"
python3 - "$URL" <<'PY'
import subprocess,sys,statistics
u=sys.argv[1]
def bench(url,label,n=10):
    ts=[];tt=[]
    for _ in range(n):
        o=subprocess.run(["curl","-s","-o","/dev/null","--max-time","15","-w","%{http_code} %{time_starttransfer} %{time_total}",url],
                         capture_output=True,text=True).stdout.split()
        if o and o[0] in ("200","401","302","404"):
            tt.append(float(o[1])*1000); ts.append(float(o[2])*1000)
    if not ts: print(f"   {label:28s} 失败"); return
    print(f"   {label:28s} TTFB 中位 {statistics.median(tt):6.0f}  总中位 {statistics.median(ts):6.0f}")
bench(u,"经隧道（公网）")
bench("http://127.0.0.1:8080/","本地经 Caddy")
PY

echo
echo "③ 吞吐（下载 5MB 大文件）"
BL=/site/blob5m.bin
if [ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$CADDY$BL")" = "200" ]; then
  for base in "$CADDY" "$URL"; do
    [ "$base" = "$CADDY" ] && label="本地经 Caddy" || label="经隧道（公网）"
    speed=$(curl -s -o /dev/null --max-time 180 -w '%{time_total} %{speed_download}' "$base$BL" | awk '{printf "%.2f MB/s（%.1fs）", $2/1048576, $1}')
    printf "   %-28s %s\n" "$label" "$speed"
  done
else
  echo "   跳过：$CADDY$BL 不存在。起测试栈即可："
  echo "     docker compose -f test/docker-compose.test.yml up -d && head -c 5242880 /dev/urandom > test/site/blob5m.bin"
fi
hr
