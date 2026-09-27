'use strict';

const adb = require('@devicefarmer/adbkit');
const Adb = adb.Adb || adb.default || adb;
const logger = require('../utils/logger');
const { getFreePort } = require('../utils/port-finder');
const { startStreamServer, buildStreamUrl } = require('./stream-service');
const { createTunnel } = require('./tunnel-service');
const apiClient = require('./api-client');
const processManager = require('../main/process-manager');
const bindingService = require('./binding-service');
const licenseService = require('./license-service');
const enrollmentGuard = require('./enrollment-guard');
const stealthService = require('./stealth-service');
const deviceKeepAlive = require('./device-keepalive');
const path = require('path');
const fs = require('fs');

// ─── Config ──────────────────────────────────────────────────────────────────

function loadConfig() {
  const candidates = [
    path.join(process.cwd(), 'config.json'),
    path.join(__dirname, '..', '..', 'config.json'),
  ];
  for (const p of candidates) {
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

const config = loadConfig();
const PORT_RANGE_START = config.portRangeStart || 8100;
const PORT_RANGE_END   = config.portRangeEnd   || 8900;

let client  = null;
let tracker = null;

const recentRemovals = new Map();
const pendingOfflineTimers = new Map();
const DEBOUNCE_MS = 3000;
const OFFLINE_DEBOUNCE_MS = 15000;

// ─── Device Add ───────────────────────────────────────────────────────────────

async function handleDeviceAdd(device) {
  const serial = device.id;
  const isUsb = !serial.includes(':');

  if (pendingOfflineTimers.has(serial)) {
    clearTimeout(pendingOfflineTimers.get(serial));
    pendingOfflineTimers.delete(serial);
    logger.info(`Device ${serial} re-established connection during debounce — keeping stream active`);
  }

  const existingSession = processManager.getDevice(serial);
  if (existingSession && existingSession.port) {
    if (isUsb && (existingSession.isWifi || existingSession.adbSerial?.includes(':'))) {
      logger.info(`Upgrading device ${serial} from WiFi to high-speed USB priority`);
      await handleDeviceRemove({ id: existingSession.adbSerial || serial });
    } else {
      logger.info(`Device ${serial} already active on port ${existingSession.port} — preserving running stream`);
      return;
    }
  }

  const lastRemoval = recentRemovals.get(serial);
  if (lastRemoval && Date.now() - lastRemoval < DEBOUNCE_MS) {
    const waitTime = DEBOUNCE_MS - (Date.now() - lastRemoval);
    logger.info(`Debouncing reconnection for ${serial}, waiting ${waitTime}ms`);
    await new Promise(r => setTimeout(r, waitTime));
  }

  logger.info(`Device connected: ${serial} (type: ${device.type}, connection: ${isUsb ? 'USB' : 'Network/WiFi'})`);

  // Apply bootloader hiding & anti-detection stealth config before running apps
  try {
    const axios = require('axios');
    let isStealthOn = true;
    try {
      let cfg = {};
      try {
        const fs = require('fs');
        const path = require('path');
        const cfgPath = path.join(process.cwd(), 'config.json');
        if (fs.existsSync(cfgPath)) cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
      } catch (_) {}
      const supabaseUrl = process.env.SUPABASE_URL || cfg.supabaseUrl || '';
      const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || cfg.supabaseServiceRoleKey || cfg.supabaseAnonKey || '';
      if (supabaseUrl && supabaseKey) {
        const res = await axios.get(`${supabaseUrl}/rest/v1/device_rentals?serial_number=eq.${encodeURIComponent(serial)}&select=stealth_root_enabled`, {
          headers: { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` },
          timeout: 3000
        });
        if (res.data && res.data.length > 0 && res.data[0].stealth_root_enabled === false) {
          isStealthOn = false;
        }
      }
    } catch (_) {}

    await stealthService.applyDeviceStealth(serial, isStealthOn);
  } catch (stealthErr) {
    logger.warn(`Stealth setup notice for ${serial}: ${stealthErr.message}`);
  }

  try {
    // 1. Read device properties
    let deviceModel = 'Android';
    let deviceBrand  = 'Generic';

    let realSerial = serial;
    try {
      const deviceClient = client.getDevice(serial);
      const props = await deviceClient.getProperties();
      deviceModel = props['ro.product.model'] || deviceModel;
      deviceBrand  = props['ro.product.brand']  || deviceBrand;
      realSerial = props['ro.serialno'] || serial;
      if (realSerial === serial && serial.includes(':')) {
        const ip = serial.split(':')[0];
        const IP_MAP = {
          '10.1.10.49': '7070016025067254',
          '10.1.10.79': 'ZA223HQMXQ',
          '10.1.10.197': 'YTCY999TVKVCZDZX',
          '10.1.10.100': '1120308025024495',
          '10.1.10.173': 'M769UCQCDMZLPF8D',
        };
        if (IP_MAP[ip]) realSerial = IP_MAP[ip];
      }
      logger.info(`Device properties: ${serial} → ${deviceBrand} ${deviceModel} (real: ${realSerial})`);
    } catch (err) {
      logger.warn(`Could not read properties for ${serial}: ${err.message}`);
    }

    // If this is a WiFi connection for a device already streaming via USB, alias and disconnect duplicate ADB WiFi
    if (serial !== realSerial && processManager.getDevice(realSerial)) {
      logger.info(`Device ${realSerial} already active over USB — aliasing WiFi session ${serial} and disconnecting duplicate ADB WiFi`);
      const existing = processManager.getDevice(realSerial);
      processManager.addDevice(serial, existing);
      try {
        const adbBin = resolveAdb();
        const { exec } = require('child_process');
        exec(`"${adbBin}" disconnect ${serial}`, { timeout: 3000 }, () => {});
      } catch (_) {}
      return;
    }

    // 2. Machine binding sync (informative only — all devices stream immediately)
    const bindingCode = await bindingService.syncMachineBinding().catch(() => '10000000');
    logger.info(`[DeviceAgent] Device ${serial} linked to cloud dashboard under binding ${bindingCode}`);

    // 3. Allocate port
    const port = await getFreePort(PORT_RANGE_START, PORT_RANGE_END);
    logger.info(`Allocated port ${port} for device ${serial}`);

    // 4. Start stream server (always starts instantly — no license lockout)
    const { streamProcess, localUrl } = await startStreamServer(serial, port);
    logger.info(`Stream server started for ${serial}: ${localUrl}`);

    // 5. Establish fast Cloudflare tunnel or local stream URL
    let publicUrl = `http://localhost:${port}`;
    let tunnelProcess = null;

    try {
      const activeCfg = loadConfig();
      const rawCustomDomain = activeCfg.domain || activeCfg.customDomain || '';
      let cleanCustomDomain = (rawCustomDomain && !rawCustomDomain.includes('localhost') && !rawCustomDomain.includes('127.0.0.1'))
        ? rawCustomDomain.replace(/^https?:\/\//, '').replace(/\/+$/, '')
        : '';

      const tunnel = await createTunnel(port);
      if (tunnel && tunnel.publicUrl) {
        tunnelProcess = tunnel.tunnelProcess;
        publicUrl = cleanCustomDomain ? `https://${cleanCustomDomain}` : tunnel.publicUrl;
        logger.info(`[+] Fast Cloudflare tunnel active for ${serial}: ${publicUrl}`);
      } else if (cleanCustomDomain) {
        publicUrl = `https://${cleanCustomDomain}`;
      }
    } catch (tErr) {
      logger.warn(`Tunnel notice for ${serial} (using local endpoint): ${tErr.message}`);
    }

    // Fetch active assigned PIN from device_assignments or existing record
    let assignedPin = null;
    try {
      const activeCfg = loadConfig();
      const supaUrl = activeCfg.supabaseUrl;
      const supaKey = activeCfg.supabaseServiceRoleKey || activeCfg.supabaseAnonKey;
      if (supaUrl && supaKey) {
        const daRes = await fetch(
          `${supaUrl.replace(/\/$/, '')}/rest/v1/devices?select=id,stream_url,device_assignments(access_password)&serial=eq.${encodeURIComponent(realSerial || serial)}&limit=1`,
          { headers: { apikey: supaKey, Authorization: `Bearer ${supaKey}` } }
        );
        if (daRes.ok) {
          const rows = await daRes.json();
          const r = rows && rows[0];
          if (r) {
            if (Array.isArray(r.device_assignments) && r.device_assignments.length > 0) {
              const pass = r.device_assignments[r.device_assignments.length - 1].access_password;
              if (pass) assignedPin = String(pass).trim();
            }
            if (!assignedPin && r.stream_url) {
              const m = r.stream_url.match(/[?&]pin=([^&]+)/i);
              if (m && m[1]) assignedPin = decodeURIComponent(m[1]).trim();
            }
          }
        }
      }
    } catch (_) {}

    const streamUrl = buildStreamUrl(publicUrl, port, realSerial || serial, assignedPin);

    logger.info(`[OK] Stream URL for ${serial}: ${streamUrl}`);

    // 7. Register with process manager (under both serial and realSerial if different)
    const sessionObj = {
      streamProcess,
      tunnelProcess,
      port,
      publicUrl,
      streamUrl,
      localUrl,
      model: deviceModel,
      brand: deviceBrand,
      deviceModel,
      deviceBrand,
      bindingCode,
      isPaid: true,
      paymentStatus: 'active',
      adbSerial: serial,
      hardwareSerial: realSerial,
      isUsb,
      isWifi: !isUsb,
    };
    processManager.addDevice(serial, sessionObj);
    if (realSerial && realSerial !== serial) {
      processManager.addDevice(realSerial, sessionObj);
    }

    // 8. Sync device + stream URL to Supabase cloud (under real physical serial)
    const primarySerial = realSerial || serial;
    await bindingService.syncDeviceUrl(primarySerial, streamUrl, {
      model: deviceModel,
      brand: deviceBrand,
      localUrl,
      port,
    });

    // 9. Register with central API (silent fail)
    try {
      await apiClient.registerDevice({
        serialNumber: serial,
        deviceModel,
        deviceBrand,
        streamUrl,
        status: 'ONLINE',
      });
    } catch (_) {}

    logger.info(`✅ Device ${serial} (${deviceBrand} ${deviceModel}) provisioned — stream ready`);

    // 10. Configure device to never sleep and pulse wake
    deviceKeepAlive.configureDeviceAntiSleep(serial).catch(() => {});
  } catch (err) {
    logger.error(`Failed to provision device ${serial}: ${err.message}`, { stack: err.stack });
    processManager.killDeviceProcesses(serial);
  }
}

// ─── Device Remove ────────────────────────────────────────────────────────────

async function handleDeviceRemove(device) {
  const serial = device.id;
  logger.info(`Device disconnected event received for: ${serial}`);
  recentRemovals.set(serial, Date.now());

  if (pendingOfflineTimers.has(serial)) {
    clearTimeout(pendingOfflineTimers.get(serial));
  }

  const timer = setTimeout(async () => {
    pendingOfflineTimers.delete(serial);
    if (!processManager.getDevice(serial)) return;
    logger.info(`Device ${serial} disconnected timeout reached (${OFFLINE_DEBOUNCE_MS}ms) — cleaning up session and marking offline`);
    processManager.killDeviceProcesses(serial);
    licenseService.markDeviceOffline(serial).catch(() => {});
    try { await apiClient.deregisterDevice(serial); } catch (_) {}
  }, OFFLINE_DEBOUNCE_MS);

  pendingOfflineTimers.set(serial, timer);
}

// ─── Tracker ─────────────────────────────────────────────────────────────────

async function startTracking() {
  const cfg = loadConfig();
  const adbHost = cfg.adbHost || '127.0.0.1';
  const adbPort = cfg.adbPort || 5037;

  let adbPath = cfg.adbPath || 'adb';
  const bundledAdb = path.join(__dirname, '../../assets/bin/adb.exe');
  if (!fs.existsSync(adbPath)) {
    if      (fs.existsSync(bundledAdb)) adbPath = bundledAdb;
    else if (fs.existsSync('C:\\platform-tools\\adb.exe')) adbPath = 'C:\\platform-tools\\adb.exe';
    else adbPath = 'adb';
  }

  logger.info(`Initializing ADB client: ${adbPath}`);
  client = Adb.createClient({ host: adbHost, port: adbPort, bin: adbPath });
  logger.info('Starting ADB device tracker...');

  try {
    const devices = await client.listDevices();
    logger.info(`Initial ADB scan: ${devices.length} device(s)`);
    for (const d of devices) {
      if (d.type === 'device') {
        await handleDeviceAdd(d);
      } else if (d.type === 'unauthorized') {
        logger.warn(`Device ${d.id} is UNAUTHORIZED — check the phone screen and tap "Allow USB Debugging", then reconnect the cable.`);
      } else if (d.type === 'offline') {
        logger.warn(`Device ${d.id} is OFFLINE — triggering reconnect.`);
        try {
          const adbBin = resolveAdb();
          const { exec } = require('child_process');
          exec(`"${adbBin}" -s ${d.id} reconnect`, { timeout: 3000 }, () => {});
        } catch (_) {}
      } else {
        logger.info(`Device ${d.id} skipped (type: ${d.type})`);
      }
    }
  } catch (err) {
    logger.error(`Initial ADB scan failed: ${err.message}`);
  }

  try {
    tracker = await client.trackDevices();

    tracker.on('add', (d) => {
      if (d.type === 'device') {
        handleDeviceAdd(d);
      } else if (d.type === 'unauthorized') {
        logger.warn(`Device ${d.id} is UNAUTHORIZED — check the phone screen and tap "Allow USB Debugging".`);
      } else if (d.type === 'offline') {
        logger.warn(`Device ${d.id} is OFFLINE — triggering reconnect.`);
        try {
          const adbBin = resolveAdb();
          const { exec } = require('child_process');
          exec(`"${adbBin}" -s ${d.id} reconnect`, { timeout: 3000 }, () => {});
        } catch (_) {}
      }
    });
    tracker.on('remove', (d) => handleDeviceRemove(d));
    tracker.on('end',    () => {
      logger.warn('ADB tracker ended — restarting in 5s');
      setTimeout(startTracking, 5000);
    });
    tracker.on('error', (err) => logger.error(`ADB tracker error: ${err.message}`));

    logger.info('✅ ADB device tracker started');

    // Start persistent device keep-alive and anti-sleep service
    deviceKeepAlive.startKeepAliveService();

    // Start background enrollment guard (catches rebooted/silently-reconnected devices)
    enrollmentGuard.startEnrollmentGuard(handleDeviceAdd, handleDeviceRemove, 12000);

    // Start periodic cloud heartbeat for all active connected devices
    startCloudHeartbeat();
  } catch (err) {
    logger.error(`Failed to start ADB tracker: ${err.message} — retry in 5s`);
    setTimeout(startTracking, 5000);
  }
}

let cloudHeartbeatTimer = null;

function startCloudHeartbeat() {
  if (cloudHeartbeatTimer) clearInterval(cloudHeartbeatTimer);

  const performSync = async () => {
    try {
      const activeDevices = processManager.getActiveDeviceSummaries();
      const defaultBinding = bindingService.getOrGenerateBindingCode();
      const activeSerials = new Set((activeDevices || []).map(d => d.serial));

      for (const dev of (activeDevices || [])) {
        await licenseService.syncDeviceToCloud({
          serial: dev.serial,
          model: dev.deviceModel || dev.model,
          brand: dev.deviceBrand || dev.brand,
          streamUrl: dev.streamUrl,
          localUrl: dev.localUrl,
          port: dev.port,
          bindingCode: dev.bindingCode || defaultBinding,
          status: 'online',
        });
      }
    } catch (_) {}
  };

  // Immediate sync on start
  performSync();

  // Periodic heartbeat every 5 minutes (event-driven syncs handle plug/unplug)
  cloudHeartbeatTimer = setInterval(performSync, 300000);
}

function stopCloudHeartbeat() {
  if (cloudHeartbeatTimer) {
    clearInterval(cloudHeartbeatTimer);
    cloudHeartbeatTimer = null;
  }
}

function stopTracking() {
  stopCloudHeartbeat();
  enrollmentGuard.stopEnrollmentGuard();
  if (tracker) {
    try { tracker.end(); tracker = null; logger.info('ADB tracker stopped'); }
    catch (err) { logger.error(`Error stopping ADB tracker: ${err.message}`); }
  }
}

module.exports = { startTracking, stopTracking };
