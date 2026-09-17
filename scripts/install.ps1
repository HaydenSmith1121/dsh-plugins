#Requires -Version 5.1
<#
.SYNOPSIS
    dsh-plugins 安装入口（Windows）

.DESCRIPTION
    这只是个薄壳：找到 node，然后把控制权交给 scripts/install.mjs。

    为什么不在 .ps1 里直接实现检测和安装逻辑？
    因为 .sh 也要做同样的事。逻辑只写一份（Node），Windows 与 macOS/Linux
    共用同一套判定，就不会出现「两个平台行为不一致、修了一个忘了另一个」。

    这个壳只负责三件事：
      1. 提示执行策略问题（Windows 上最常见的「第一步就跑不起来」）
      2. 找到 node
      3. 把参数原样转发给 install.mjs

.PARAMETER PreflightOnly
    只做环境预检，什么都不装。建议第一次先跑这个。

.PARAMETER DryRun
    演练：把将要执行的命令全部打印出来，但不真正改动任何东西。

.PARAMETER Force
    dsh 版本不受支持时也强行安装。不推荐，启动很可能失败。

.PARAMETER SkipVerify
    跳过安装后的四步校验（含 35 秒的真实启动试跑）。

.PARAMETER Profile
    dsh profile 名，默认 web。

.EXAMPLE
    .\scripts\install.ps1 -PreflightOnly
    看看这台机器的环境到底行不行，不动任何东西。

.EXAMPLE
    .\scripts\install.ps1 -DryRun
    看看安装会执行哪些命令，不动任何东西。

.EXAMPLE
    .\scripts\install.ps1
    正式安装，装完自动跑四步校验。

.NOTES
    如果报「无法加载文件，因为在此系统上禁止运行脚本」，
    改用 scripts\install.cmd，它会以 Bypass 策略拉起本脚本。
#>
[CmdletBinding()]
param(
    [switch]$PreflightOnly,
    [switch]$DryRun,
    [switch]$Force,
    [switch]$SkipVerify,
    [string]$Profile
)

$ErrorActionPreference = 'Stop'

$scriptDir   = $PSScriptRoot
$installJs   = Join-Path $scriptDir 'install.mjs'
$preflightJs = Join-Path $scriptDir 'preflight.mjs'
$rule        = '  ' + ('-' * 74)

Write-Host ''
Write-Host '  dsh-plugins  Windows install entry'
Write-Host $rule -ForegroundColor DarkGray

# ---- 1. 执行策略：Windows 上最常见的第一个拦路虎 ----
$policy = Get-ExecutionPolicy -Scope CurrentUser
if ($policy -ne 'Bypass' -and $policy -ne 'Unrestricted' -and $policy -ne 'RemoteSigned') {
    Write-Host "  [!] ExecutionPolicy (CurrentUser) = $policy" -ForegroundColor Yellow
    Write-Host '      .ps1 may be refused. If you see "running scripts is disabled",' -ForegroundColor DarkGray
    Write-Host '      use  scripts\install.cmd  instead, or run:' -ForegroundColor DarkGray
    Write-Host '        powershell -ExecutionPolicy Bypass -File .\scripts\install.ps1' -ForegroundColor DarkGray
    Write-Host ''
}

# ---- 2. 找 node ----
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) {
    Write-Host '  [X] Cannot find "node" in PATH.' -ForegroundColor Red
    Write-Host '      The detection / installation logic of this repo is driven by Node' -ForegroundColor DarkGray
    Write-Host '      (and dsh itself needs Node too).' -ForegroundColor DarkGray
    Write-Host '      Please install Node >= 22.19 first:  https://nodejs.org/' -ForegroundColor DarkGray
    Write-Host ''
    exit 3
}

# ---- 3. 确认脚本在位 ----
$target = if ($PreflightOnly) { $preflightJs } else { $installJs }
if (-not (Test-Path -LiteralPath $target)) {
    Write-Host "  [X] Missing $target" -ForegroundColor Red
    Write-Host '      The repo may be incompletely cloned. Try:  git checkout -- .' -ForegroundColor DarkGray
    Write-Host ''
    exit 3
}

# ---- 4. 组装参数并转发 ----
$nodeArgs = @($target)
if ($DryRun)     { $nodeArgs += '--dry-run' }
if ($Force)      { $nodeArgs += '--force' }
if ($SkipVerify) { $nodeArgs += '--skip-verify' }
if ($Profile)    { $nodeArgs += '--profile'; $nodeArgs += $Profile }

Write-Host "  node  $($nodeCmd.Source)" -ForegroundColor DarkGray
Write-Host "  script  $([System.IO.Path]::GetFileName($target))" -ForegroundColor DarkGray

& $nodeCmd.Source @nodeArgs
$code = $LASTEXITCODE
if ($null -eq $code) { $code = 0 }

Write-Host $rule -ForegroundColor DarkGray
if ($code -eq 0) {
    Write-Host '  Done.' -ForegroundColor Green
} else {
    Write-Host "  Exited with code $code." -ForegroundColor Yellow
}
Write-Host ''

exit $code
