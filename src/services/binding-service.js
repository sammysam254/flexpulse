'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
let logger;
try {
  logger = require('../utils/logger');
} catch (_) {
  logger = {
    info: (...a) => console.log('[INFO]', ...a),
    warn: (...a) => console.warn('[WARN]', ...a),
    error: (...a) => console.error('[ERROR]', ...a),
  };
}
let licenseService = null;
function getLicenseService() {
  if (!licenseService) {
    try {
      licenseService = require('./license-service');
    } catch (_) {}
  }
  return licenseService;
}

function loadConfigPath() {
  const candidates = [
    path.join(process.cwd(), 'config.json'),
    path.join(__dirname, '..', '..', 'config.json'),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return path.join(process.cwd(), 'config.json');
}

function loadConfig() {
  const cfgPath = loadConfigPath();
  if (fs.existsSync(cfgPath)) {
    try { return JSON.parse(fs.readFileSync(cfgPath, 'utf-8')); } catch (_) {}
  }
  return {};
}

function saveConfig(cfg) {
  const cfgPath = loadConfigPath();
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), 'utf-8');
}

/**
 * Extract physical network details: MAC Address, Local IPv4, and Subnet Broadcast IP.
 */
function getHardwareNetworkInfo() {
  const interfaces = os.networkInterfaces();
  let mac = '';
  let localIp = '';
  let netmask = '';

  for (const name of Object.keys(interfaces)) {
    for (const net of interfaces[name]) {
      // Prioritize non-internal IPv4 interfaces with a valid MAC
      if (!net.internal && net.family === 'IPv4' && net.mac && net.mac !== '00:00:00:00:00:00') {
        mac = net.mac.toUpperCase();
        localIp = net.address;
        netmask = net.netmask;
        break;
      }
    }
    if (mac && localIp) break;
  }

  // Fallback MAC search
  if (!mac) {
    for (const name of Object.keys(interfaces)) {
      for (const net of interfaces[name]) {
        if (!net.internal && net.mac && net.mac !== '00:00:00:00:00:00') {
          mac = net.mac.toUpperCase();
          break;
        }
      }
      if (mac) break;
    }
  }

  // Calculate subnet broadcast address
  let broadcastIp = '255.255.255.255';
  if (localIp && netmask) {
    try {
      const ipParts = localIp.split('.').map(Number);
      const maskParts = netmask.split('.').map(Number);
      const broadParts = ipParts.map((part, i) => (part | (~maskParts[i] & 255)));
      broadcastIp = broadParts.join('.');
    } catch (_) {
      broadcastIp = '255.255.255.255';
    }
  }

  return {
    mac: mac || '00:00:00:00:00:00',
    localIp: localIp || '127.0.0.1',
    broadcastIp: broadcastIp || '255.255.255.255',
    hostname: os.hostname() || process.env.COMPUTERNAME || 'Windows-Machine',
  };
}

/**
 * Derives a static, deterministic 8-digit machine binding code based on machine hardware identity.
 * This guarantees the exact same computer ALWAYS keeps the exact same binding code across setup script reruns.
 */
function getOrGenerateBindingCode() {
  const cfg = loadConfig();
  if (cfg.machineBindingCode && /^\d{8}$/.test(cfg.machineBindingCode)) {
    return cfg.machineBindingCode;
  }
  try {
    const netInfo = getHardwareNetworkInfo();
    const hash = crypto.createHash('sha256').update((netInfo.mac || '') + (os.hostname() || 'Flexpulse')).digest('hex');
    const numericCode = String((parseInt(hash.slice(0, 8), 16) % 90000000) + 10000000);
    cfg.machineBindingCode = numericCode;
    saveConfig(cfg);
    return numericCode;
  } catch (_) {
    return '10000001';
  }
}

let machineHeartbeatTimer = null;

/**
 * Sync machine binding and hardware info to Supabase machine_bindings table.
 */
async function syncMachineBinding() {
  const bindingCode = getOrGenerateBindingCode();
  const cfg = loadConfig();
  const netInfo = getHardwareNetworkInfo();
  
  const supabaseUrl = process.env.SUPABASE_URL || cfg.supabaseUrl;
  const apiKey = process.env.SUPABASE_SERVICE_ROLE_KEY || cfg.supabaseServiceRoleKey || cfg.supabaseAnonKey;

  if (!supabaseUrl || !apiKey) return bindingCode;

  try {
    const axios = require('axios');
    const client = axios.create({
      baseURL: `${supabaseUrl.replace(/\/$/, '')}/rest/v1`,
      timeout: 6000,
      headers: {
        'Content-Type': 'application/json',
        apikey: apiKey,
        Authorization: `Bearer ${apiKey}`,
        Prefer: 'resolution=merge-duplicates',
      },
    });

    const payload = {
      binding_code: bindingCode,
      machine_name: 'Flexpulse-' + (process.env.COMPUTERNAME || netInfo.hostname || 'Node'),
      mac_address: netInfo.mac,
      local_ip: netInfo.localIp,
      broadcast_ip: netInfo.broadcastIp,
      status: 'online',
      last_seen: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    // Upsert machine_bindings with on_conflict=binding_code
    await client.post('/machine_bindings?on_conflict=binding_code', payload, {
      headers: { Prefer: 'resolution=merge-duplicates' },
    });

    logger.info(`[BindingService] Machine hardware (${netInfo.mac} / ${netInfo.localIp}) & code ${bindingCode} synced`);
  } catch (err) {
    // If optional columns are missing in older schema, fallback to minimal payload
    try {
      const axios = require('axios');
      const client = axios.create({
        baseURL: `${supabaseUrl.replace(/\/$/, '')}/rest/v1`,
        timeout: 6000,
        headers: {
          'Content-Type': 'application/json',
          apikey: apiKey,
          Authorization: `Bearer ${apiKey}`,
          Prefer: 'resolution=merge-duplicates',
        },
      });
      await client.post('/machine_bindings?on_conflict=binding_code', {
        binding_code: bindingCode,
        machine_name: process.env.COMPUTERNAME || netInfo.hostname || 'Windows Agent Machine',
        updated_at: new Date().toISOString(),
      }, {
        headers: { Prefer: 'resolution=merge-duplicates' },
      });
    } catch (_) {}
  }

  // Start periodic machine status heartbeat every 60 seconds
  if (!machineHeartbeatTimer) {
    machineHeartbeatTimer = setInterval(() => {
      syncMachineBinding().catch(() => {});
    }, 60000);
  }

  return bindingCode;
}

/**
 * Sync a device's stream URL to Supabase.
 * Called each time device connects or tunnel URL changes.
 */
async function syncDeviceUrl(serial, streamUrl, opts = {}) {
  if (process.env.DISABLE_CLOUD_SYNC === 'true' || process.env.DISABLE_CLOUD_SYNC === '1') {
    logger.info(`[BindingService] Cloud sync disabled for ${serial} (DISABLE_CLOUD_SYNC env var set)`);
    return;
  }
  
  const bindingCode = getOrGenerateBindingCode();
  const svc = getLicenseService();
  if (svc) {
    await svc.syncDeviceToCloud({
      serial,
      model: opts.model,
      brand: opts.brand,
      streamUrl,
      localUrl: opts.localUrl,
      port: opts.port,
      bindingCode,
      status: 'online',
    });
  }
}

module.exports = {
  getHardwareNetworkInfo,
  getOrGenerateBindingCode,
  syncMachineBinding,
  syncDeviceUrl,
};
