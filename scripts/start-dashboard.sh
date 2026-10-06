#!/bin/sh
# 启动 大肥鱼的QQ机器人服务（幂等：已在监听则直接返回）。
set -e
ROOT=$(cd "$(dirname "$0")/.." && pwd)
PORT=${QQBOT_PORT:-9999}
BASE=${QQBOT_BASE:-/qqbot}
HOST=${QQBOT_HOST:-0.0.0.0}

if node -e "fetch('http://127.0.0.1:$PORT/healthz').then(()=>process.exit(0),()=>process.exit(1))" 2>/dev/null; then
  echo "控制台已在运行：http://$HOST:$PORT$BASE"
  exit 0
fi

mkdir -p "$ROOT/runtime"
cd "$ROOT"
setsid nohup node dashboard/server.js --host="$HOST" --port="$PORT" --base="$BASE" >> runtime/dashboard.out 2>&1 < /dev/null &
sleep 1
echo "已启动：http://$HOST:$PORT$BASE"
echo "访问口令：$(cat runtime/dashboard-token.txt 2>/dev/null || echo '(见 runtime/dashboard-token.txt)')"
