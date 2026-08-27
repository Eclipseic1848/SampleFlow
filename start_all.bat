@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"

where docker >nul 2>nul
if errorlevel 1 (
  echo [SampleFlow] Docker was not found. Start Docker Desktop first.
  pause
  exit /b 1
)

where node >nul 2>nul
if errorlevel 1 (
  echo [SampleFlow] Node.js 24 or newer was not found.
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo [SampleFlow] Installing project dependencies...
  call npm.cmd install
  if errorlevel 1 (
    echo [SampleFlow] Dependency installation failed.
    pause
    exit /b 1
  )
)

echo [SampleFlow] Starting PostgreSQL, migrations and hot-reload services...
node scripts\dev-start.mjs
if errorlevel 1 (
  echo [SampleFlow] Startup failed. Review the error above.
  pause
  exit /b 1
)
