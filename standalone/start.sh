#!/bin/sh
# 启动独立模式（不依赖 DeepSeek Harness）。
#   QQBOT_HOME=/data/dsh/home/dfy-qqbot \
#   QQ_BOT_APP_ID=... QQ_BOT_APP_SECRET=... ./standalone/start.sh
# 已经在跑则直接返回。
set -e
ROOT=$(cd "$(dirname "$0")/.." && pwd)
HOME_DIR=${QQBOT_HOME:-$ROOT}
PORT=${QQBOT_PORT:-9999}

if node -e "
const fs=require('fs');
for (const pid of fs.readdirSync('/proc').filter(n=>/^[0-9]+\$/.test(n))) {
  try { const argv=fs.readFileSync('/proc/'+pid+'/cmdline','utf8').split('\0').filter(Boolean);
    if(!/(^|\/)node(js)?\$/.test(argv[0]||'')) continue;
    if(argv.slice(1).some(a=>a.endsWith('standalone/server.js'))) process.exit(0)
  } catch {}
}
process.exit(1)
" 2>/dev/null; then
  echo "独立模式已在运行"
  exit 0
fi

mkdir -p "$HOME_DIR/runtime"
cd "$ROOT"
setsid nohup node standalone/server.js --home="$HOME_DIR" --port="$PORT" >> "$HOME_DIR/runtime/standalone.out" 2>&1 < /dev/null &
sleep 2
echo "独立模式已启动；日志：$HOME_DIR/runtime/standalone.out"
echo "控制台：http://<本机地址>:$PORT/（默认账号密码均为 harness，首次登录后必须修改）"
