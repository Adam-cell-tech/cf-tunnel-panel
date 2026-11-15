#!/usr/bin/env bash
# 配置即代码：把面板状态定期提交到 git 仓库（Reddit 上说的 "config as code"）
#
# 用法：
#   1. 建一个私有仓库，把路径填到 REPO 变量（或用环境变量传入）
#   2. 加到宿主机 crontab：  0 * * * * /path/to/cf-tunnel-panel/tools/git-snapshot.sh
#
# 注意：state.json 里有 tunnel token 与面板口令哈希，**仓库必须私有**。
#       只想存规则的话，用面板「导出配置」（脱敏版）再提交更安全。
set -euo pipefail

REPO="${REPO:-/mnt/sdb1/wechat_bot/cf-tunnel-panel-config}"   # 目标 git 仓库
SRC="${SRC:-/mnt/sdb1/wechat_bot/cf-tunnel-panel/data/state.json}"
DEST="$REPO/state.json"

mkdir -p "$REPO"
[ -d "$REPO/.git" ] || git -C "$REPO" init -q

if [ ! -f "$SRC" ]; then echo "找不到 $SRC（容器可能没跑过）"; exit 1; fi
cp "$SRC" "$DEST"

cd "$REPO"
git add -A
if git diff --cached --quiet; then
  echo "配置没变化，跳过提交"
  exit 0
fi
git -c user.name="cf-tunnel-panel" -c user.email="panel@localhost" \
    commit -q -m "config: $(date -Iseconds)（$(python3 -c "import json;d=json.load(open('state.json'));print(f\"{len(d.get('tunnels',[]))} 出口 / {len(d.get('routes',[]))} 规则\")")）"
echo "已提交：$(git -C "$REPO" log -1 --oneline)"
