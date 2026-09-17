@echo off
REM ============================================================================
REM  dsh-plugins -- one-click launcher for the ISOLATED DEV harness (port 3090)
REM
REM  What this does:
REM    Sets DSH_HOME to the isolated dev home (~/.dsh-dev) and starts
REM    `dsh web --port 3090`. Your everyday harness on port 3080 is NOT touched:
REM    different DSH_HOME = different profile, plugins, credentials, settings,
REM    sessions. The two can run at the same time.
REM
REM  Double-click this file, or run it from a terminal.
REM  Extra arguments are forwarded, e.g.:
REM      <this file> --no-open
REM
REM  To stop: close this window, or press Ctrl+C in it.
REM
REM  Full docs: the "dev environment isolation" guide (README-*.md, repo root)
REM
REM  NOTE: keep this file ASCII-only. cmd.exe reads a .cmd file using the
REM  active console code page (936/GBK on zh-CN Windows), so UTF-8 text in a
REM  REM line decodes to byte garbage that cmd may try to execute.
REM ============================================================================

setlocal EnableExtensions
cd /d "%~dp0"

set "ENTRY=%~dp0scripts\dev-env.cmd"
if not exist "%ENTRY%" (
  echo.
  echo   [X] Missing scripts\dev-env.cmd
  echo       The repo may be incomplete. Try:  git checkout -- .
  echo.
  pause
  exit /b 3
)

call "%ENTRY%" web %*
set "CODE=%errorlevel%"

echo.
if not "%CODE%"=="0" (
  echo   [X] Dev harness exited with code %CODE%
  echo       See the output above. Troubleshooting: the isolation guide README-*.md
) else (
  echo   Dev harness stopped.
)
echo.
pause
exit /b %CODE%
