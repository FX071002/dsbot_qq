#!/usr/bin/env bash
# 大肥鱼的QQ机器人服务 —— 在新环境里安装/升级本仓库。
#
# 幂等：可以反复运行。默认把仓库安装在 $QQBOT_HOME，并注册进 dsh 的 web profile。
#
#   ./install.sh                      # 用默认值安装
#   QQBOT_HOME=/data/dsh/home/dfy-qqbot PROFILE=web ./install.sh
#   ./install.sh --no-plugin          # 只铺文件与控制台，不动 dsh 插件
#   ./install.sh --no-dashboard       # 不启动控制台
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
QQBOT_HOME="${QQBOT_HOME:-/data/dsh/home/dfy-qqbot}"
PROFILE="${PROFILE:-web}"
DSH_HOME="${DSH_HOME:-/data/dsh}"
PORT="${QQBOT_PORT:-9999}"
BASE="${QQBOT_BASE:-/qqbot}"
INSTALL_PLUGIN=1
START_DASHBOARD=1

for arg in "$@"; do
  case "$arg" in
    --no-plugin) INSTALL_PLUGIN=0 ;;
    --no-dashboard) START_DASHBOARD=0 ;;
    *) echo "未知参数：$arg" >&2; exit 2 ;;
  esac
done

say() { printf '\033[1;36m[install]\033[0m %s\n' "$1"; }
warn() { printf '\033[1;33m[warn]\033[0m %s\n' "$1"; }

command -v node >/dev/null || { echo "需要 node（>=22）" >&2; exit 1; }

say "安装目录：$QQBOT_HOME"
mkdir -p "$QQBOT_HOME"/{runtime,plugins,runtime/media}

# ---- 1. 代码 ---------------------------------------------------------------
for dir in qqbot-core dashboard shared scripts standalone; do
  rm -rf "${QQBOT_HOME:?}/$dir"
  cp -a "$REPO_DIR/$dir" "$QQBOT_HOME/$dir"
done
say "已铺开 qqbot-core / dashboard / shared / scripts / standalone"

# ---- 2. 凭据 ---------------------------------------------------------------
PATCH="$QQBOT_HOME/qqbot-core/cordis.patch.yml"
if [ -n "${QQ_BOT_APP_ID:-}" ] && [ -n "${QQ_BOT_APP_SECRET:-}" ]; then
  node - "$PATCH" "$QQ_BOT_APP_ID" "$QQ_BOT_APP_SECRET" <<'NODE'
const fs = require('node:fs')
const [file, appId, secret] = process.argv.slice(2)
const text = fs.readFileSync(file, 'utf8')
  .replace(/appId: ''/, `appId: '${appId}'`)
  .replace(/clientSecret: ''/, `clientSecret: '${secret}'`)
fs.writeFileSync(file, text, { mode: 0o600 })
NODE
  chmod 600 "$PATCH"
  say "已写入 QQ 凭据（AppID ${QQ_BOT_APP_ID}）"
else
  warn "未提供 QQ_BOT_APP_ID / QQ_BOT_APP_SECRET，请手动填 $PATCH（之后重跑本脚本或重启 Harness 生效）"
fi

# ---- 3. 注册 dsh 插件 ------------------------------------------------------
if [ "$INSTALL_PLUGIN" = 1 ]; then
  if command -v dsh >/dev/null; then
    if dsh plugin --profile "$PROFILE" add "$QQBOT_HOME/qqbot-core" >/dev/null 2>&1; then
      say "已注册进 dsh profile：$PROFILE"
    else
      warn "dsh plugin add 失败（可能已安装）。可手动执行：dsh plugin --profile $PROFILE add $QQBOT_HOME/qqbot-core"
    fi
    say "如果 Harness 正在运行，请在其界面里重载插件，或重启 Harness 进程"
  else
    warn "找不到 dsh 命令，跳过插件注册"
  fi
fi

# ---- 4. 控制台 -------------------------------------------------------------
if [ "$START_DASHBOARD" = 1 ]; then
  if node -e "fetch('http://127.0.0.1:$PORT/healthz').then(()=>process.exit(0),()=>process.exit(1))" 2>/dev/null; then
    say "控制台已在运行：http://127.0.0.1:$PORT$BASE"
  else
    ( cd "$QQBOT_HOME" && setsid nohup node dashboard/server.js --host=0.0.0.0 --port="$PORT" --base="$BASE" \
        >> runtime/dashboard.out 2>&1 < /dev/null & )
    sleep 2
    if node -e "fetch('http://127.0.0.1:$PORT/healthz').then(()=>process.exit(0),()=>process.exit(1))" 2>/dev/null; then
      say "控制台已启动：http://127.0.0.1:$PORT$BASE"
    else
      warn "控制台没起来，看 $QQBOT_HOME/runtime/dashboard.out"
    fi
  fi
  TOKEN_FILE="$QQBOT_HOME/runtime/dashboard-token.txt"
  [ -f "$TOKEN_FILE" ] && say "访问口令：$(cat "$TOKEN_FILE")（文件：$TOKEN_FILE）"
fi

if [ ! -f "$QQBOT_HOME/standalone/config.json" ] && [ -f "$QQBOT_HOME/standalone/config.json.example" ]; then
  cp "$QQBOT_HOME/standalone/config.json.example" "$QQBOT_HOME/standalone/config.json"
  chmod 600 "$QQBOT_HOME/standalone/config.json"
  warn "独立模式配置模板已生成：$QQBOT_HOME/standalone/config.json（想不装 Harness 直接跑时填它）"
fi

cat <<EOF

两种运行模式（同一份 runtime 配置、同一个控制台）：
  A. Harness 模式（默认，能力完整）：上面的 dsh plugin 注册已经装好，Harness 启动即加载
  B. 独立模式（不需要 Harness）：QQ_BOT_APP_ID=... QQ_BOT_APP_SECRET=... ./standalone/start.sh

下一步：
  1. 在 dsh 的 web 入口后面加 $BASE/ 打开控制台（例如 https://<你的地址>:10001$BASE/）
  2. 控制台「机器人」页确认收发范围与白名单；「人格」页设定人设
  3. 想接第三方模型：「模型 → 接入其他模型服务商」填 Key，拉取模型后选中即可
  4. 想让机器人被拉进群/加好友时自动打招呼：控制台「机器人」页
EOF
