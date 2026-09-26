'use strict';

/**
 * DeviceFarm Agent — Autonomous Background Service Watchdog
 *
 * Supervises the DeviceFarm Agent process. If the agent crashes, is closed,
 * or terminates unexpectedly, the watchdog automatically relaunches it
 * after a 3-second delay, ensuring 24/7 continuous unattended operation.
 */

const path = require('path');
const fs = require('fs');
const { spawn, execSync } = require('child_process');

const rootDir = path.resolve(__dirname, '..', '..');
let activeChild = null;
let restartCount = 0;
let isStopping = false;

function preLaunchCleanup() {
  try {
    // 1. Permanently remove any legacy cache file if created
    const wifiCache = path.join(rootDir, 'wifi-devices-cache.json');
    if (fs.existsSync(wifiCache)) {
      try { fs.unlinkSync(wifiCache); } catch (_) {}
    }

    // 2. Terminate any orphaned electron or cloudflared instances from prior crashes/folders
    if (process.platform === 'win32') {
      try {
        execSync('taskkill /F /IM electron.exe >nul 2>&1', { timeout: 3000, stdio: 'ignore' });
        execSync('taskkill /F /IM cloudflared.exe >nul 2>&1', { timeout: 3000, stdio: 'ignore' });
      } catch (_) {}
    }

    // 3. Terminate any zombie scrcpy servers on connected Android devices
    try {
      const adbBin = fs.existsSync('C:\\platform-tools\\adb.exe') ? 'C:\\platform-tools\\adb.exe' : (fs.existsSync(path.join(rootDir, 'assets', 'bin', 'adb.exe')) ? path.join(rootDir, 'assets', 'bin', 'adb.exe') : 'adb');
      execSync(`"${adbBin}" shell pkill -9 -f com.genymobile.scrcpy >nul 2>&1`, { timeout: 4000, stdio: 'ignore' });
      // Disconnect all wireless ADB sessions to ensure strict USB-only operation
      execSync(`"${adbBin}" disconnect >nul 2>&1`, { timeout: 4000, stdio: 'ignore' });
    } catch (_) {}
  } catch (_) {}
}

function getElectronPath() {
  const localElectron = path.join(rootDir, 'node_modules', 'electron', 'dist', 'electron.exe');
  if (fs.existsSync(localElectron)) {
    return localElectron;
  }
  return 'electron';
}

function startAgent() {
  if (isStopping) return;

  preLaunchCleanup();

  const electronExe = getElectronPath();
  const mainScript = path.join(rootDir, 'src', 'main', 'index.js');

  const args = [mainScript, '--hidden'];

  try {
    activeChild = spawn(electronExe, args, {
      cwd: rootDir,
      windowsHide: true,
      stdio: 'ignore',
      detached: false,
      env: { ...process.env, BACKGROUND_SERVICE: '1' }
    });

    activeChild.on('error', (err) => {
      // Avoid crash on spawn error, retry after delay
      scheduleRestart();
    });

    activeChild.on('exit', (code, signal) => {
      activeChild = null;
      if (!isStopping) {
        scheduleRestart();
      }
    });
  } catch (err) {
    scheduleRestart();
  }
}

function scheduleRestart() {
  if (isStopping) return;
  restartCount++;
  // Exponential backoff up to 10 seconds if restarting rapidly
  const delay = Math.min(3000 + (restartCount > 5 ? 7000 : 0), 10000);
  setTimeout(() => {
    startAgent();
  }, delay);
}

// Handle termination signals cleanly
process.on('SIGINT', () => {
  isStopping = true;
  if (activeChild) {
    try { activeChild.kill(); } catch (_) {}
  }
  process.exit(0);
});

process.on('SIGTERM', () => {
  isStopping = true;
  if (activeChild) {
    try { activeChild.kill(); } catch (_) {}
  }
  process.exit(0);
});

// Start the initial supervised agent process
startAgent();
