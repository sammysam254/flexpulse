@echo off
setlocal enabledelayedexpansion

:: ── Self-replicate to %TEMP% so git update cannot disrupt running batch file ──
if /i not "%~dp0"=="%TEMP%\DeviceFarmSetup\" (
    if not exist "%TEMP%\DeviceFarmSetup" mkdir "%TEMP%\DeviceFarmSetup" >nul 2>&1
    copy /Y "%~f0" "%TEMP%\DeviceFarmSetup\setup.bat" >nul 2>&1
    set "CALLER_DIR=%~dp0"
    if "!CALLER_DIR:~-1!"=="\" set "CALLER_DIR=!CALLER_DIR:~0,-1!"
    call "%TEMP%\DeviceFarmSetup\setup.bat" %*
    exit /b !errorlevel!
)

title Flexpulse Agent — Setup

:: ═══════════════════════════════════════════════════════════════════════════
::  Flexpulse AGENT — ONE-CLICK INSTALLER
:: ═══════════════════════════════════════════════════════════════════════════

echo.
echo  ================================================================
echo   Flexpulse DESKTOP AGENT  ^|  One-Click Setup
echo  ================================================================
echo.

:: ── Where to install the agent ─────────────────────────────────────────────
set "INSTALL_DIR=C:\DeviceFarmAgent"
set "REPO_URL=https://github.com/sammysam254/flexpulse.git"
set "CURRENT_DIR=%~dp0"
if "%CURRENT_DIR:~-1%"=="\" set "CURRENT_DIR=%CURRENT_DIR:~0,-1%"

:: ── Full path to PowerShell (never rely on PATH for this) ──────────────────
set "PS=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
if not exist "%PS%" set "PS=%SystemRoot%\SysWOW64\WindowsPowerShell\v1.0\powershell.exe"

echo.
echo  ----------------------------------------------------------------
echo   Configuration:
echo  ----------------------------------------------------------------
echo   Install directory : %INSTALL_DIR%
echo   Source repository : %REPO_URL%
echo   Repository branch : main
echo  ----------------------------------------------------------------
echo.

:: ── Auto-close EVERYTHING before running (cloudflared, electron, scrcpy, adb, watchdog, port 7400, ports 8100-8900) ──
echo [*] Terminating all previous agent processes, legacy folders, tunnels, and releasing ports...
taskkill /F /IM cloudflared.exe /T >nul 2>&1
taskkill /F /IM electron.exe /T >nul 2>&1
taskkill /F /IM scrcpy.exe /T >nul 2>&1
taskkill /F /IM adb.exe /T >nul 2>&1
"%PS%" -NoProfile -ExecutionPolicy Bypass -Command ^
  "Get-NetTCPConnection -LocalPort 7400 -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object { try { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue } catch {} };" ^
  "Get-NetTCPConnection -ErrorAction SilentlyContinue | Where-Object { $_.LocalPort -ge 8100 -and $_.LocalPort -le 8900 } | Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object { try { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue } catch {} };" ^
  "Get-CimInstance Win32_Process | Where-Object { ($_.Name -like 'node*' -and $_.CommandLine -and ($_.CommandLine.IndexOf('service-watchdog.js') -ge 0 -or $_.CommandLine.IndexOf('DeviceFarm') -ge 0 -or $_.CommandLine.IndexOf('devicefarm-agent') -ge 0 -or $_.CommandLine.IndexOf('flexpulse') -ge 0 -or $_.CommandLine.IndexOf('diamt') -ge 0 -or $_.CommandLine.IndexOf('electron') -ge 0)) } | ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue } catch {} }" >nul 2>&1
ping 127.0.0.1 -n 3 >nul 2>&1



:: ════════════════════════════════════════════════════════════════════════════
:: STEP 1 — Git
:: ════════════════════════════════════════════════════════════════════════════
echo [1/6] Checking Git...
set "GIT="
for /f "delims=" %%I in ('where git 2^>nul') do if not defined GIT set "GIT=%%I"
if not defined GIT if exist "%ProgramFiles%\Git\cmd\git.exe"       set "GIT=%ProgramFiles%\Git\cmd\git.exe"
if not defined GIT if exist "%ProgramFiles(x86)%\Git\cmd\git.exe"  set "GIT=%ProgramFiles(x86)%\Git\cmd\git.exe"
if not defined GIT if exist "%LOCALAPPDATA%\Programs\Git\cmd\git.exe" set "GIT=%LOCALAPPDATA%\Programs\Git\cmd\git.exe"

if defined GIT (
    echo [OK] Git found: %GIT%
) else (
    echo [*] Git not found. Downloading Git for Windows...
    "%PS%" -NoProfile -ExecutionPolicy Bypass -Command ^
        "Invoke-WebRequest -Uri 'https://github.com/git-for-windows/git/releases/download/v2.45.2.windows.1/Git-2.45.2-64-bit.exe' -OutFile '%TEMP%\git_installer.exe' -UseBasicParsing"
    if not exist "%TEMP%\git_installer.exe" (
        echo [ERROR] Could not download Git. Check your internet connection.
        pause & exit /b 1
    )
    echo [*] Installing Git silently — please wait...
    start /wait "" "%TEMP%\git_installer.exe" /VERYSILENT /NORESTART /NOCANCEL /SP- /CLOSEAPPLICATIONS /RESTARTAPPLICATIONS /COMPONENTS="icons,ext\reg\shellhere,assoc,assoc_sh"
    del "%TEMP%\git_installer.exe" >nul 2>nul
    set "GIT=%ProgramFiles%\Git\cmd\git.exe"
    if not exist "!GIT!" (
        echo [ERROR] Git installation failed. Please install from https://git-scm.com
        pause & exit /b 1
    )
    echo [OK] Git installed: !GIT!
)

:: ════════════════════════════════════════════════════════════════════════════
:: STEP 1.5 — IMMEDIATE UPDATE: Pull latest code from GitHub FIRST
:: ════════════════════════════════════════════════════════════════════════════
echo.
echo  ================================================================
echo   PRIORITY: Ensuring latest code from GitHub...
echo  ================================================================
echo.

if exist "%INSTALL_DIR%\.git" (
    echo [*] Existing installation found at: %INSTALL_DIR%
    
    :: Kill any processes that might lock files
    taskkill /F /IM adb.exe /T >nul 2>&1
    taskkill /F /IM electron.exe /T >nul 2>&1
    taskkill /F /IM cloudflared.exe /T >nul 2>&1
    taskkill /F /IM node.exe /T >nul 2>&1
    ping 127.0.0.1 -n 2 >nul 2>&1
    
    :: Show current state
    for /f "delims=" %%R in ('"%GIT%" -C "%INSTALL_DIR%" remote get-url origin 2^>nul') do (
        echo [*] Current repository: %%R
    )
    for /f "delims=" %%B in ('"%GIT%" -C "%INSTALL_DIR%" rev-parse --abbrev-ref HEAD 2^>nul') do (
        echo [*] Current branch: %%B
    )
    for /f "delims=" %%C in ('"%GIT%" -C "%INSTALL_DIR%" rev-parse --short HEAD 2^>nul') do (
        echo [*] Current commit: %%C
    )
    
    :: Clear any stale git index locks
    if exist "%INSTALL_DIR%\.git\index.lock" del /F /Q "%INSTALL_DIR%\.git\index.lock" >nul 2>&1

    echo.
    echo [*] Enforcing repository: %REPO_URL%
    "%GIT%" -C "%INSTALL_DIR%" remote set-url origin "%REPO_URL%" 2>nul
    
    echo [*] Fetching latest from origin/main...
    "%GIT%" -C "%INSTALL_DIR%" fetch origin main --force 2>nul
    
    echo [*] Resetting to origin/main...
    "%GIT%" -C "%INSTALL_DIR%" reset --hard origin/main 2>nul
    "%GIT%" -C "%INSTALL_DIR%" clean -fd 2>nul

    if defined CALLER_DIR if exist "%CALLER_DIR%\.git" if /i not "%CALLER_DIR%"=="%INSTALL_DIR%" (
        if exist "%CALLER_DIR%\.git\index.lock" del /F /Q "%CALLER_DIR%\.git\index.lock" >nul 2>&1
        "%GIT%" -C "%CALLER_DIR%" fetch origin main --force 2>nul
        "%GIT%" -C "%CALLER_DIR%" reset --hard origin/main 2>nul
    )
    
    :: Show new state
    for /f "delims=" %%N in ('"%GIT%" -C "%INSTALL_DIR%" rev-parse --short HEAD 2^>nul') do (
        echo [OK] Updated to commit: %%N
    )
    
    echo [OK] Code synchronized with GitHub main branch
    echo.
) else (
    echo [*] No existing installation - will clone fresh
    echo.
)

:: ════════════════════════════════════════════════════════════════════════════
:: STEP 2 — Node.js
:: ════════════════════════════════════════════════════════════════════════════
echo.
echo [3/7] Checking Node.js...
set "NODE="
set "NPM="

if exist "%ProgramFiles%\nodejs\node.exe"          set "NODE=%ProgramFiles%\nodejs\node.exe"
if exist "%ProgramFiles%\nodejs\npm.cmd"           set "NPM=%ProgramFiles%\nodejs\npm.cmd"
if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODE=%LOCALAPPDATA%\Programs\nodejs\node.exe"
if exist "%LOCALAPPDATA%\Programs\nodejs\npm.cmd"  set "NPM=%LOCALAPPDATA%\Programs\nodejs\npm.cmd"
if not defined NODE for /f "delims=" %%I in ('where node 2^>nul') do if not defined NODE set "NODE=%%I"
if not defined NPM  for /f "delims=" %%I in ('where npm.cmd 2^>nul') do if not defined NPM  set "NPM=%%I"
if not defined NPM  for /f "delims=" %%I in ('where npm 2^>nul')     do if not defined NPM  set "NPM=%%I"

if defined NODE (
    echo [OK] Node.js found: %NODE%
) else (
    echo [*] Node.js not found. Downloading LTS installer...
    "%PS%" -NoProfile -ExecutionPolicy Bypass -Command ^
        "Invoke-WebRequest -Uri 'https://nodejs.org/dist/v20.11.1/node-v20.11.1-x64.msi' -OutFile '%TEMP%\node_installer.msi' -UseBasicParsing"
    if not exist "%TEMP%\node_installer.msi" (
        echo [ERROR] Node.js download failed. Check your internet connection.
        pause & exit /b 1
    )
    echo [*] Installing Node.js — please wait...
    start /wait msiexec /i "%TEMP%\node_installer.msi" /qn /norestart ADDLOCAL=ALL
    del "%TEMP%\node_installer.msi" >nul 2>nul
    set "NODE=%ProgramFiles%\nodejs\node.exe"
    set "NPM=%ProgramFiles%\nodejs\npm.cmd"
    if not exist "!NODE!" (
        echo [ERROR] Node.js installation failed. Install from https://nodejs.org
        pause & exit /b 1
    )
    echo [OK] Node.js installed: !NODE!
)
if not defined NPM for %%I in ("%NODE%") do set "NPM=%%~dpInpm.cmd"
echo [OK] npm  : %NPM%

:: ════════════════════════════════════════════════════════════════════════════
:: STEP 3 — ADB platform-tools
:: ════════════════════════════════════════════════════════════════════════════
echo.
echo [4/7] Checking ADB...
set "ADB="
if exist "%INSTALL_DIR%\assets\bin\adb.exe"  set "ADB=%INSTALL_DIR%\assets\bin\adb.exe"
if not defined ADB if exist "C:\platform-tools\adb.exe" set "ADB=C:\platform-tools\adb.exe"
if not defined ADB for /f "delims=" %%I in ('where adb 2^>nul') do if not defined ADB set "ADB=%%I"

if defined ADB (
    echo [OK] ADB found: %ADB%
) else (
    echo [*] ADB not found. Downloading Android SDK platform-tools...
    "%PS%" -NoProfile -ExecutionPolicy Bypass -Command ^
        "Invoke-WebRequest -Uri 'https://dl.google.com/android/repository/platform-tools-latest-windows.zip' -OutFile '%TEMP%\pt.zip' -UseBasicParsing"
    if exist "%TEMP%\pt.zip" (
        "%PS%" -NoProfile -ExecutionPolicy Bypass -Command ^
            "Expand-Archive -Path '%TEMP%\pt.zip' -DestinationPath 'C:\' -Force"
        del "%TEMP%\pt.zip" >nul 2>nul
    )
    if exist "C:\platform-tools\adb.exe" (
        set "ADB=C:\platform-tools\adb.exe"
        echo [OK] ADB installed: C:\platform-tools\adb.exe
    ) else (
        echo [WARN] ADB install failed — device detection may not work until ADB is available.
    )
)

:: ════════════════════════════════════════════════════════════════════════════
:: STEP 5 — Ensure agent directory exists and is correct
:: ════════════════════════════════════════════════════════════════════════════
echo.
echo [5/7] Verifying agent installation directory...

:: If no .git directory exists, clone fresh
if not exist "%INSTALL_DIR%\.git" (
    echo [*] Cloning fresh from GitHub...
    
    "%GIT%" clone --depth 1 --single-branch --branch main "%REPO_URL%" "%INSTALL_DIR%"
    if !errorlevel! neq 0 (
        echo [ERROR] git clone failed. Check your internet connection.
        pause & exit /b 1
    )
    echo [OK] Fresh installation cloned
)

:: Always verify and show final state
echo.
echo  ================================================================
echo   REPOSITORY STATUS
echo  ================================================================

:: Get repository info with proper variable capture
"%GIT%" -C "%INSTALL_DIR%" remote get-url origin > "%TEMP%\repo_url.txt" 2>nul
"%GIT%" -C "%INSTALL_DIR%" rev-parse --abbrev-ref HEAD > "%TEMP%\repo_branch.txt" 2>nul
"%GIT%" -C "%INSTALL_DIR%" rev-parse --short HEAD > "%TEMP%\repo_commit.txt" 2>nul

set "FINAL_REMOTE="
set "FINAL_BRANCH="
set "FINAL_COMMIT="

if exist "%TEMP%\repo_url.txt" (
    set /p FINAL_REMOTE=<"%TEMP%\repo_url.txt"
    del "%TEMP%\repo_url.txt" >nul 2>&1
)
if exist "%TEMP%\repo_branch.txt" (
    set /p FINAL_BRANCH=<"%TEMP%\repo_branch.txt"
    del "%TEMP%\repo_branch.txt" >nul 2>&1
)
if exist "%TEMP%\repo_commit.txt" (
    set /p FINAL_COMMIT=<"%TEMP%\repo_commit.txt"
    del "%TEMP%\repo_commit.txt" >nul 2>&1
)

echo   Remote URL     : !FINAL_REMOTE!
echo   Current Branch : !FINAL_BRANCH!
echo   Commit Hash    : !FINAL_COMMIT!
echo  ================================================================
echo.

:: Verify we got the information
if not defined FINAL_REMOTE (
    echo [ERROR] Could not read repository remote URL
    echo [*] This might be a git configuration issue
    echo [*] Install directory: %INSTALL_DIR%
    pause & exit /b 1
)

if not defined FINAL_COMMIT (
    echo [ERROR] Could not read repository commit
    echo [*] This might be a git configuration issue
    echo [*] Install directory: %INSTALL_DIR%
    pause & exit /b 1
)

echo [OK] ✓ Running from: %REPO_URL% (main @ !FINAL_COMMIT!)

:: Switch working directory to the install dir for all remaining steps
cd /d "%INSTALL_DIR%"
echo [OK] Working directory: %CD%

:: Clean up any wifi cache that might cause issues
if exist "%INSTALL_DIR%\wifi-devices-cache.json" del /F /Q "%INSTALL_DIR%\wifi-devices-cache.json" >nul 2>&1

:: ── Add Node.js directory to PATH so npm postinstall scripts can call node ──
for %%I in ("%NODE%") do set "NODE_DIR=%%~dpI"
set "PATH=%NODE_DIR%;%PATH%"
echo [OK] Node.js added to PATH: %NODE_DIR%

:: Patch config.json with correct binary paths
echo [*] Patching config.json with local binary paths...
"%NODE%" -e "const fs=require('fs'),p='config.json',cfg=fs.existsSync(p)?JSON.parse(fs.readFileSync(p)):{}; cfg.adbPath=require('path').join(process.cwd(),'assets','bin','adb.exe'); cfg.cloudflaredPath=require('path').join(process.cwd(),'assets','bin','cloudflared.exe'); fs.writeFileSync(p,JSON.stringify(cfg,null,2));"
echo [OK] config.json updated.

:: ════════════════════════════════════════════════════════════════════════════
:: STEP 6 — npm install + Electron binary + scrcpy-server.jar
:: ════════════════════════════════════════════════════════════════════════════
echo.
echo [6/7] Installing dependencies...

if exist "node_modules\winston\package.json" (
    echo [OK] npm dependencies already installed.
) else (
    echo [*] Running npm install — this may take a few minutes...
    call "%NPM%" install --no-audit --no-fund
    if !errorlevel! neq 0 (
        echo [ERROR] npm install failed. Check your internet connection and try again.
        pause & exit /b 1
    )
    echo [OK] npm packages installed.
)

:: Download scrcpy-server.jar if missing
if not exist "scrcpy-server.jar" (
    echo [*] Downloading scrcpy-server.jar...
    "%PS%" -NoProfile -ExecutionPolicy Bypass -Command ^
        "Invoke-WebRequest -Uri 'https://github.com/Genymobile/scrcpy/releases/download/v2.4/scrcpy-server-v2.4' -OutFile 'scrcpy-server.jar' -UseBasicParsing"
    if exist "scrcpy-server.jar" (
        echo [OK] scrcpy-server.jar ready.
    ) else (
        echo [WARN] scrcpy-server.jar missing — streaming may fail!
    )
) else (
    echo [OK] scrcpy-server.jar already present.
)

:: Download Electron binary if missing
if not exist "node_modules\electron\dist\electron.exe" (
    echo [*] Downloading Electron v33.4.11...
    if not exist "node_modules\electron\dist" mkdir "node_modules\electron\dist" >nul 2>nul
    "%PS%" -NoProfile -ExecutionPolicy Bypass -Command ^
        "Invoke-WebRequest -Uri 'https://github.com/electron/electron/releases/download/v33.4.11/electron-v33.4.11-win32-x64.zip' -OutFile 'node_modules\electron\ez.zip' -UseBasicParsing"
    if exist "node_modules\electron\ez.zip" (
        "%PS%" -NoProfile -ExecutionPolicy Bypass -Command ^
            "Expand-Archive -Path 'node_modules\electron\ez.zip' -DestinationPath 'node_modules\electron\dist' -Force"
        del "node_modules\electron\ez.zip" >nul 2>nul
        echo electron.exe> "node_modules\electron\path.txt"
    )
    if exist "node_modules\electron\dist\electron.exe" (
        echo [OK] Electron binary ready.
    ) else (
        echo [WARN] Electron binary not found — launch may fail.
    )
) else (
    echo [OK] Electron binary already present.
)

:: ════════════════════════════════════════════════════════════════════════════
:: STEP 6 — Payment verification + Launch
:: ════════════════════════════════════════════════════════════════════════════
echo.
echo  ================================================================
echo   STEP 7: Flexpulse AUTONOMOUS SYSTEM INITIALIZATION
echo  ================================================================
echo.
echo [*] Identifying system and establishing autonomous cloud sync...
"%NODE%" "src\services\verify-payment.js"

:: ── Terminate any existing agent process on port 7400 to apply new code ──
echo [*] Stopping running agent instances to reload latest code...
"%PS%" -NoProfile -ExecutionPolicy Bypass -Command ^
  "Get-NetTCPConnection -LocalPort 7400 -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object { try { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue } catch {} }"
"%PS%" -NoProfile -ExecutionPolicy Bypass -Command ^
  "Stop-Process -Name 'electron','scrcpy' -Force -ErrorAction SilentlyContinue"
ping 127.0.0.1 -n 2 >nul 2>nul


echo.
echo  ================================================================
echo   STEP 2: CHECKING CONNECTED ANDROID DEVICES
echo  ================================================================
echo.

set "ADB_BIN=%INSTALL_DIR%\assets\bin\adb.exe"
if not exist "%ADB_BIN%" set "ADB_BIN=adb"

:: Restart ADB server with bundled binary
echo [*] Refreshing ADB server...
"%ADB_BIN%" start-server >nul 2>&1

:: Refresh USB connected ADB devices
echo [*] USB Debugging mode: Refreshing physically connected hardware devices...
"%ADB_BIN%" reconnect >nul 2>&1
ping 127.0.0.1 -n 2 >nul

echo [*] Connected ADB Devices:
"%ADB_BIN%" devices -l

echo.
echo  ================================================================
echo   STEP 3: LAUNCHING DEVICEFARM AGENT AND DASHBOARD
echo  ================================================================
echo.

:: ── Stop any existing DeviceFarm Agent processes safely ───────────────────
echo [*] Ensuring clean process state...
"%PS%" -NoProfile -ExecutionPolicy Bypass -Command ^
  "$dirs = @('%INSTALL_DIR%', '%CURRENT_DIR%') | Where-Object { $_ -and (Test-Path $_) };" ^
  "Get-CimInstance Win32_Process | Where-Object {" ^
  "  $p = $_; if ($p.ProcessId -eq $PID) { return $false };" ^
  "  $matchDir = $false;" ^
  "  foreach ($d in $dirs) { if (($p.ExecutablePath -and $p.ExecutablePath.StartsWith($d, [System.StringComparison]::OrdinalIgnoreCase)) -or ($p.CommandLine -and $p.CommandLine.IndexOf($d, [System.StringComparison]::OrdinalIgnoreCase) -ge 0)) { $matchDir = $true; break } };" ^
  "  $isWatchdog = ($p.Name -like 'node*' -and $p.CommandLine -and ($p.CommandLine.IndexOf('service-watchdog.js', [System.StringComparison]::OrdinalIgnoreCase) -ge 0 -or $p.CommandLine.IndexOf('DeviceFarm', [System.StringComparison]::OrdinalIgnoreCase) -ge 0));" ^
  "  return (($matchDir -or $isWatchdog) -and ($p.Name -match '^(electron|node|cloudflared|scrcpy|adb|DeviceFarm Agent)\.exe$'))" ^
  "} | ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue } catch {} }"
ping 127.0.0.1 -n 2 >nul 2>nul
echo [OK] Process state clean.

:: ── Register and launch 24/7 Silent Background Service ──────────────────
echo [*] Configuring and registering Windows 24/7 Background Service...

set "TASK_BOOT=DeviceFarm_Agent_BootService"
set "TASK_LOGON=DeviceFarm_Agent_LogonService"
set "VBS_LAUNCHER=%INSTALL_DIR%\Start-Agent-Silent.vbs"
set "STARTUP_ALL=%ProgramData%\Microsoft\Windows\Start Menu\Programs\Startup"
set "LNK_ALL=%STARTUP_ALL%\DeviceFarm-Agent-Service.lnk"

:: Remove old conflicting tasks safely
schtasks /delete /tn "DeviceFarm Agent AutoStart" /f >nul 2>&1
schtasks /delete /tn "DeviceFarm_Agent_BootService" /f >nul 2>&1
schtasks /delete /tn "DeviceFarm_Agent_LogonService" /f >nul 2>&1

:: Register Boot Task (starts when PC turns on / restarts)
schtasks /create /tn "%TASK_BOOT%" /tr "wscript.exe \"%VBS_LAUNCHER%\"" /sc ONSTART /ru "SYSTEM" /rl HIGHEST /f >nul 2>&1

:: Register Logon Task (starts when user logs in)
schtasks /create /tn "%TASK_LOGON%" /tr "wscript.exe \"%VBS_LAUNCHER%\"" /sc ONLOGON /rl HIGHEST /f >nul 2>&1

:: Redundant All-Users Startup Shortcut
"%PS%" -NoProfile -ExecutionPolicy Bypass -Command ^
    "try { $ws = New-Object -ComObject WScript.Shell; $s = $ws.CreateShortcut('%LNK_ALL%'); $s.TargetPath = 'wscript.exe'; $s.Arguments = '\"%VBS_LAUNCHER%\"'; $s.WorkingDirectory = '%INSTALL_DIR%'; $s.WindowStyle = 0; $s.Description = 'DeviceFarm Agent Autonomous Background Service'; $s.Save() } catch {}" >nul 2>&1

echo [OK] Windows 24/7 background service registered.

:: Stop any existing cloudflared tunnel processes
taskkill /F /IM cloudflared.exe /T >nul 2>&1
ping 127.0.0.1 -n 2 >nul 2>nul

:: Start agent directly via watchdog in background
echo [*] Starting DeviceFarm Agent service in the background...
"%PS%" -NoProfile -ExecutionPolicy Bypass -Command ^
    "Start-Process -FilePath '%NODE%' -ArgumentList 'src\main\service-watchdog.js' -WorkingDirectory '%INSTALL_DIR%' -WindowStyle Hidden"

:: Cloudflare Tunnel Daemon (if configured in config.json)
set "CLOUDFLARED_EXE=%INSTALL_DIR%\assets\bin\cloudflared.exe"
if not exist "%CLOUDFLARED_EXE%" set "CLOUDFLARED_EXE=%CURRENT_DIR%\assets\bin\cloudflared.exe"
if not exist "%CLOUDFLARED_EXE%" set "CLOUDFLARED_EXE=C:\cloudflared\cloudflared.exe"
if not exist "%CLOUDFLARED_EXE%" set "CLOUDFLARED_EXE=C:\Program Files\cloudflared\cloudflared.exe"
if not exist "%CLOUDFLARED_EXE%" set "CLOUDFLARED_EXE=C:\Program Files (x86)\cloudflared\cloudflared.exe"

:: Wait for Dashboard to become responsive
echo [*] Waiting for Dashboard to start on http://localhost:7400...
"%PS%" -NoProfile -ExecutionPolicy Bypass -Command ^
    "$ok = $false; for ($i = 0; $i -lt 12; $i++) { try { $r = Invoke-WebRequest -Uri 'http://127.0.0.1:7400/api/license/status' -UseBasicParsing -TimeoutSec 2; if ($r.StatusCode -eq 200) { $ok = $true; break } } catch {}; Start-Sleep -Seconds 1 }; if ($ok) { Write-Host '[OK] Dashboard is live and ready!' } else { Write-Host '[*] Dashboard is launching in the background...' }"

start "" "http://localhost:7400"

:end_launch

echo.
echo  ================================================================
echo  [OK] Flexpulse Agent is running continuously in the background!
echo       Dashboard  : http://localhost:7400
echo       Update Mode: Manual (Streams 100% Persistent 24/7, No Auto-Restarts)
echo       Install    : %INSTALL_DIR%
echo       Status     : Active 24/7 Background Service (Auto-starts on Boot)
echo  ================================================================
echo.
echo  Opening dashboard automatically in your browser...
echo  (Window will close in 5 seconds)
ping 127.0.0.1 -n 6 >nul 2>nul
exit /b 0

