@echo off
setlocal enabledelayedexpansion

title Flexpulse Agent - Diagnostics

echo.
echo  ================================================================
echo   Flexpulse Agent Diagnostics
echo  ================================================================
echo.

set "INSTALL_DIR=C:\DeviceFarmAgent"

echo [*] Checking installation directory...
if exist "%INSTALL_DIR%" (
    echo [OK] Install directory exists: %INSTALL_DIR%
) else (
    echo [ERROR] Install directory not found: %INSTALL_DIR%
    echo [*] Please run DeviceFarm-Agent-Setup.bat first
    pause
    exit /b 1
)

echo.
echo [*] Checking Node.js installation...
where node >nul 2>&1
if !errorlevel! equ 0 (
    for /f "delims=" %%V in ('node --version 2^>nul') do echo [OK] Node.js version: %%V
) else (
    echo [ERROR] Node.js not found in PATH
)

echo.
echo [*] Checking running processes...
powershell -NoProfile -Command "Get-Process | Where-Object { $_.ProcessName -match 'node|electron' -and $_.Path -like '*DeviceFarm*' } | Format-Table ProcessName, Id, StartTime -AutoSize"

echo.
echo [*] Checking if port 7400 is listening...
powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort 7400 -ErrorAction SilentlyContinue | Select-Object LocalAddress, LocalPort, State, OwningProcess | Format-Table -AutoSize"
if !errorlevel! neq 0 (
    echo [WARN] Port 7400 is NOT listening - Dashboard is not running
)

echo.
echo [*] Checking ADB devices...
if exist "%INSTALL_DIR%\assets\bin\adb.exe" (
    "%INSTALL_DIR%\assets\bin\adb.exe" devices
) else (
    echo [WARN] ADB not found at: %INSTALL_DIR%\assets\bin\adb.exe
)

echo.
echo [*] Checking recent logs...
if exist "%INSTALL_DIR%\logs" (
    echo Last 20 log entries:
    powershell -NoProfile -Command "Get-ChildItem '%INSTALL_DIR%\logs\*.log' | Sort-Object LastWriteTime -Descending | Select-Object -First 1 | ForEach-Object { Get-Content $_.FullName -Tail 20 }"
) else (
    echo [WARN] No logs directory found
)

echo.
echo [*] Checking config.json...
if exist "%INSTALL_DIR%\config.json" (
    echo [OK] config.json exists
    type "%INSTALL_DIR%\config.json"
) else (
    echo [WARN] config.json not found
)

echo.
echo  ================================================================
echo   Diagnostics Complete
echo  ================================================================
echo.
echo Press any key to exit...
pause >nul
