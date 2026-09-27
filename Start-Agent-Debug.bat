@echo off
setlocal enabledelayedexpansion

title Flexpulse Agent - Debug Mode

echo.
echo  ================================================================
echo   Flexpulse Agent - Debug Start (with visible logs)
echo  ================================================================
echo.

set "INSTALL_DIR=C:\DeviceFarmAgent"

if not exist "%INSTALL_DIR%" (
    echo [ERROR] Agent not installed at: %INSTALL_DIR%
    echo [*] Please run DeviceFarm-Agent-Setup.bat first
    pause
    exit /b 1
)

cd /d "%INSTALL_DIR%"

echo [*] Killing any existing agent processes...
taskkill /F /IM electron.exe /T >nul 2>&1
taskkill /F /IM node.exe /T >nul 2>&1
taskkill /F /IM adb.exe /T >nul 2>&1
taskkill /F /IM cloudflared.exe /T >nul 2>&1
timeout /t 2 /nobreak >nul

echo [*] Starting agent with full console logging...
echo [*] Dashboard should be at: http://localhost:7400
echo [*] Press Ctrl+C to stop the agent
echo.
echo  ================================================================
echo   AGENT LOGS (LIVE)
echo  ================================================================
echo.

:: Find Node.js
set "NODE="
if exist "%ProgramFiles%\nodejs\node.exe" set "NODE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODE=%LOCALAPPDATA%\Programs\nodejs\node.exe"
if not defined NODE set "NODE=node"

:: Start the agent watchdog directly in console
"%NODE%" src\main\service-watchdog.js

echo.
echo [*] Agent stopped. Press any key to exit...
pause >nul
