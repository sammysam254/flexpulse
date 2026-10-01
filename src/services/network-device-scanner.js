'use strict';

const net = require('net');
const os = require('os');
const { exec } = require('child_process');
const path = require('path');
const fs = require('fs');
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

// ── Known Farm Devices (Static / Reserved DHCP Endpoints) ───────────────────
const KNOWN_FARM_ENDPOINTS = [
  '10.1.10.49:5555',
  '10.1.10.79:5555',
  '10.1.10.100:5555',
  '10.1.10.173:5555',
  '10.1.10.197:5555',
];

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
 * Execute adb connect for a single endpoint.
 * @param {string} endpoint - e.g. "10.1.10.49:5555"
 * @param {string} adbBin
 * @returns {Promise<boolean>}
 */
function adbConnectEndpoint(endpoint, adbBin) {
  return new Promise((resolve) => {
    exec(`"${adbBin}" connect ${endpoint}`, { timeout: 4000 }, (err, stdout, stderr) => {
      const out = ((stdout || '') + ' ' + (stderr || '')).toLowerCase();
      if (!err && (out.includes('connected to') || out.includes('already connected'))) {
        logger.info(`[NetScanner] Successfully connected to ${endpoint}`);
        resolve(true);
      } else {
        resolve(false);
      }
    });
  });
}

/**
 * Probe a single IP:port via lightweight raw TCP socket.
 * @param {string} ip
 * @param {number} port
 * @param {number} timeoutMs
 * @returns {Promise<boolean>}
 */
function testTcpPort(ip, port = 5555, timeoutMs = 350) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;

    const cleanup = (isOpen) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(isOpen);
    };

    socket.setTimeout(timeoutMs);
    socket.once('connect', () => cleanup(true));
    socket.once('timeout', () => cleanup(false));
    socket.once('error', () => cleanup(false));

    try {
      socket.connect(port, ip);
    } catch (_) {
      cleanup(false);
    }
  });
}

/**
 * Detect all local IPv4 subnets across all network interfaces.
 * Defaults to including 10.1.10 if not found, to guarantee farm subnet scanning.
 * @returns {string[]} e.g. ["10.1.10", "192.168.1"]
 */
function getLocalSubnetPrefixes() {
  const prefixes = new Set(['10.1.10']); // Always include farm default subnet
  try {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
      for (const iface of interfaces[name] || []) {
        if (iface.family === 'IPv4' && !iface.internal) {
          const parts = iface.address.split('.');
          if (parts.length === 4) {
            prefixes.add(`${parts[0]}.${parts[1]}.${parts[2]}`);
          }
        }
      }
    }
  } catch (_) {}
  return Array.from(prefixes);
}

/**
 * Scan a subnet prefix (e.g. "10.1.10") for open port 5555 and connect to discovered devices.
 * Probes in chunks to prevent network socket congestion.
 * @param {string} prefix
 * @param {string} adbBin
 * @returns {Promise<string[]>} List of newly connected endpoints
 */
async function scanSubnet(prefix, adbBin) {
  const discovered = [];
  const chunkSize = 32;
  const ips = [];
  for (let i = 1; i <= 254; i++) {
    ips.push(`${prefix}.${i}`);
  }

  for (let i = 0; i < ips.length; i += chunkSize) {
    const batch = ips.slice(i, i + chunkSize);
    const results = await Promise.all(
      batch.map(async (ip) => {
        const isOpen = await testTcpPort(ip, 5555, 300);
        return { ip, isOpen };
      })
    );

    const openIps = results.filter(r => r.isOpen).map(r => r.ip);
    if (openIps.length > 0) {
      for (const ip of openIps) {
        const endpoint = `${ip}:5555`;
        const connected = await adbConnectEndpoint(endpoint, adbBin);
        if (connected) discovered.push(endpoint);
      }
    }
  }

  return discovered;
}

/**
 * Master scan & connect routine:
 * Disabled in USB debugging mode: all devices are physically connected via USB cables.
 * @returns {Promise<{ connected: string[], totalScanned: number }>}
 */
async function scanAndConnectAll() {
  logger.info('[NetScanner] Direct USB debugging active — network/WiFi scanning bypassed.');
  return { connected: [] };
}

module.exports = {
  KNOWN_FARM_ENDPOINTS,
  adbConnectEndpoint,
  scanAndConnectAll,
  testTcpPort,
  getLocalSubnetPrefixes,
};
