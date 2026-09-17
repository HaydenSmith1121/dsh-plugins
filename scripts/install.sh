#!/bin/sh
# ============================================================================
# dsh-plugins 一键安装入口（macOS / Linux）—— 可远程执行，不需要先 clone
#
# 两种用法，走的是同一份逻辑：
#
#   ① 远程一行（推荐，不用 clone）
#      curl -fsSL https://raw.githubusercontent.com/HaydenSmith1121/dsh-plugins/main/scripts/install.sh | sh
#
#   ② 仓库内本地运行
#      ./scripts/install.sh
#
#   脚本自己完成全部前置动作，不需要用户先 git clone 再 cd：
#     1. 检查 Node（< 22.19 直接停）
#     2. 把仓库落地到 ~/.dsh-plugins（已存在就 fetch + reset，不重复下载）
#     3. 把控制权交给 scripts/install.mjs —— 检测与安装逻辑只写一份实现，
#        Windows / macOS 共用，就不会出现「修了一个忘了另一个」
#
#   管道执行时不会碰当前目录：仓库固定在 ~/.dsh-plugins，也便于长期保留
#   （profile 里的 file: 依赖指向这里的 tarball，不能随手删）。
#
# 用法：
#   ./scripts/install.sh                    正式安装
#   ./scripts/install.sh --preflight-only   只做环境预检，什么都不装
#   ./scripts/install.sh --dry-run          演练，只打印将执行的命令
#   ./scripts/install.sh --force            dsh 版本不符也强装（不推荐）
#   ./scripts/install.sh --skip-verify      跳过安装后的四步校验
#   ./scripts/install.sh --bootstrap-only   只装引导插件 dsh-plugins-market
#   ./scripts/install.sh --profile web      指定 profile（默认 web）
#
# 环境变量（管道执行时无法传参，可用这些）：
#   DSH_REPO_DIR   仓库落地目录，默认 ~/.dsh-plugins
#   DSH_REPO_URL   仓库地址，默认官方仓库
#   DSH_REF        分支 / 标签，默认 main
#   DSH_INSTALL_ARGS  追加参数，例如 '-BootstrapOnly'
# ============================================================================

set -eu

RULE='  --------------------------------------------------------------------------'
REPO_URL=${DSH_REPO_URL:-https://github.com/HaydenSmith1121/dsh-plugins.git}
REF=${DSH_REF:-main}

printf '\n  dsh-plugins  macOS / Linux one-line install\n'
printf '%s\n' "$RULE"

# ---- 1. Node 前置 ----
if ! command -v node >/dev/null 2>&1; then
  printf '  [X] PATH 里找不到 node。\n'
  printf '      本仓库的检测 / 安装逻辑由 Node 驱动（dsh 本身也需要 Node）。\n'
  printf '      请先安装 Node >= 22.19： https://nodejs.org/\n\n'
  exit 3
fi

NODE_VERSION=$(node -v 2>/dev/null | sed 's/^v//')
NODE_MAJOR=$(printf '%s' "$NODE_VERSION" | cut -d. -f1)
NODE_MINOR=$(printf '%s' "$NODE_VERSION" | cut -d. -f2)
if [ "${NODE_MAJOR:-0}" -lt 22 ] || { [ "${NODE_MAJOR:-0}" -eq 22 ] && [ "${NODE_MINOR:-0}" -lt 19 ]; }; then
  printf '  [X] Node %s 太旧，需要 >= 22.19。\n' "$NODE_VERSION"
  printf '      请升级 Node 后重试： https://nodejs.org/\n\n'
  exit 3
fi
printf '  node    %s\n' "$NODE_VERSION"

# ---- 2. 定位仓库：本地运行就直接用，管道执行就落地到 ~/.dsh-plugins ----
SCRIPT_DIR=''
case "$0" in
  */*) _dir=${0%/*} ;;
  *)   _dir='' ;;
esac
if [ -n "$_dir" ] && [ -f "$_dir/install.mjs" ]; then
  SCRIPT_DIR=$(CDPATH= cd -- "$_dir" && pwd)
fi

if [ -n "$SCRIPT_DIR" ]; then
  REPO_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
  printf '  repo    %s  （本地运行，跳过 clone）\n' "$REPO_ROOT"
else
  REPO_ROOT=${DSH_REPO_DIR:-$HOME/.dsh-plugins}

  if ! command -v git >/dev/null 2>&1; then
    printf '  [X] 需要 git 才能落地仓库，但 PATH 里找不到 git。\n'
    printf '      装好 git 后重试，或手动 clone 后本地运行： ./scripts/install.sh\n\n'
    exit 3
  fi

  if [ -d "$REPO_ROOT/.git" ]; then
    printf '  repo    %s  （已存在，更新到最新）\n' "$REPO_ROOT"
    git -C "$REPO_ROOT" fetch --depth 1 origin "$REF" || {
      printf '  [X] git fetch 失败，请检查网络后重试。\n\n'; exit 3; }
    git -C "$REPO_ROOT" reset --hard FETCH_HEAD || exit 3
  else
    printf '  repo    %s  （克隆仓库…）\n' "$REPO_ROOT"
    git clone --depth 1 --branch "$REF" "$REPO_URL" "$REPO_ROOT" || {
      printf '  [X] git clone 失败，请检查网络 / 代理后重试。\n\n'; exit 3; }
  fi
fi

# ★ Git Bash / MSYS / Cygwin 下 pwd 返回 POSIX 风格路径（如 /d/foo/bar），
#   而 node 是原生 Windows 程序，会把它误解析成当前盘符下的相对路径 →
#   D:\d\foo\bar，然后报 "Cannot find module"。检测到 cygpath 就转成原生路径。
REPO_ROOT_NATIVE=$REPO_ROOT
if command -v cygpath >/dev/null 2>&1; then
  _conv=$(cygpath -w "$REPO_ROOT" 2>/dev/null) || _conv=''
  if [ -n "$_conv" ]; then
    REPO_ROOT_NATIVE=$_conv
  fi
fi

INSTALL_JS="$REPO_ROOT_NATIVE/scripts/install.mjs"
PREFLIGHT_JS="$REPO_ROOT_NATIVE/scripts/preflight.mjs"

# ---- 3. 转发 ----
# install.mjs 自己就认识 -BootstrapOnly 与 --bootstrap-only 两种写法
# （见其参数解析：同时接受驼峰与短横线），所以这里原样透传即可。
# 刻意不做字符串重组（`set -- $ARGS`）—— 那样会把带空格的参数拆坏。
if [ -n "${DSH_INSTALL_ARGS:-}" ]; then
  # shellcheck disable=SC2086
  set -- "$@" $DSH_INSTALL_ARGS
fi

printf '  script  %s\n' "$(basename "$INSTALL_JS")"

if [ "${1:-}" = "--preflight-only" ] || [ "${1:-}" = "-PreflightOnly" ]; then
  shift
  printf '%s\n' "$RULE"
  exec node "$PREFLIGHT_JS" "$@"
fi

if [ ! -f "$INSTALL_JS" ]; then
  printf '  [X] 缺少 %s\n' "$INSTALL_JS"
  printf '      仓库可能没拉全，删掉仓库目录重跑一次即可。\n\n'
  exit 3
fi

printf '%s\n' "$RULE"
exec node "$INSTALL_JS" "$@"
