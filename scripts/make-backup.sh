#!/usr/bin/env bash
# 生成三件备份：
#   1. qqbot-portable-<ts>.tar.gz   代码（无机密）—— 可上传任何地方 / GitHub
#   2. qqbot-repo-<ts>.bundle       完整 git 历史（单文件）—— 可离线 clone
#   3. qqbot-site-<ts>.tar.gz       整站（含凭据与运行时状态，权限 600）—— 仅本机保存
# 外加 SHA256SUMS 校验和。
#
#   bash scripts/make-backup.sh                 # 用默认 QQBOT_HOME
#   QQBOT_HOME=/data/dsh/home/dfy-qqbot bash scripts/make-backup.sh
set -euo pipefail

QQBOT_HOME="${QQBOT_HOME:-/data/dsh/home/dfy-qqbot}"
TS="$(date +%Y%m%d-%H%M%S)"
OUT="$QQBOT_HOME/backup"
REPO="$QQBOT_HOME/repo"
PROFILE_DIR="${DSH_HOME:-/data/dsh}/profiles/${PROFILE:-web}"

say() { printf '\033[1;36m[backup]\033[0m %s\n' "$1"; }
[ -d "$REPO" ] || { echo "找不到 $REPO（先在仓库目录里跑 install.sh）" >&2; exit 1; }

mkdir -p "$OUT"

# 0. 一致性：把当前运行中的代码同步进仓库目录，并提交。
#    凭据文件是唯一例外：仓库里永远是空白模板，真实凭据只存在于部署目录与整站备份中。
CRED_REL="qqbot-core/cordis.patch.yml"
CRED_TEMPLATE=""
[ -f "$REPO/$CRED_REL" ] && CRED_TEMPLATE="$(mktemp)" && cp -p "$REPO/$CRED_REL" "$CRED_TEMPLATE"
STANDALONE_CFG="$QQBOT_HOME/standalone/config.json"
STANDALONE_KEEP=""
if [ -f "$STANDALONE_CFG" ]; then
  STANDALONE_KEEP="$(mktemp)"
  cp -p "$STANDALONE_CFG" "$STANDALONE_KEEP"
fi
for dir in qqbot-core dashboard shared standalone; do
  rm -rf "$REPO/$dir"
  cp -a "$QQBOT_HOME/$dir" "$REPO/$dir"
done
if [ -n "$CRED_TEMPLATE" ]; then cp -p "$CRED_TEMPLATE" "$REPO/$CRED_REL"; rm -f "$CRED_TEMPLATE"; fi
# 独立模式的部署配置同理：仓库里永远不放真实凭据
rm -f "$REPO/standalone/config.json"
if [ -n "$STANDALONE_KEEP" ]; then rm -f "$STANDALONE_KEEP"; fi

# 机密闸门：宁可不提交，也不把密钥写进版本库。
# 判据来自部署目录里的真实值，脚本自身不含任何机密。
scan_for_secrets() {
  local target="$1" found=0 value
  local values=()
  if [ -f "$QQBOT_HOME/qqbot-core/cordis.patch.yml" ]; then
    value="$(sed -n "s/.*clientSecret: '\([^']*\)'.*/\1/p" "$QQBOT_HOME/qqbot-core/cordis.patch.yml")"
    values+=("$value")
  fi
  if [ -f "$QQBOT_HOME/runtime/dashboard-token.txt" ]; then
    values+=("$(tr -d '\n' < "$QQBOT_HOME/runtime/dashboard-token.txt")")
  fi
  if [ -f "$QQBOT_HOME/standalone/config.json" ]; then
    values+=("$(sed -n 's/.*"clientSecret": *"\([^"]*\)".*/\1/p' "$QQBOT_HOME/standalone/config.json")")
  fi
  # 控制台账号文件里只有 scrypt 哈希，没有明文可扫；它本身也不进仓库。
  for value in "${values[@]}"; do
    [ -n "$value" ] || continue
    if grep -rIl --exclude-dir=.git -- "$value" "$target" >/dev/null 2>&1; then
      echo "[backup] 机密出现在 $target 里，已中止：$(grep -rIl --exclude-dir=.git -- "$value" "$target" | head -3 | tr '\n' ' ')" >&2
      found=1
    fi
  done
  return $found
}

scan_for_secrets "$REPO" || exit 1
cp -a "$QQBOT_HOME/tools/." "$REPO/scripts/" 2>/dev/null || true
if [ ! -d "$REPO/dashboard/node_modules" ]; then :; fi
git -C "$REPO" add -A
git -C "$REPO" -c core.hooksPath=/dev/null commit -q -m "backup $TS" 2>/dev/null || say "无代码变更，跳过提交"

# 1. 可移植包（不含 .git、不含 runtime 状态与凭据）
tar -czf "$OUT/qqbot-portable-$TS.tar.gz" --exclude='.git' --exclude='runtime' -C "$QQBOT_HOME" repo
PORTABLE_CHECK="$(mktemp -d)"
tar -xzf "$OUT/qqbot-portable-$TS.tar.gz" -C "$PORTABLE_CHECK"
if ! scan_for_secrets "$PORTABLE_CHECK"; then
  echo "[backup] 可移植包含机密，已删除该包" >&2
  rm -rf "$PORTABLE_CHECK" "$OUT/qqbot-portable-$TS.tar.gz"
  exit 1
fi
rm -rf "$PORTABLE_CHECK"
say "可移植包：qqbot-portable-$TS.tar.gz"

# 2. git 历史
git -C "$REPO" bundle create "$OUT/qqbot-repo-$TS.bundle" --all >/dev/null
say "git bundle：qqbot-repo-$TS.bundle"

# 3. 整站（绝对路径结构，便于 tar -C / 还原）
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
mkdir -p "$STAGE/data/dsh/home/dfy-qqbot" "$STAGE$PROFILE_DIR"
cp -a "$REPO" "$STAGE/data/dsh/home/dfy-qqbot/"
rm -rf "$STAGE/data/dsh/home/dfy-qqbot/repo/.git"
for f in runtime/qqbot.config.json runtime/dashboard.auth.json runtime/pi-ai-applied.json \
           qqbot-status.json qqbot.log qqbot-core/cordis.patch.yml standalone/config.json; do
  [ -f "$QQBOT_HOME/$f" ] || continue
  mkdir -p "$STAGE/data/dsh/home/dfy-qqbot/$(dirname "$f")"
  cp -p "$QQBOT_HOME/$f" "$STAGE/data/dsh/home/dfy-qqbot/$f"
done
[ -d "$QQBOT_HOME/plugins" ] && cp -a "$QQBOT_HOME/plugins" "$STAGE/data/dsh/home/dfy-qqbot/"
[ -d "$QQBOT_HOME/项目总结" ] && cp -a "$QQBOT_HOME/项目总结" "$STAGE/data/dsh/home/dfy-qqbot/"
for f in cordis.patch.yml package.json; do
  [ -f "$PROFILE_DIR/$f" ] && cp -p "$PROFILE_DIR/$f" "$STAGE$PROFILE_DIR/"
done
cp "$REPO/scripts/RESTORE.md" "$STAGE/RESTORE.md" 2>/dev/null || true
( cd "$STAGE" && find . -type f | sort > MANIFEST.txt )
tar -czf "$OUT/qqbot-site-$TS.tar.gz" -C "$STAGE" .
chmod 600 "$OUT/qqbot-site-$TS.tar.gz"
say "整站备份：qqbot-site-$TS.tar.gz（含机密，权限 600）"

( cd "$OUT" && sha256sum ./*.tar.gz ./*.bundle > SHA256SUMS )
say "校验和：$OUT/SHA256SUMS"
ls -lh "$OUT"
