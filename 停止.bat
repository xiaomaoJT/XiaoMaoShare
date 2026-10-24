@echo off
chcp 65001 >nul
title Stop XiaoMao Share
cd /d "%~dp0"

set "FOUND="

rem Kill whatever is listening on the share port (default 6767)
for /f "tokens=5" %%p in ('netstat -ano ^| findstr /r /c:":6767 " ^| findstr "LISTENING"') do (
  taskkill /f /pid %%p >nul 2>&1
  set "FOUND=1"
)

if defined FOUND (
  echo.
  echo   XiaoMao Share stopped.
) else (
  echo.
  echo   Not running on port 6767.
)

timeout /t 2 >nul
