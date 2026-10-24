@echo off
chcp 65001 >nul
title XiaoMao Share
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Node.js not found.
  echo   Install it first:  https://nodejs.org
  echo.
  echo   Press any key to close...
  pause >nul
  exit /b 1
)

echo.
echo   Starting XiaoMao Share...
node server.js --open

echo.
echo   Service stopped.
echo   Press any key to close...
pause >nul
