@echo off
rem llmapi-manager portable launcher.
rem Keep this file ASCII-only: .cmd files are read using the OEM/ANSI code page.
setlocal
set "SCRIPT=%~dp0scripts\windows\start-portable.ps1"
if not exist "%SCRIPT%" set "SCRIPT=%~dp0start-portable.ps1"
if not exist "%SCRIPT%" (
  echo start-portable.ps1 not found. Re-extract the portable package.
  exit /b 1
)
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT%" %*
exit /b %ERRORLEVEL%
