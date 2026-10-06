#!/bin/sh
# 设置控制台登录的用户名与密码：
#   scripts/set-password.sh <用户名> <新密码>
# 会同时注销所有已登录的会话（改完需要重新登录）。
set -e
ROOT=$(cd "$(dirname "$0")/.." && pwd)
[ $# -eq 2 ] || { echo "用法：$0 <用户名> <新密码>" >&2; exit 2; }
exec node -e '
const { AuthStore } = await import(process.argv[1] + "/dashboard/lib/auth.js");
const [user, pass] = process.argv.slice(2);
const store = new AuthStore({ file: process.argv[1] + "/runtime/dashboard.auth.json" });
store.setCredential(user, pass);
console.log(`已更新控制台账号：用户名 ${user}（所有已登录会话已失效）`);
' "$ROOT" "$1" "$2"
