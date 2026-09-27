'use strict';

/**
 * DeviceFarm Agent — Device Keep-Alive & Anti-Sleep Service
 * ────────────────────────────────────────────────────────
 * Ensures all connected Android devices:
 * 1. Stay continuously awake with display active (no Doze/Deep Sleep).
 * 2. Configure Android system settings (stay_on_while_plugged_in, screen_off_timeout, svc power stayon).
 * 3. Receive periodic non-intrusive KEYCODE_WAKEUP (keyevent 224) pulses so ADB connection never drops.
 * 4. Automatically re-bind and recover any device transitioning to 'offline' state.
 * 5. Disables host-level Windows USB selective suspend so USB ports never lose power.
 */

const { exec } = require('child_process');
const path = require('path');
const fs = require('fs');
const logger = require('../utils/logger');

function loadConfig() {
  for (const p of [
    path.join(process.cwd(), 'config.json'),
    path.join(__dirname, '..', '..', 'config.json'),
  ]) {
    if (fs.existsSync(p)) {
      try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch (_) {}
    }
  }
  return {};
}

function resolveAdb() {
  const cfg = loadConfig();
  if (cfg.adbPath && fs.existsSync(cfg.adbPath)) return cfg.adbPath;
  const bundled = path.join(__dirname, '../../assets/bin/adb.exe');
  if (fs.existsSync(bundled)) return bundled;
  if (fs.existsSync('C:\\platform-tools\\adb.exe')) return 'C:\\platform-tools\\adb.exe';
  return 'adb';
}

/**
 * Configure Android device to NEVER sleep while powered/plugged in.
 */
async function configureDeviceAntiSleep(serial) {
  if (!serial) return;
  const adbBin = resolveAdb();
  const cmds = [
    // 7 = 1 (AC) | 2 (USB) | 4 (Wireless) -> Stay awake on any power source
    `"${adbBin}" -s ${serial} shell settings put global stay_on_while_plugged_in 7`,
    // Max screen timeout (~24.8 days)
    `"${adbBin}" -s ${serial} shell settings put system screen_off_timeout 2147483647`,
    // System command to prevent power down / sleep
    `"${adbBin}" -s ${serial} shell svc power stayon true`,
    // Wake up screen if dimmed or off (keyevent 224: KEYCODE_WAKEUP)
    `"${adbBin}" -s ${serial} shell input keyevent 224`
  ];

  for (const cmd of cmds) {
    await new Promise(resolve => {
      exec(cmd, { timeout: 4000 }, () => resolve());
    });
  }
}

/**
 * Send non-intrusive wake signal to ensure display remains awake and active.
 * Keyevent 224 (KEYCODE_WAKEUP) wakes the screen if it was off, but does NOT toggle it off if already on.
 */
async function sendDeviceWakePulse(serial) {
  if (!serial) return;
  const adbBin = resolveAdb();
  return new Promise(resolve => {
    exec(`"${adbBin}" -s ${serial} shell input keyevent 224`, { timeout: 3000 }, () => resolve());
  });
}

/**
 * Prevent Windows OS from putting USB host controllers and USB hubs into selective suspend.
 */
function optimizeHostUsbPower() {
  if (process.platform !== 'win32') return;
  try {
    // Disable USB selective suspend on AC power
    exec('powercfg /SETACVALUEINDEX SCHEME_CURRENT 2a737441-1930-4402-8d77-b2bebba4d5a0 48e6b7a6-50f5-4766-9147-73854d08bb2d 0', { timeout: 3000 }, () => {});
    // Disable USB selective suspend on DC (battery) power
    exec('powercfg /SETDCVALUEINDEX SCHEME_CURRENT 2a737441-1930-4402-8d77-b2bebba4d5a0 48e6b7a6-50f5-4766-9147-73854d08bb2d 0', { timeout: 3000 }, () => {});
    // Activate power scheme
    exec('powercfg /SETACTIVE SCHEME_CURRENT', { timeout: 3000 }, () => {});
    logger.info('[KeepAlive] Host USB selective suspend disabled for 24/7 continuous operation');
  } catch (_) {}
}

let keepAliveTimer = null;

function startKeepAliveService(intervalMs = 15000) {
  optimizeHostUsbPower();

  if (keepAliveTimer) clearInterval(keepAliveTimer);

  keepAliveTimer = setInterval(async () => {
    try {
      const adbBin = resolveAdb();

      // Check ADB device states, auto-reconnect any that show as 'offline'
      exec(`"${adbBin}" devices`, { timeout: 5000 }, async (err, stdout) => {
        if (err || !stdout) return;
        const lines = stdout.split('\n').slice(1);
        for (const line of lines) {
          const parts = line.trim().split(/\s+/);
          if (parts.length >= 2) {
            const [serial, state] = parts;
            if (state === 'offline') {
              logger.warn(`[KeepAlive] Device ${serial} is in offline state — triggering auto-reconnect`);
              exec(`"${adbBin}" -s ${serial} reconnect`, { timeout: 4000 }, () => {});
            } else if (state === 'device') {
              // Send wake pulse to ensure device never sleeps
              sendDeviceWakePulse(serial);
            }
          }
        }
      });
    } catch (e) {
      logger.warn(`[KeepAlive] Pulse error: ${e.message}`);
    }
  }, intervalMs);

  logger.info(`[KeepAlive] Persistent device keep-alive active (wake pulses every ${Math.round(intervalMs / 1000)}s)`);
}

function stopKeepAliveService() {
  if (keepAliveTimer) {
    clearInterval(keepAliveTimer);
    keepAliveTimer = null;
  }
}

module.exports = {
  configureDeviceAntiSleep,
  sendDeviceWakePulse,
  startKeepAliveService,
  stopKeepAliveService,
};
