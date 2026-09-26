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
const DEBOUNCE_MS = 3000;

// ─── Device Add ───────────────────────────────────────────────────────────────

async function handleDeviceAdd(device) {
  const serial = device.id;
  const isUsb = !serial.includes(':');

  // Strict USB debugging only: immediately reject and disconnect any WiFi / network endpoint
  if (!isUsb) {
    logger.info(`[ADB] Rejecting non-USB / WiFi device ${serial} — strict USB debugging only is enforced.`);
    try {
      const adbBin = resolveAdb();
      const { exec } = require('child_process');
      exec(`"${adbBin}" disconnect ${serial}`, { timeout: 3000 }, () => {});
    } catch (_) {}
    return;
  }

  const existingSession = processManager.getDevice(serial);
  if (existingSession && existingSession.port) {
    logger.info(`Device ${serial} already active on port ${existingSession.port} — preserving running stream`);
    return;
  }

  const lastRemoval = recentRemovals.get(serial);
  if (lastRemoval && Date.now() - lastRemoval < DEBOUNCE_MS) {
    const waitTime = DEBOUNCE_MS - (Date.now() - lastRemoval);
    logger.info(`Debouncing reconnection for ${serial}, waiting ${waitTime}ms`);
    await new Promise(r => setTimeout(r, waitTime));
  }

  logger.info(`Device connected: ${serial} (type: ${device.type}, connection: USB)`);

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

    // 2. Sync machine binding (no payment check — license managed online)
    const bindingCode = await bindingService.syncMachineBinding();
    const licenseStatus = await licenseService.checkLicenseStatus(bindingCode);

    if (!licenseStatus.isActive) {
      logger.warn(`[LICENSE] Binding ${bindingCode} is NOT licensed: ${licenseStatus.note}`);
      logger.warn(`[LICENSE] Device ${serial} stream will be locked until license is restored by seed admin.`);
    } else {
      logger.info(`[LICENSE] Binding ${bindingCode} is active (${licenseStatus.mode})`);
    }

    // 3. Allocate port
    const port = await getFreePort(PORT_RANGE_START, PORT_RANGE_END);
    logger.info(`Allocated port ${port} for device ${serial}`);

    // 4. Start stream server (always starts — license is enforced at website level)
    const { streamProcess, localUrl } = await startStreamServer(serial, port);
    logger.info(`Stream server started for ${serial}: ${localUrl}`);

    // 5. Establish fast Cloudflare tunnel or local stream URL
    let publicUrl = `http://localhost:${port}`;
    let tunnelProcess = null;

    try {
      const activeCfg = loadConfig();
      const rawCustomDomain = activeCfg.domain || activeCfg.customDomain || 'stream.dennoh.site';
      let cleanCustomDomain = (rawCustomDomain && !rawCustomDomain.includes('localhost') && !rawCustomDomain.includes('127.0.0.1'))
        ? rawCustomDomain.replace(/^https?:\/\//, '').replace(/\/+$/, '')
        : 'stream.dennoh.site';
      if (cleanCustomDomain === 'dennoh.site' || cleanCustomDomain === 'agent.dennoh.site') {
        cleanCustomDomain = 'stream.dennoh.site';
      }

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

    const streamUrl = buildStreamUrl(publicUrl, port, realSerial || serial);

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
      isPaid: licenseStatus.isActive,
      paymentStatus: licenseStatus.mode,
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
  } catch (err) {
    logger.error(`Failed to provision device ${serial}: ${err.message}`, { stack: err.stack });
    processManager.killDeviceProcesses(serial);
  }
}

// ─── Device Remove ────────────────────────────────────────────────────────────

async function handleDeviceRemove(device) {
  const serial = device.id;
  logger.info(`Device disconnected: ${serial}`);
  recentRemovals.set(serial, Date.now());

  processManager.killDeviceProcesses(serial);

  // Mark device offline in Supabase
  licenseService.markDeviceOffline(serial).catch(() => {});

  try { await apiClient.deregisterDevice(serial); } catch (_) {}
  logger.info(`Device ${serial} cleanup complete`);
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
      if (d.id && d.id.includes(':')) {
        logger.info(`[ADB] Disconnecting wireless ADB device ${d.id} — strict USB debugging only`);
        try {
          const adbBin = resolveAdb();
          const { exec } = require('child_process');
          exec(`"${adbBin}" disconnect ${d.id}`, { timeout: 3000 }, () => {});
        } catch (_) {}
        continue;
      }
      if (d.type === 'device') {
        await handleDeviceAdd(d);
      } else if (d.type === 'unauthorized') {
        logger.warn(`Device ${d.id} is UNAUTHORIZED — check the phone screen and tap "Allow USB Debugging", then reconnect the cable.`);
      } else if (d.type === 'offline') {
        logger.warn(`Device ${d.id} is OFFLINE — try unplugging and replugging the USB cable.`);
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
      if (d.id && d.id.includes(':')) {
        logger.info(`[ADB] Rejecting incoming WiFi device ${d.id} and disconnecting`);
        try {
          const adbBin = resolveAdb();
          const { exec } = require('child_process');
          exec(`"${adbBin}" disconnect ${d.id}`, { timeout: 3000 }, () => {});
        } catch (_) {}
        return;
      }
      if (d.type === 'device') {
        handleDeviceAdd(d);
      } else if (d.type === 'unauthorized') {
        logger.warn(`Device ${d.id} is UNAUTHORIZED — check the phone screen and tap "Allow USB Debugging".`);
      } else if (d.type === 'offline') {
        logger.warn(`Device ${d.id} is OFFLINE — try unplugging and replugging the USB cable.`);
      }
    });
    tracker.on('remove', (d) => handleDeviceRemove(d));
    tracker.on('end',    () => {
      logger.warn('ADB tracker ended — restarting in 5s');
      setTimeout(startTracking, 5000);
    });
    tracker.on('error', (err) => logger.error(`ADB tracker error: ${err.message}`));

    logger.info('✅ ADB device tracker started');

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

      // Reconcile with Supabase: mark any devices for this binding code that are NOT active as offline
      try {
        const client = licenseService.getSupabaseClient ? licenseService.getSupabaseClient() : null;
        if (client) {
          const res = await client.get(`/devices?binding_code=eq.${encodeURIComponent(defaultBinding)}&status=eq.online&select=serial`);
          if (res.data && Array.isArray(res.data)) {
            for (const row of res.data) {
              if (row.serial && !activeSerials.has(row.serial)) {
                logger.info(`[Heartbeat] Device ${row.serial} no longer attached on USB — marking offline in cloud`);
                await licenseService.markDeviceOffline(row.serial);
              }
            }
          }
        }
      } catch (_) {}
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
