#!/bin/sh
# 停止 大肥鱼的QQ机器人服务（只匹配 node 进程本身，避免误伤含同名字符串的 shell）。
PORT=${QQBOT_PORT:-9999}
PIDS=$(node -e '
const fs = require("node:fs")
const hits = []
for (const pid of fs.readdirSync("/proc").filter((n) => /^[0-9]+$/.test(n))) {
  try {
    const argv = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean)
    // argv[0] must BE node and the script must be an argument: a shell that
    // merely mentions the path is not the server.
    if (!/(^|\/)node(js)?$/.test(argv[0] ?? "")) continue
    if (!argv.slice(1).some((arg) => arg.endsWith("dashboard/server.js"))) continue
    hits.push(pid)
  } catch {}
}
process.stdout.write(hits.join(" "))
')
if [ -z "$PIDS" ]; then echo "没有找到控制台进程"; exit 0; fi
for pid in $PIDS; do
  if kill "$pid" 2>/dev/null; then echo "已停止 pid $pid"; fi
done
exit 0
