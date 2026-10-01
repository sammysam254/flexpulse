@echo off
setlocal enabledelayedexpansion
title Flexpulse Agent — Console Runner (Live Diagnostics)

echo ================================================================
echo   FLEXPULSE AGENT — LIVE CONSOLE RUNNER
echo ================================================================
echo.

set "INSTALL_DIR=C:\DeviceFarmAgent"
if not exist "%INSTALL_DIR%" set "INSTALL_DIR=%~dp0"
if "%INSTALL_DIR:~-1%"=="\" set "INSTALL_DIR=%INSTALL_DIR:~0,-1%"

cd /d "%INSTALL_DIR%"
echo [*] Working Directory: %CD%

:: 1. Check Node.js
set "NODE="
if exist "%ProgramFiles%\nodejs\node.exe"          set "NODE=%ProgramFiles%\nodejs\node.exe"
if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODE=%LOCALAPPDATA%\Programs\nodejs\node.exe"
if not defined NODE for /f "delims=" %%I in ('where node 2^>nul') do if not defined NODE set "NODE=%%I"

if not defined NODE (
    echo [ERROR] Node.js is NOT found in PATH or standard directories!
    echo [*] Please install Node.js from https://nodejs.org
    pause
    exit /b 1
)
echo [OK] Node.js: %NODE%

:: 2. Check dependencies
if not exist "node_modules\winston\package.json" (
    echo [*] Node modules missing. Running npm install...
    call npm install --no-audit --no-fund
    if !errorlevel! neq 0 (
        echo [ERROR] npm install failed!
        pause
        exit /b 1
    )
)

:: 3. Kill lingering old processes on port 7400
echo [*] Clearing port 7400...
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "Get-NetTCPConnection -LocalPort 7400 -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object { try { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue } catch {} }" >nul 2>&1

:: 4. Locate Electron binary
set "ELECTRON_EXE=node_modules\electron\dist\electron.exe"
if not exist "%ELECTRON_EXE%" (
    for /f "delims=" %%I in ('where electron 2^>nul') do if not defined ELECTRON_EXE set "ELECTRON_EXE=%%I"
)

echo.
echo ================================================================
echo   STARTING AGENT PROCESS (OUTPUT DISPLAYED BELOW)...
echo   Press Ctrl+C to stop.
echo ================================================================
echo.

if exist "%ELECTRON_EXE%" (
    echo [*] Launching with Electron (%ELECTRON_EXE%)...
    "%ELECTRON_EXE%" src\main\index.js
) else (
    echo [*] Electron binary not found locally. Running via npm start...
    npm start
)

echo.
echo [!] Agent process exited with code %errorlevel%.
pause
