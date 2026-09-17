#!/bin/sh
# ============================================================================
# dsh-plugins 安装入口（macOS / Linux）
#
# 和 install.ps1 一样，这只是个薄壳：找到 node，然后把控制权交给
# scripts/install.mjs。检测与安装逻辑只写一份实现，两个平台共用，
# 就不会出现「修了一个忘了另一个」。
#
# 用法：
#   ./scripts/install.sh                 正式安装
#   ./scripts/install.sh --preflight-only  只做环境预检，什么都不装
#   ./scripts/install.sh --dry-run         演练，只打印将执行的命令
#   ./scripts/install.sh --force           dsh 版本不符也强装（不推荐）
#   ./scripts/install.sh --skip-verify     跳过安装后的四步校验
#   ./scripts/install.sh --profile web     指定 profile（默认 web）
# ============================================================================

set -eu

# 取脚本所在目录。刻意不用 dirname，避免个别环境 PATH 不全时失败。
case "$0" in
  */*) _dir=${0%/*} ;;
  *)   _dir=. ;;
esac
SCRIPT_DIR=$(CDPATH= cd -- "$_dir" && pwd)

# ★ Git Bash / MSYS / Cygwin 下，pwd 返回的是 POSIX 风格路径（如 /d/foo/bar），
#   而 node 是原生 Windows 程序，会把它误解析成当前盘符下的相对路径 →
#   D:\d\foo\bar，然后报 "Cannot find module"。检测到 cygpath 就用它转成原生路径。
#   真正的 macOS / Linux 上没有 cygpath，保持原样即可。
SCRIPT_DIR_NATIVE=$SCRIPT_DIR
if command -v cygpath >/dev/null 2>&1; then
  _conv=$(cygpath -w "$SCRIPT_DIR" 2>/dev/null) || _conv=''
  if [ -n "$_conv" ]; then
    SCRIPT_DIR_NATIVE=$_conv
  fi
fi

INSTALL_JS="$SCRIPT_DIR_NATIVE/install.mjs"
PREFLIGHT_JS="$SCRIPT_DIR_NATIVE/preflight.mjs"
RULE='  --------------------------------------------------------------------------'

printf '\n  dsh-plugins  macOS / Linux install entry\n'
printf '%s\n' "$RULE"

# ---- 1. 找 node ----
if ! command -v node >/dev/null 2>&1; then
  printf '  [X] Cannot find "node" in PATH.\n'
  printf '      The detection / installation logic of this repo is driven by Node\n'
  printf '      (and dsh itself needs Node too).\n'
  printf '      Please install Node >= 22.19 first:  https://nodejs.org/\n\n'
  exit 3
fi
printf '  node     %s\n' "$(node -v 2>/dev/null || echo '?')"
printf '  script   %s\n' "$(basename "$INSTALL_JS" 2>/dev/null || echo install.mjs)"

# ---- 2. 转发 ----
if [ "${1:-}" = "--preflight-only" ]; then
  shift
  printf '%s\n' "$RULE"
  exec node "$PREFLIGHT_JS" "$@"
fi

if [ ! -f "$INSTALL_JS" ]; then
  printf '  [X] Missing %s\n' "$INSTALL_JS"
  printf '      The repo may be incompletely cloned. Try:  git checkout -- .\n\n'
  exit 3
fi

printf '%s\n' "$RULE"
exec node "$INSTALL_JS" "$@"
