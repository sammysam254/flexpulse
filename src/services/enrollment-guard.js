'use strict';

/**
 * DeviceFarm Auto-Enrollment & Reboot Recovery Service
 * ─────────────────────────────────────────────────────
 * Background process that:
 * 1. Proactively scans LAN & reconnects known farm WiFi endpoints (10.1.10.x:5555)
 * 2. Polls ADB every 10 seconds for any newly connected / rebooted devices
 * 3. Cross-checks with active processManager sessions
 * 4. Auto re-provisions any device found in ADB that is NOT actively streamed
 * 5. Safely cleans up stale processManager entries without killing WiFi aliases
 * 6. Tracks and reports unauthorized / offline devices for dashboard diagnostics
 */

const { exec } = require('child_process');
const path = require('path');
const fs = require('fs');
const logger = require('../utils/logger');
const processManager = require('../main/process-manager');
const networkDeviceScanner = require('./network-device-scanner');

// Known farm aliases to avoid false stale cleanups
const FARM_SERIAL_ALIASES = {
  '7070016025067254': ['10.1.10.49:5555', '10.1.10.49'],
  'ZA223HQMXQ': ['10.1.10.79:5555', '10.1.10.79'],
  'YTCY999TVKVCZDZX': ['10.1.10.197:5555', '10.1.10.197'],
  '1120308025024495': ['10.1.10.100:5555', '10.1.10.100'],
  'M769UCQCDMZLPF8D': ['10.1.10.173:5555', '10.1.10.173'],
  '10.1.10.49:5555': ['7070016025067254'],
  '10.1.10.79:5555': ['ZA223HQMXQ'],
  '10.1.10.197:5555': ['YTCY999TVKVCZDZX'],
  '10.1.10.100:5555': ['1120308025024495'],
  '10.1.10.173:5555': ['M769UCQCDMZLPF8D'],
};

// ─── Config ──────────────────────────────────────────────────────────────────

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

// ─── Device State Store ───────────────────────────────────────────────────────

const unauthorizedDevices = new Set();
const offlineDevices = new Set();
let lastNetScanTime = 0;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function listAdbDevices(adbBin) {
  return new Promise((resolve) => {
    exec(`"${adbBin}" devices`, { timeout: 7000 }, (err, stdout, stderr) => {
      const out = ((stdout || '') + ' ' + (stderr || '')).toLowerCase();
      // If ADB daemon cannot connect, hangs, or crashes, auto-heal immediately
      if (err && (out.includes('cannot connect to daemon') || out.includes('could not read ok') || err.killed || out.includes('failed to start daemon'))) {
        logger.warn('[EnrollmentGuard] ADB daemon unresponsive or in bad state. Auto-restarting ADB daemon...');
        try {
          if (process.platform === 'win32') {
            const { execSync } = require('child_process');
            try { execSync('taskkill /F /IM adb.exe >nul 2>&1', { timeout: 3000, stdio: 'ignore' }); } catch (_) {}
            try { execSync(`"${adbBin}" start-server >nul 2>&1`, { timeout: 5000, stdio: 'ignore' }); } catch (_) {}
          }
        } catch (_) {}
        resolve([]);
        return;
      }
      if (err) { resolve([]); return; }

      const lines = (stdout || '').split('\n').slice(1);
      const serials = [];
      const currentUnauthorized = new Set();
      const currentOffline = new Set();

      for (const line of lines) {
        const parts = line.trim().split(/\s+/);
        if (parts.length >= 2) {
          const serial = parts[0];
          const state = parts[1];
          if (state === 'device') {
            serials.push(serial);
          } else if (state === 'unauthorized') {
            currentUnauthorized.add(serial);
            logger.warn(`[EnrollmentGuard] Device ${serial} is UNAUTHORIZED — prompt user to tap 'Allow USB debugging' on phone screen`);
          } else if (state === 'offline') {
            currentOffline.add(serial);
            try {
              exec(`"${adbBin}" -s ${serial} reconnect`, { timeout: 3000 }, () => {});
            } catch (_) {}
          }
        }
      }

      unauthorizedDevices.clear();
      for (const u of currentUnauthorized) unauthorizedDevices.add(u);

      offlineDevices.clear();
      for (const o of currentOffline) offlineDevices.add(o);

      if (currentOffline.size > 0) {
        try {
          exec(`"${adbBin}" reconnect offline`, { timeout: 3000 }, () => {});
        } catch (_) {}
      }

      resolve(serials);
    });
  });
}

// ─── Main Loop ────────────────────────────────────────────────────────────────

let _addDeviceCallback = null;
let _removeDeviceCallback = null;
let _intervalTimer = null;
const _inProgress = new Set();

/**
 * Start the recovery polling loop.
 * @param {Function} onDeviceAdd    – same handler as adb-tracker's handleDeviceAdd
 * @param {Function} onDeviceRemove – same handler as adb-tracker's handleDeviceRemove
 * @param {number} intervalMs      – polling interval, default 12000ms
 */
function startEnrollmentGuard(onDeviceAdd, onDeviceRemove, intervalMs = 12000) {
  _addDeviceCallback = onDeviceAdd;
  _removeDeviceCallback = onDeviceRemove;

  if (_intervalTimer) clearInterval(_intervalTimer);

  logger.info('[EnrollmentGuard] Auto-enrollment recovery & network scanner service started');

  // Trigger immediate initial network scan and device check
  runRecoveryCheck(true).catch(e => logger.warn(`[EnrollmentGuard] Initial check notice: ${e.message}`));

  _intervalTimer = setInterval(async () => {
    try {
      await runRecoveryCheck();
    } catch (err) {
      logger.warn(`[EnrollmentGuard] Recovery check error: ${err.message}`);
    }
  }, intervalMs);
}

async function runRecoveryCheck(force = false) {
  const adbBin = resolveAdb();

  // Periodically (or on force) scan LAN & connect known farm WiFi endpoints
  const now = Date.now();
  if (force || now - lastNetScanTime > 30000) {
    lastNetScanTime = now;
    try {
      await networkDeviceScanner.scanAndConnectAll();
    } catch (netErr) {
      logger.warn(`[EnrollmentGuard] Network auto-connect notice: ${netErr.message}`);
    }
  }

  const rawSerials = await listAdbDevices(adbBin);
  const adbSerials = rawSerials;
  const activeSerials = new Set(processManager.getActiveSerials());

  // ── 1. Re-enroll physical and network devices seen by ADB but not actively streaming ──
  for (const serial of adbSerials) {
    if (activeSerials.has(serial) || processManager.getDevice(serial)) continue; // Already streaming or tracked ✓
    if (_inProgress.has(serial)) continue;                                      // Already being provisioned ✓

    logger.info(`[EnrollmentGuard] Re-enrolling device: ${serial}`);
    _inProgress.add(serial);

    try {
      if (_addDeviceCallback) {
        await _addDeviceCallback({ id: serial, type: 'device' });
      }
    } catch (err) {
      logger.warn(`[EnrollmentGuard] Re-enrollment failed for ${serial}: ${err.message}`);
    } finally {
      _inProgress.delete(serial);
    }
  }

  // ── 2. Clean up stale processManager entries for vanished devices ─
  // CRITICAL FIX: Only clean up if NEITHER serial, NOR adbSerial, NOR hardwareSerial is in ADB!
  for (const serial of activeSerials) {
    const dev = processManager.getDevice(serial);
    if (!dev) continue;

    // Direct match
    if (adbSerials.includes(serial)) continue;

    // Check if underlying ADB transport (e.g. 10.1.10.x:5555) is alive
    if (dev.adbSerial && adbSerials.includes(dev.adbSerial)) continue;

    // Check if underlying physical hardware serial is alive
    if (dev.hardwareSerial && adbSerials.includes(dev.hardwareSerial)) continue;

    // Check known farm aliases
    const aliases = (dev.hardwareSerial ? FARM_SERIAL_ALIASES[dev.hardwareSerial] : null) || FARM_SERIAL_ALIASES[serial] || [];
    if (aliases.some(a => adbSerials.includes(a))) continue;

    logger.info(`[EnrollmentGuard] Stale session detected for ${serial} (not in ADB) — cleaning up`);
    try {
      if (_removeDeviceCallback) {
        await _removeDeviceCallback({ id: serial });
      } else {
        processManager.killDeviceProcesses(serial);
      }
    } catch (err) {
      logger.warn(`[EnrollmentGuard] Cleanup error for ${serial}: ${err.message}`);
    }
  }
}

function stopEnrollmentGuard() {
  if (_intervalTimer) {
    clearInterval(_intervalTimer);
    _intervalTimer = null;
    logger.info('[EnrollmentGuard] Auto-enrollment recovery service stopped');
  }
}

function getDeviceDiagnostics() {
  return {
    unauthorized: Array.from(unauthorizedDevices),
    offline: Array.from(offlineDevices),
    inProgress: Array.from(_inProgress),
  };
}

module.exports = {
  startEnrollmentGuard,
  stopEnrollmentGuard,
  runRecoveryCheck,
  getDeviceDiagnostics,
};
