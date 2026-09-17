@echo off
REM ============================================================================
REM  dsh-plugins dev environment isolation entry point (Windows / cmd)
REM
REM  This is the bypass shell for dev-env.ps1: use it when the PowerShell
REM  execution policy forbids running .ps1 files. It launches the .ps1 with
REM  -ExecutionPolicy Bypass and forwards everything else unchanged.
REM
REM  Usage:
REM    scripts\dev-env.cmd init              create the isolated environment
REM    scripts\dev-env.cmd status            compare both environments
REM    scripts\dev-env.cmd doctor            self-check that isolation holds
REM    scripts\dev-env.cmd web               start the isolated harness (3090)
REM    scripts\dev-env.cmd install <tgz>     install a plugin into it
REM    scripts\dev-env.cmd --help            full help
REM
REM  NOTE: this file is deliberately ASCII-only.
REM  cmd.exe reads a .cmd file using the *active console code page* (936/GBK on
REM  zh-CN Windows), so UTF-8 text in a REM line is decoded byte-wise as GBK and
REM  can produce fragments that cmd tries to execute as commands. Keep all text
REM  in this file ASCII. Chinese belongs in dev-env.ps1 (which is UTF-8 BOM).
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
