@echo off
title DeviceFarm Agent Clean Reset & Launch
echo ================================================================
echo   KILLING ALL ADB, ELECTRON, NODE, AND CLOUDFLARED PROCESSES...
echo ================================================================

taskkill /F /IM node.exe /T >nul 2>&1
taskkill /F /IM electron.exe /T >nul 2>&1
taskkill /F /IM adb.exe /T >nul 2>&1
taskkill /F /IM cloudflared.exe /T >nul 2>&1
taskkill /F /IM scrcpy.exe /T >nul 2>&1

echo [*] Terminated all lingering processes and released ports.
ping 127.0.0.1 -n 3 >nul 2>&1

echo [*] Pulling latest fixes from GitHub (main)...
git fetch origin main >nul 2>&1
git reset --hard origin/main
git clean -fd

echo [*] Launching Setup with clean USB debugging and live streaming fixes...
call Setup.bat
