'use strict';

const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { exec } = require('child_process');
const logger = require('../utils/logger');
const processManager = require('../main/process-manager');
const bindingService = require('../services/binding-service');
const licenseService = require('../services/license-service');

let server = null;
let serverPort = 7400;

// Session token cache to avoid exposing binding code in HTTP responses
const SESSION_TOKENS = new Map();

function generateSessionToken() {
  return crypto.randomBytes(32).toString('hex');
}

function storeBindingCodeInSession(bindingCode) {
  const token = generateSessionToken();
  SESSION_TOKENS.set(token, {
    bindingCode,
    createdAt: Date.now(),
  });
  
  // Expire tokens after 5 minutes
  setTimeout(() => {
    SESSION_TOKENS.delete(token);
  }, 5 * 60 * 1000);
  
  return token;
}

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
  '0B0FP75LXGV4E1JN': ['OBOFP75LXGV4EIJN'],
  'OBOFP75LXGV4EIJN': ['0B0FP75LXGV4E1JN'],
  'V8RGXC5DSLMJJRQW': ['V8RGXC5D5LMJJRQW'],
  'V8RGXC5D5LMJJRQW': ['V8RGXC5DSLMJJRQW'],
};

function canonicalSerial(s) {
  if (!s) return '';
  return String(s)
    .trim()
    .toUpperCase()
    .replace(/[0O]/g, '0')
    .replace(/[1IL]/g, '1')
    .replace(/[5S]/g, '5')
    .replace(/[8B]/g, '8')
    .replace(/[^A-Z0-9]/g, '');
}

function findTargetDevice(rawSerial, actionParam) {
  if (!rawSerial) {
    if (actionParam === 'proxy') {
      const devices = processManager.getActiveDeviceSummaries();
      return devices[0] || null;
    }
    return null;
  }

  const serial = decodeURIComponent(rawSerial).trim();

  // 1. Direct lookup from processManager active sessions (USB priority)
  const direct = processManager.getDevice(serial);
  if (direct && direct.port && !direct.isWifi) return direct;

  // 1b. Check known farm hardware serial aliases (USB priority)
  const aliases = FARM_SERIAL_ALIASES[serial] || [];
  for (const alias of aliases) {
    const aliasDev = processManager.getDevice(alias);
    if (aliasDev && aliasDev.port && !aliasDev.isWifi) return aliasDev;
  }
  for (const alias of aliases) {
    const aliasDev = processManager.getDevice(alias);
    if (aliasDev && aliasDev.port) return aliasDev;
  }

  if (direct && direct.port) return direct;

  // 2. Check all active sessions for hardwareSerial, adbSerial, or serial match
  const allSerials = processManager.getActiveSerials();
  for (const s of allSerials) {
    const dev = processManager.getDevice(s);
    if (!dev || !dev.port) continue;
    if (dev.hardwareSerial === serial || dev.adbSerial === serial || dev.serial === serial) {
      return dev;
    }
    if (dev.hardwareSerial?.toLowerCase() === serial.toLowerCase() || dev.serial?.toLowerCase() === serial.toLowerCase()) {
      return dev;
    }
  }

  // 3. Match by IP address without port if serial contains IP
  if (serial.includes(':')) {
    const ipOnly = serial.split(':')[0];
    for (const s of allSerials) {
      const dev = processManager.getDevice(s);
      if (dev && dev.port && (s.startsWith(ipOnly) || dev.adbSerial?.startsWith(ipOnly))) {
        return dev;
      }
    }
  }

  // 4. Summaries fallback
  const summaries = processManager.getActiveDeviceSummaries();
  const found = summaries.find(d => 
    d.serial === serial || 
    d.serial?.toLowerCase() === serial.toLowerCase() ||
    (d.serial && (d.serial.includes(serial) || serial.includes(d.serial)))
  );
  if (found) return found;

  // 5. Canonical fuzzy match (resolves 0/O, 1/I/L, 5/S OCR discrepancies seamlessly)
  const canon = canonicalSerial(serial);
  if (canon) {
    for (const s of allSerials) {
      const dev = processManager.getDevice(s);
      if (!dev || !dev.port) continue;
      if (canonicalSerial(dev.serial) === canon ||
          canonicalSerial(dev.hardwareSerial) === canon ||
          canonicalSerial(dev.adbSerial) === canon) {
        return dev;
      }
    }
    const foundCanonical = summaries.find(d => 
      canonicalSerial(d.serial) === canon || 
      canonicalSerial(d.adbSerial) === canon || 
      canonicalSerial(d.hardwareSerial) === canon
    );
    if (foundCanonical) return foundCanonical;
  }

  return null;
}

/**
 * Start the local Dashboard HTTP Server.
 * @param {number} [port=7400]
 * @returns {Promise<{ port: number, url: string }>}
 */
function startDashboardServer(port = 7400) {
  return new Promise((resolve, reject) => {
    serverPort = port;
    const htmlPath = path.join(__dirname, 'index.html');

    try {
      const wifiCachePath = path.join(process.cwd(), 'wifi-devices-cache.json');
      if (fs.existsSync(wifiCachePath)) fs.unlinkSync(wifiCachePath);
    } catch (_) {}

    server = http.createServer(async (req, res) => {
      try {
        // Enable CORS & Security headers (permitting frame embedding on flexpulse.cloud)
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('X-XSS-Protection', '1; mode=block');
      res.setHeader('Referrer-Policy', 'no-referrer');
      res.setHeader('Permissions-Policy', 'geolocation=(), camera=(), microphone=(), interest-cohort=()');
      res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline' https://static.cloudflareinsights.com; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self' ws: wss:; frame-ancestors *;");

      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }

      const fullUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const url = fullUrl.pathname;

      // ── API Routes ────────────────────────────────────────────────────────
      // ── Public endpoint for initial binding code (no auth required) ────
      if (url === '/api/binding/code') {
        const bindingCode = bindingService.getOrGenerateBindingCode();
        
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          status: 'ok',
          bindingCode,
          timestamp: new Date().toISOString()
        }));
        return;
      }

      if (url === '/api/devices') {
        const bindingCode = bindingService.getOrGenerateBindingCode();
        const lic = await licenseService.checkLicenseStatus(bindingCode);
        const rawDevices = processManager.getActiveDeviceSummaries();
        const sessionToken = storeBindingCodeInSession(bindingCode);

        const remoteIp = req.socket.remoteAddress || '';
        const hostHeader = req.headers.host || '';
        const isCloudflareOrRemote = Boolean(req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'] || (hostHeader && !hostHeader.includes('localhost') && !hostHeader.includes('127.0.0.1')));
        const isLocalHost = !isCloudflareOrRemote && (remoteIp.includes('127.0.0.1') || remoteIp.includes('::1') || remoteIp.includes('localhost') || hostHeader.includes('localhost') || hostHeader.includes('127.0.0.1'));

        const devices = isLocalHost ? rawDevices.map(d => ({
          ...d,
          streamUrl: (d.streamUrl && !d.streamUrl.includes('pin=')) ? `${d.streamUrl}&token=${sessionToken}` : d.streamUrl,
        })) : [];

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          status: 'ok',
          bindingCode,
          sessionToken,
          isLicensed: lic.isActive,
          licenseMode: lic.mode,
          count: isLocalHost ? rawDevices.length : 0,
          devices: devices,
          isRemote: !isLocalHost,
          timestamp: new Date().toISOString()
        }));
        return;
      }

      if (url === '/api/license/status' || url === '/api/rental/status') {
        const bindingCode = bindingService.getOrGenerateBindingCode();
        const lic = await licenseService.checkLicenseStatus(bindingCode);
        const devices = processManager.getActiveDeviceSummaries();

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          status: 'ok',
          bindingCode,  // Public endpoint - show binding code
          isLicensed: lic.isActive,
          licenseMode: lic.mode,
          note: lic.note,
          deviceCount: devices.length,
          deviceSerials: devices.map(d => ({ serial: d.serial, model: d.model, port: d.port })),
          timestamp: new Date().toISOString()
        }));
        return;
      }

      if (url === '/api/system-logs') {
        const logRelayService = require('../services/log-relay-service');
        const limit = parseInt(fullUrl.searchParams.get('limit') || '100', 10);
        const logs = logRelayService.getRecentLogs ? logRelayService.getRecentLogs(limit) : [];
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'no-cache',
        });
        res.end(JSON.stringify({ status: 'ok', logs }));
        return;
      }

      if (url === '/api/system/sync' || url === '/api/system/update') {
        const autoSync = require('../services/auto-sync-service');
        if (autoSync && autoSync.checkAndSyncGithub) {
          autoSync.checkAndSyncGithub().catch(() => {});
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', message: 'Sync check initiated' }));
        return;
      }

      if (url === '/api/system/reconnect') {
        const enrollmentGuard = require('../services/enrollment-guard');
        if (enrollmentGuard && enrollmentGuard.runRecoveryCheck) {
          enrollmentGuard.runRecoveryCheck(true).catch(() => {});
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', message: 'Recovery check initiated' }));
        return;
      }

      if (url === '/download/installer' || url === '/download/agent') {
        const setupBatPath = path.join(__dirname, '..', '..', 'DeviceFarm-Agent-Setup.bat');
        if (fs.existsSync(setupBatPath)) {
          res.writeHead(200, {
            'Content-Type': 'application/x-msdos-program',
            'Content-Disposition': 'attachment; filename="DeviceFarm-Agent-Setup.bat"',
            'Cache-Control': 'no-cache',
          });
          fs.createReadStream(setupBatPath).pipe(res);
        } else {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('Installer not found');
        }
        return;
      }

      // ── Proxy Handling ──────────────────────────────────────────────────
      const actionParam = fullUrl.searchParams.get('action');
      const udidParam = fullUrl.searchParams.get('udid');
      const remoteParam = fullUrl.searchParams.get('remote');

      if (actionParam === 'proxy' || udidParam || remoteParam) {
        const rawSerial = udidParam || (remoteParam ? decodeURIComponent(remoteParam).split(':').pop() : null);
        const targetDev = findTargetDevice(rawSerial, actionParam);

        if (targetDev && targetDev.port) {
          const forwardHeaders = { ...req.headers };
          forwardHeaders.host = `127.0.0.1:${targetDev.port}`;
          delete forwardHeaders['transfer-encoding'];
          delete forwardHeaders['connection'];
          delete forwardHeaders['keep-alive'];

          const proxyReq = http.request({
            hostname: '127.0.0.1',
            port: targetDev.port,
            path: req.url,
            method: req.method,
            headers: forwardHeaders,
            timeout: 15000,
          }, (proxyRes) => {
            if (!res.headersSent) {
              const resHeaders = { ...proxyRes.headers };
              delete resHeaders['transfer-encoding'];
              delete resHeaders['connection'];
              delete resHeaders['keep-alive'];
              res.writeHead(proxyRes.statusCode, resHeaders);
            }
            proxyRes.pipe(res);
            proxyRes.on('error', () => { try { res.destroy(); } catch (_) {} });
          });

          proxyReq.on('timeout', () => {
            proxyReq.destroy();
            if (!res.headersSent) {
              res.writeHead(504, { 'Content-Type': 'text/plain' });
              res.end('Gateway Timeout — device stream response timed out');
            }
          });

          proxyReq.on('error', () => {
            if (!res.headersSent) {
              res.writeHead(502, { 'Content-Type': 'text/plain' });
              res.end('Bad Gateway — device stream unavailable');
            } else {
              try { res.destroy(); } catch (_) {}
            }
          });

          req.on('error', () => { try { proxyReq.destroy(); } catch (_) {} });
          req.pipe(proxyReq);
          return;
        }

        // If a specific device UDID was requested but not found locally on this machine:
        if (udidParam || remoteParam) {
          const requestedSerial = rawSerial || 'Unknown';

          // Look up device in Supabase cloud to check if active on another node
          try {
            const cfg = require('../../config.json');
            const supaUrl = cfg.supabaseUrl;
            const supaKey = cfg.supabaseServiceRoleKey || cfg.supabaseAnonKey;
            if (supaUrl && supaKey) {
              const canonReq = canonicalSerial(requestedSerial);
              const devRes = await fetch(`${supaUrl.replace(/\/$/, '')}/rest/v1/devices?select=serial,stream_url,status`, {
                headers: { apikey: supaKey, Authorization: `Bearer ${supaKey}` }
              });
              if (devRes.ok) {
                const devs = await devRes.json();
                const matched = (devs || []).find(d => 
                  d.serial === requestedSerial || 
                  canonicalSerial(d.serial) === canonReq
                );
                if (matched && matched.stream_url) {
                  const targetStreamUrl = matched.stream_url;
                  const parsed = new URL(targetStreamUrl.startsWith('http') ? targetStreamUrl : `https://${targetStreamUrl}`);
                  const currentHost = (req.headers.host || '').toLowerCase();
                  if (parsed.host.toLowerCase() !== currentHost && !targetStreamUrl.includes('localhost') && !targetStreamUrl.includes('127.0.0.1')) {
                    res.writeHead(302, { 'Location': targetStreamUrl });
                    res.end();
                    return;
                  }
                }
              }
            }
          } catch (_) {}

          // Clean, auto-reconnecting stream player (no binding code errors or locks)
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(`
            <!DOCTYPE html>
            <html lang="en">
            <head>
              <meta charset="UTF-8">
              <meta name="viewport" content="width=device-width, initial-scale=1.0">
              <title>Connecting — ${requestedSerial}</title>
              <style>
                body { background: #060911; color: #f8fafc; font-family: system-ui, -apple-system, sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; padding: 20px; box-sizing: border-box; }
                .card { max-width: 460px; width: 100%; background: #0f172a; border: 1px solid rgba(56, 189, 248, 0.25); border-radius: 20px; padding: 36px 28px; text-align: center; box-shadow: 0 25px 50px rgba(0,0,0,0.6); }
                .spinner { width: 44px; height: 44px; border: 3px solid rgba(56, 189, 248, 0.15); border-top-color: #38bdf8; border-radius: 50%; animation: spin 0.8s linear infinite; margin: 0 auto 16px; }
                @keyframes spin { to { transform: rotate(360deg); } }
                h2 { color: #38bdf8; margin: 0 0 8px; font-size: 20px; font-weight: 700; }
                p { color: #94a3b8; font-size: 14px; line-height: 1.5; margin: 0 0 16px; }
                code { background: rgba(255,255,255,0.08); color: #38bdf8; padding: 3px 8px; border-radius: 6px; font-family: monospace; font-size: 14px; }
                .status-badge { display: inline-flex; align-items: center; gap: 6px; background: rgba(56, 189, 248, 0.1); border: 1px solid rgba(56, 189, 248, 0.2); padding: 5px 12px; border-radius: 100px; font-size: 12px; color: #38bdf8; font-weight: 600; }
              </style>
            </head>
            <body>
              <div class="card">
                <div class="spinner"></div>
                <h2>Connecting to Device Stream</h2>
                <p>Initializing hardware video pipeline for <code>${requestedSerial}</code>...</p>
                <div class="status-badge">Linking to Cloud Stream</div>
                <script>setTimeout(() => location.reload(), 3000);</script>
              </div>
            </body>
            </html>
          `);
          return;
        }
      }

        // ── Serve Index HTML Page ───────────────────────────────────────────
        fs.readFile(htmlPath, (err, data) => {
          if (err) {
            res.writeHead(500, { 'Content-Type': 'text/plain' });
            res.end('Error loading dashboard page');
            return;
          }
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(data);
        });
      } catch (handlerErr) {
        logger.error(`[DashboardServer] Request error: ${handlerErr.message}`);
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'text/plain' });
          res.end('Internal Server Error');
        } else {
          try { res.destroy(); } catch (_) {}
        }
      }
    });

    server.on('clientError', (err, socket) => {
      try {
        if (socket.writable) {
          socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
        }
        socket.destroy();
      } catch (_) {}
    });

    server.on('upgrade', (req, socket, head) => {
      socket.on('error', () => { try { socket.destroy(); } catch (_) {} });

      const fullUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const actionParam = fullUrl.searchParams.get('action');
      const udidParam = fullUrl.searchParams.get('udid');
      const remoteParam = fullUrl.searchParams.get('remote');
      const serial = udidParam || (remoteParam ? decodeURIComponent(remoteParam).split(':').pop() : null);
      const targetDev = findTargetDevice(serial, actionParam);

      if (targetDev && targetDev.port) {
        const forwardHeaders = { ...req.headers };
        forwardHeaders.host = `127.0.0.1:${targetDev.port}`;

        const proxyReq = http.request({
          hostname: '127.0.0.1',
          port: targetDev.port,
          path: req.url,
          method: 'GET',
          headers: forwardHeaders,
        });

        proxyReq.on('upgrade', (proxyRes, proxySocket, proxyHead) => {
          proxySocket.on('error', () => { try { socket.destroy(); proxySocket.destroy(); } catch (_) {} });
          socket.on('error', () => { try { proxySocket.destroy(); socket.destroy(); } catch (_) {} });

          try {
            if (typeof proxySocket.setNoDelay === 'function') proxySocket.setNoDelay(true);
            if (typeof socket.setNoDelay === 'function') socket.setNoDelay(true);
            if (typeof proxySocket.setKeepAlive === 'function') proxySocket.setKeepAlive(true, 10000);
            if (typeof socket.setKeepAlive === 'function') socket.setKeepAlive(true, 10000);
          } catch (_) {}

          socket.write(
            `HTTP/1.1 ${proxyRes.statusCode} ${proxyRes.statusMessage}\r\n` +
            Object.keys(proxyRes.headers)
              .map(k => `${k}: ${proxyRes.headers[k]}`)
              .join('\r\n') +
            '\r\n\r\n'
          );

          if (proxyHead && proxyHead.length) socket.write(proxyHead);
          if (head && head.length) proxySocket.write(head);

          proxySocket.pipe(socket);
          socket.pipe(proxySocket);
        });

        proxyReq.on('error', (err) => {
          try {
            socket.write('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
            socket.end();
          } catch (_) {}
        });

        proxyReq.end();
      } else {
        // If not found locally, proxy WebSocket to remote node if device is active elsewhere
        (async () => {
          try {
            const cfg = require('../../config.json');
            const supaUrl = cfg.supabaseUrl;
            const supaKey = cfg.supabaseServiceRoleKey || cfg.supabaseAnonKey;
            if (supaUrl && supaKey && serial) {
              const canonReq = canonicalSerial(serial);
              const devRes = await fetch(`${supaUrl.replace(/\/$/, '')}/rest/v1/devices?select=serial,stream_url,status`, {
                headers: { apikey: supaKey, Authorization: `Bearer ${supaKey}` }
              });
              if (devRes.ok) {
                const devs = await devRes.json();
                const matched = (devs || []).find(d => d.serial === serial || canonicalSerial(d.serial) === canonReq);
                if (matched && matched.stream_url) {
                  const targetUrl = new URL(matched.stream_url.startsWith('http') ? matched.stream_url : `https://${matched.stream_url}`);
                  const currentHost = (req.headers.host || '').toLowerCase();
                  if (targetUrl.host.toLowerCase() !== currentHost && !targetUrl.hostname.includes('localhost') && !targetUrl.hostname.includes('127.0.0.1')) {
                    const clientModule = targetUrl.protocol === 'https:' ? require('https') : require('http');
                    const targetPort = targetUrl.port || (targetUrl.protocol === 'https:' ? 443 : 80);
                    const remoteProxyReq = clientModule.request({
                      hostname: targetUrl.hostname,
                      port: targetPort,
                      path: req.url,
                      method: 'GET',
                      headers: { ...req.headers, host: targetUrl.host },
                      timeout: 10000,
                    });
                    remoteProxyReq.on('upgrade', (rRes, rSocket, rHead) => {
                      rSocket.on('error', () => { try { socket.destroy(); rSocket.destroy(); } catch (_) {} });
                      socket.on('error', () => { try { rSocket.destroy(); socket.destroy(); } catch (_) {} });
                      try {
                        if (typeof rSocket.setNoDelay === 'function') rSocket.setNoDelay(true);
                        if (typeof socket.setNoDelay === 'function') socket.setNoDelay(true);
                      } catch (_) {}
                      socket.write(`HTTP/1.1 ${rRes.statusCode} ${rRes.statusMessage}\r\n` + Object.keys(rRes.headers).map(k => `${k}: ${rRes.headers[k]}`).join('\r\n') + '\r\n\r\n');
                      if (rHead && rHead.length) socket.write(rHead);
                      if (head && head.length) rSocket.write(head);
                      rSocket.pipe(socket);
                      socket.pipe(rSocket);
                    });
                    remoteProxyReq.on('error', () => {
                      try { socket.write('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n'); socket.end(); } catch (_) {}
                    });
                    remoteProxyReq.end();
                    return;
                  }
                }
              }
            }
          } catch (_) {}
          try {
            socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
            socket.end();
          } catch (_) {}
        })();
      }
    });

    server.listen(port, () => {
      const url = `http://localhost:${port}`;
      logger.info(`[DashboardServer] Listening at ${url}`);
      resolve({ port, url });
    });

    server.on('error', (err) => {
      logger.error(`[DashboardServer] Failed to start on port ${port}: ${err.message}`);
      reject(err);
    });
  });
}

function stopDashboardServer() {
  if (server) {
    server.close();
    server = null;
  }
}

function getDashboardUrl() {
  return `http://localhost:${serverPort}`;
}

function openInChrome(url) {
  const isWin = process.platform === 'win32';
  if (isWin) {
    exec(`start "" "${url}"`, (err) => {
      if (err) logger.warn(`Could not open Chrome: ${err.message}`);
    });
  }
}

module.exports = {
  startDashboardServer,
  stopDashboardServer,
  getDashboardUrl,
  openInChrome,
  SESSION_TOKENS,
};
