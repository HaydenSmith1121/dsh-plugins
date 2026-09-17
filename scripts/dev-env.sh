#!/bin/sh
# ============================================================================
# dsh-plugins 开发环境隔离入口（macOS / Linux / Git Bash）
#
# 和 install.sh 一样，这只是个薄壳：找到 node，把控制权交给
# scripts/dev-env.mjs。判定逻辑只写一份，三个平台共用。
#
# 它做的事：给一个隔离的 DSH_HOME 起 harness，让你调插件时不打扰
# 日常在用的那套环境（端口也不同，可以同时跑）。
#
# 用法：
#   ./scripts/dev-env.sh init                创建隔离环境
#   ./scripts/dev-env.sh status              两个环境的对比
#   ./scripts/dev-env.sh doctor              自检隔离是否成立
#   ./scripts/dev-env.sh web                 启动隔离环境（默认 3090）
#   ./scripts/dev-env.sh install <tgz>       往隔离环境装插件
#   ./scripts/dev-env.sh shell               打印隔离环境变量
#
# 选项（透传给 dev-env.mjs）：
#   --home <path>      隔离 home（默认 ~/.dsh-dev）
#   --profile <name>   隔离 profile 名（默认 dev）
#   --port <n>         隔离端口（默认 3090）
# ============================================================================

set -eu

# 取脚本所在目录。刻意不用 dirname，避免个别环境 PATH 不全时失败。
case "$0" in
  */*) _dir=${0%/*} ;;
  *)   _dir=. ;;
esac
SCRIPT_DIR=$(CDPATH= cd -- "$_dir" && pwd)

# ★ Git Bash / MSYS / Cygwin 下 pwd 返回 POSIX 风格路径（/d/foo/bar），
#   而 node 是原生 Windows 程序，会把它误解析成 D:\d\foo\bar。
#   有 cygpath 就转成原生路径；真正的 macOS / Linux 上没有 cygpath，保持原样。
SCRIPT_DIR_NATIVE=$SCRIPT_DIR
if command -v cygpath >/dev/null 2>&1; then
  _conv=$(cygpath -w "$SCRIPT_DIR" 2>/dev/null) || _conv=''
  if [ -n "$_conv" ]; then
    SCRIPT_DIR_NATIVE=$_conv
  fi
fi

DEV_ENV_JS="$SCRIPT_DIR_NATIVE/dev-env.mjs"

if ! command -v node >/dev/null 2>&1; then
  printf '\n  [X] Cannot find "node" in PATH.\n'
  printf '      Please install Node >= 22.19 first:  https://nodejs.org/\n\n'
  exit 2
fi

if [ ! -f "$DEV_ENV_JS" ]; then
  printf '\n  [X] Missing %s\n' "$DEV_ENV_JS"
  printf '      The repo may be incompletely cloned. Try:  git checkout -- .\n\n'
  exit 3
fi

exec node "$DEV_ENV_JS" "$@"
