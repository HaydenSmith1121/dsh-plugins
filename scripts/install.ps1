#Requires -Version 5.1
<#
.SYNOPSIS
    dsh-plugins 一键安装入口（Windows）—— 可远程执行，不需要先 clone

.DESCRIPTION
    两种用法，走的是同一份逻辑：

      ① 远程一行（推荐，不用 clone）
         irm https://raw.githubusercontent.com/HaydenSmith1121/dsh-plugins/main/scripts/install.ps1 | iex

      ② 仓库内本地运行
         .\scripts\install.ps1

    脚本自己完成全部前置动作，不需要用户先 git clone 再 cd：
      1. 检查 Node（< 22.19 直接停，并给出该装的版本）
      2. 把仓库落地到 ~/.dsh-plugins（已存在就 fetch + reset 到最新，不重复下载）
      3. 把控制权交给 scripts/install.mjs —— 检测与安装逻辑只写一份，
         Windows / macOS 共用，不会出现「修了一个忘了另一个」

    远程执行时不会碰当前目录：仓库固定在 ~/.dsh-plugins，也便于长期保留
    （profile 里的 file: 依赖指向这里的 tarball，不能随手删）。

.PARAMETER PreflightOnly
    只做环境预检，什么都不装。建议第一次先跑这个。

.PARAMETER DryRun
    演练：把将要执行的命令全部打印出来，但不真正改动任何东西。

.PARAMETER Force
    dsh 版本不受支持时也强行安装。不推荐，启动很可能失败。

.PARAMETER SkipVerify
    跳过安装后的四步校验（含约 35 秒的真实启动试跑）。

.PARAMETER BootstrapOnly
    只装引导插件 dsh-plugins-market（其余插件在 GUI 插件市场里点装）。
    远程管道（irm | iex）场景下参数只能靠环境变量传，见 DSH_INSTALL_ARGS。

.PARAMETER Profile
    dsh profile 名，默认 web。

.PARAMETER RepoDir
    仓库落地目录，默认 ~/.dsh-plugins。

.PARAMETER RepoUrl
    仓库地址，默认官方仓库。

.PARAMETER Ref
    使用哪个分支 / 标签，默认 main。

.EXAMPLE
    irm https://raw.githubusercontent.com/HaydenSmith1121/dsh-plugins/main/scripts/install.ps1 | iex
    一条命令装完：落地仓库 → 预检 → 装插件 → 校验。

.EXAMPLE
    .\scripts\install.ps1 -PreflightOnly
    看看这台机器的环境到底行不行，不动任何东西。

.EXAMPLE
    $env:DSH_INSTALL_ARGS = '-BootstrapOnly'; irm <同上> | iex
    远程执行时只装引导插件（管道进 iex 无法直接传参）。

.NOTES
    如果报「无法加载文件，因为在此系统上禁止运行脚本」，用下面这条拉起来：
      powershell -ExecutionPolicy Bypass -File .\scripts\install.ps1

    远程管道方式（irm | iex）不经过文件，不受执行策略限制。

    为什么没有 [CmdletBinding()]：
      它属于 attribute，语法上必须紧跟在 param() 之前 —— 而这会让
      `irm ... | iex` 报 "Unexpected attribute 'CmdletBinding'"；
      没有它时普通 param() 块在 Windows PowerShell 5.1 下同样可用，
      错误处理交给下面的 $ErrorActionPreference = 'Stop'。
#>
param(
    [switch]$PreflightOnly,
    [switch]$DryRun,
    [switch]$Force,
    [switch]$SkipVerify,
    [switch]$BootstrapOnly,
    [string]$Profile,
    [string]$RepoDir,
    [string]$RepoUrl = 'https://github.com/HaydenSmith1121/dsh-plugins.git',
    [string]$Ref = 'main'
)

$ErrorActionPreference = 'Stop'

$rule = '  ' + ('-' * 74)
Write-Host ''
Write-Host '  dsh-plugins  Windows one-line install'
Write-Host $rule -ForegroundColor DarkGray

# ---------------------------------------------------------------- 远程管道参数
# `irm ... | iex` 没法往脚本传参，所以留一个环境变量口子，例如：
#   $env:DSH_INSTALL_ARGS = '-BootstrapOnly'
if ($env:DSH_INSTALL_ARGS) {
    foreach ($a in ($env:DSH_INSTALL_ARGS -split '\s+')) {
        if (-not $a) { continue }
        # ★ switch -Regex 默认大小写敏感（'-PreflightOnly' 这种驼峰会漏掉），
        #   所以先把参数归一化成「全小写、无连字符」再匹配：
        #   -PreflightOnly / --preflight-only / preflight 都收敛成 preflightonly。
        $flag = $a.ToLowerInvariant() -replace '[^a-z]', ''
        switch ($flag) {
            { $_ -in 'bootstraponly', 'bootstrap' } { $BootstrapOnly = $true; continue }
            { $_ -in 'preflightonly', 'preflight' } { $PreflightOnly = $true; continue }
            { $_ -in 'dryrun', 'dry' }              { $DryRun        = $true; continue }
            'force'                                 { $Force         = $true; continue }
            { $_ -in 'skipverify', 'skip' }         { $SkipVerify    = $true; continue }
            default { Write-Host "  [!] 忽略无法识别的 DSH_INSTALL_ARGS 项：$a" -ForegroundColor Yellow }
        }
    }
}

# 远程执行时无法传参，仓库位置也可从环境变量读（与 install.sh 保持一致）。
if (-not $RepoDir -and $env:DSH_REPO_DIR) { $RepoDir = $env:DSH_REPO_DIR }
if ($env:DSH_REPO_URL) { $RepoUrl = $env:DSH_REPO_URL }
if ($env:DSH_REF)      { $Ref     = $env:DSH_REF }

# ---------------------------------------------------------------- 1. Node 前置
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) {
    Write-Host '  [X] PATH 里找不到 node。' -ForegroundColor Red
    Write-Host '      本仓库的检测 / 安装逻辑由 Node 驱动（dsh 本身也需要 Node）。' -ForegroundColor DarkGray
    Write-Host '      请先安装 Node >= 22.19： https://nodejs.org/' -ForegroundColor DarkGray
    Write-Host ''
    exit 3
}
$nodeVersion = (& $nodeCmd.Source -v).TrimStart('v')
$nodeMajor = [int]($nodeVersion -split '\.')[0]
$nodeMinor = [int](($nodeVersion -split '\.')[1])
if ($nodeMajor -lt 22 -or ($nodeMajor -eq 22 -and $nodeMinor -lt 19)) {
    Write-Host "  [X] Node $nodeVersion 太旧，需要 >= 22.19。" -ForegroundColor Red
    Write-Host '      请升级 Node 后重试： https://nodejs.org/' -ForegroundColor DarkGray
    Write-Host ''
    exit 3
}
Write-Host "  node    $nodeVersion" -ForegroundColor DarkGray

# ---------------------------------------------------------------- 2. 落地仓库
function Resolve-RepoRoot {
    param([string]$ScriptRoot)
    if (-not $ScriptRoot) { return $null }
    $candidate = Join-Path $ScriptRoot 'install.mjs'
    if (Test-Path -LiteralPath $candidate) { return (Split-Path -Parent $ScriptRoot) }
    return $null
}

$repoRoot = Resolve-RepoRoot -ScriptRoot $PSScriptRoot

if ($repoRoot) {
    Write-Host "  repo    $repoRoot  （本地运行，跳过 clone）" -ForegroundColor DarkGray
} else {
    # —— 远程管道执行：把仓库 clone / 更新到固定位置 ——
    if (-not $RepoDir) { $RepoDir = Join-Path $HOME '.dsh-plugins' }

    $gitCmd = Get-Command git -ErrorAction SilentlyContinue
    if (-not $gitCmd) {
        Write-Host '  [X] 需要 git 才能落地仓库，但 PATH 里找不到 git。' -ForegroundColor Red
        Write-Host '      装好 git 后重试： https://git-scm.com/downloads' -ForegroundColor DarkGray
        Write-Host '      或手动 clone 后本地运行： .\scripts\install.ps1' -ForegroundColor DarkGray
        Write-Host ''
        exit 3
    }

    if (Test-Path -LiteralPath (Join-Path $RepoDir '.git')) {
        Write-Host "  repo    $RepoDir  （已存在，更新到最新）" -ForegroundColor DarkGray
        & $gitCmd.Source -C $RepoDir fetch --depth 1 origin $Ref
        if ($LASTEXITCODE -ne 0) {
            Write-Host "  [X] git fetch 失败，请检查网络后重试。" -ForegroundColor Red
            Write-Host ''
            exit 3
        }
        & $gitCmd.Source -C $RepoDir reset --hard FETCH_HEAD
        if ($LASTEXITCODE -ne 0) { exit 3 }
    } else {
        Write-Host "  repo    $RepoDir  （克隆仓库…）" -ForegroundColor DarkGray
        & $gitCmd.Source clone --depth 1 --branch $Ref $RepoUrl $RepoDir
        if ($LASTEXITCODE -ne 0) {
            Write-Host "  [X] git clone 失败，请检查网络 / 代理后重试。" -ForegroundColor Red
            Write-Host ''
            exit 3
        }
    }
    $repoRoot = $RepoDir
}

# ---------------------------------------------------------------- 3. 交给 install.mjs
$target = if ($PreflightOnly) {
    Join-Path $repoRoot 'scripts/preflight.mjs'
} else {
    Join-Path $repoRoot 'scripts/install.mjs'
}

if (-not (Test-Path -LiteralPath $target)) {
    Write-Host "  [X] 缺少 $target" -ForegroundColor Red
    Write-Host '      仓库可能没拉全，删掉仓库目录重跑一次即可。' -ForegroundColor DarkGray
    Write-Host ''
    exit 3
}

$nodeArgs = @($target)
if ($DryRun)        { $nodeArgs += '--dry-run' }
if ($Force)         { $nodeArgs += '--force' }
if ($SkipVerify)    { $nodeArgs += '--skip-verify' }
if ($BootstrapOnly) { $nodeArgs += '--bootstrap-only' }
if ($Profile)       { $nodeArgs += '--profile'; $nodeArgs += $Profile }

Write-Host "  script  $([System.IO.Path]::GetFileName($target))" -ForegroundColor DarkGray
Write-Host $rule -ForegroundColor DarkGray

# ★ 管道给 node 的输出和 node 自己的 stdout 可能还在缓冲区里，先 Flush 再收尾，
#   否则 `irm | iex` 场景下会出现「命令跑了但什么都没打印」。
& $nodeCmd.Source @nodeArgs
$code = $LASTEXITCODE
if ($null -eq $code) { $code = 0 }

[Console]::Out.Flush()

Write-Host $rule -ForegroundColor DarkGray
if ($code -eq 0) {
    Write-Host '  Done.' -ForegroundColor Green
} else {
    Write-Host "  Exited with code $code." -ForegroundColor Yellow
}
Write-Host ''

# ★ 管道执行（irm | iex）时没有脚本文件路径，$PSScriptRoot 为空 —— 用它来判定；
#   此时用 exit 会立刻终止宿主会话并丢弃还没刷出去的输出（实测 node 的 stdout
#   会整个消失），改成 return + 设置退出码，行为等价但不吞输出。
$piped = [string]::IsNullOrEmpty($PSScriptRoot) -or $env:DSH_FROM_IEX -eq '1'
if ($piped) {
    $global:LASTEXITCODE = $code
    return
}
exit $code
