<#
.SYNOPSIS
    dsh-plugins 开发环境隔离入口（Windows）

.DESCRIPTION
    薄壳：找到 node，把控制权交给 scripts/dev-env.mjs。

    作用是把「日常在用的 harness」和「开发插件的 harness」分成两套：
      - 不同的 DSH_HOME（默认 ~/.dsh-dev，生产是 ~/.dsh）
      - 不同的 profile 名（默认 dev，生产是 web）
      - 不同的端口（默认 3090，生产是 3080）
    两套可以同时跑，开发时改坏插件树也不会影响日常使用。

    为什么逻辑不写在这里：.sh 也要做同样的事。逻辑只有一份（Node），
    三个平台行为一致，就不会「修了一个忘了另一个」。

.PARAMETER Command
    子命令，默认 status：
      init      创建隔离环境
      status    两个环境的对比
      doctor    自检隔离是否成立
      web       启动隔离环境
      install   往隔离环境装插件（后接 tarball 路径）
      list      隔离环境的插件列表
      config    隔离环境的装配树
      shell     打印隔离环境变量

.PARAMETER Home
    隔离 home 位置，默认 ~/.dsh-dev。

.PARAMETER Profile
    隔离 profile 名，默认 dev。

.PARAMETER Port
    隔离端口，默认 3090。

.EXAMPLE
    .\scripts\dev-env.ps1 init
    创建隔离环境。

.EXAMPLE
    .\scripts\dev-env.ps1 web
    启动隔离环境（http://127.0.0.1:3090），生产环境不受影响。

.EXAMPLE
    .\scripts\dev-env.ps1 install D:\build\my-plugin.tgz
    把开发中的插件装进隔离环境。

.EXAMPLE
    .\scripts\dev-env.ps1 doctor
    检查隔离是否真的成立。

.NOTES
    报「禁止运行脚本」时，改用 scripts\dev-env.cmd。
#>
[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [string]$Command = 'status',

    [string]$Home,
    [string]$Profile,
    [string]$Port,

    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$Rest
)

$ErrorActionPreference = 'Stop'

$devEnvJs = Join-Path $PSScriptRoot 'dev-env.mjs'
$rule = '  ' + ('-' * 74)

Write-Host ''
Write-Host '  dsh-plugins  dev environment isolation'
Write-Host $rule -ForegroundColor DarkGray

$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) {
    Write-Host '  [X] Cannot find "node" in PATH.' -ForegroundColor Red
    Write-Host '      Please install Node >= 22.19 first:  https://nodejs.org/' -ForegroundColor DarkGray
    Write-Host ''
    exit 2
}

if (-not (Test-Path -LiteralPath $devEnvJs)) {
    Write-Host "  [X] Missing $devEnvJs" -ForegroundColor Red
    Write-Host '      The repo may be incompletely cloned. Try:  git checkout -- .' -ForegroundColor DarkGray
    Write-Host ''
    exit 3
}

$nodeArgs = @($devEnvJs, $Command)
if ($Home)    { $nodeArgs += @('--home', $Home) }
if ($Profile) { $nodeArgs += @('--profile', $Profile) }
if ($Port)    { $nodeArgs += @('--port', $Port) }
if ($Rest)    { $nodeArgs += $Rest }

& $nodeCmd.Source @nodeArgs
$code = $LASTEXITCODE
if ($null -eq $code) { $code = 0 }

exit $code
