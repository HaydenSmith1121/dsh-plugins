@echo off
REM ============================================================================
REM  dsh-plugins 开发环境隔离入口（Windows / cmd）
REM
REM  这是 dev-env.ps1 的绕行壳：当 PowerShell 执行策略禁止跑 .ps1 时用它。
REM  它会以 Bypass 策略拉起 .ps1，其余照旧。
REM
REM  用法：
REM    scripts\dev-env.cmd init              创建隔离环境
REM    scripts\dev-env.cmd status            两个环境的对比
REM    scripts\dev-env.cmd doctor            自检隔离是否成立
REM    scripts\dev-env.cmd web               启动隔离环境（默认 3090）
REM    scripts\dev-env.cmd install <tgz>     往隔离环境装插件
REM    scripts\dev-env.cmd --help            完整帮助
REM ============================================================================

setlocal EnableExtensions

set "PS1=%~dp0dev-env.ps1"
if not exist "%PS1%" (
  echo.
  echo   [X] Missing %PS1%
  echo       The repo may be incompletely cloned. Try:  git checkout -- .
  echo.
  exit /b 3
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%PS1%" %*
exit /b %errorlevel%
