@echo off
REM ==========================================================================
REM  dsh-plugins install entry (Windows) - bypasses ExecutionPolicy
REM
REM  PowerShell's default ExecutionPolicy often blocks .ps1 files, which is
REM  the most common "cannot even get started" problem on Windows.
REM  This wrapper launches install.ps1 with -ExecutionPolicy Bypass so users
REM  never have to change their system-wide policy.
REM
REM  Usage:
REM    scripts\install.cmd                  install
REM    scripts\install.cmd -PreflightOnly   read-only environment check
REM    scripts\install.cmd -DryRun          show commands without running
REM ==========================================================================
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*
exit /b %ERRORLEVEL%
