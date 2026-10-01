@echo off
title Stop All DeviceFarm Processes (No Restart)
echo ================================================================
echo   STOPPING ALL PROCESSES AND PREVENTING RESTART...
echo ================================================================
echo.

:: 1. Disable / delete Windows Scheduled Tasks so they cannot restart
echo [*] Disabling and removing auto-start scheduled tasks...
schtasks /change /tn "DeviceFarm_Agent_BootService" /disable >nul 2>&1
schtasks /change /tn "DeviceFarm_Agent_LogonService" /disable >nul 2>&1
schtasks /delete /tn "DeviceFarm_Agent_BootService" /f >nul 2>&1
schtasks /delete /tn "DeviceFarm_Agent_LogonService" /f >nul 2>&1
schtasks /delete /tn "DeviceFarm Agent AutoStart" /f >nul 2>&1

:: 2. Remove startup folder shortcuts
echo [*] Removing startup shortcuts...
if exist "%ProgramData%\Microsoft\Windows\Start Menu\Programs\Startup\DeviceFarm-Agent-Service.lnk" (
    del /f /q "%ProgramData%\Microsoft\Windows\Start Menu\Programs\Startup\DeviceFarm-Agent-Service.lnk" >nul 2>&1
)
if exist "%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\DeviceFarm-Agent-Service.lnk" (
    del /f /q "%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\DeviceFarm-Agent-Service.lnk" >nul 2>&1
)

:: 3. Terminate wscript (VBS launcher) first so it doesn't spawn node/electron
echo [*] Terminating launcher scripts (wscript)...
taskkill /F /IM wscript.exe /T >nul 2>&1

:: 4. Terminate watchdog and node instances
echo [*] Terminating Node.js and watchdog processes...
taskkill /F /IM node.exe /T >nul 2>&1

:: 5. Terminate Electron GUI / agent processes
echo [*] Terminating Electron processes...
taskkill /F /IM electron.exe /T >nul 2>&1

:: 6. Terminate scrcpy video streamers
echo [*] Terminating scrcpy processes...
taskkill /F /IM scrcpy.exe /T >nul 2>&1

:: 7. Terminate adb daemon
echo [*] Terminating ADB processes...
taskkill /F /IM adb.exe /T >nul 2>&1

:: 8. Terminate Cloudflare tunnel
echo [*] Terminating Cloudflare tunnel...
taskkill /F /IM cloudflared.exe /T >nul 2>&1

echo.
echo ================================================================
echo   [SUCCESS] All processes killed.
echo   All auto-start tasks removed. Nothing will restart.
echo ================================================================
echo.
pause
