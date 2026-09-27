'use strict';

const fs = require('fs');
const { execFile } = require('child_process');
const path = require('path');
const REPO_ROOT = path.resolve(__dirname, '..', '..');
let logger;
try {
  logger = require('../utils/logger');
} catch (_) {
  logger = {
    info: (...a) => console.log('[INFO]', ...a),
    warn: (...a) => console.warn('[WARN]', ...a),
    error: (...a) => console.error('[ERROR]', ...a)
  };
}

/**
 * Resolve absolute path to git executable on Windows/Linux.
 */
function resolveGitBin() {
  const candidates = [
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Git', 'cmd', 'git.exe'),
    path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Git', 'cmd', 'git.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Git', 'cmd', 'git.exe'),
    'git'
  ];
  for (const p of candidates) {
    if (p !== 'git' && fs.existsSync(p)) return p;
  }
  return 'git';
}

/**
 * Invalidate Node module cache for service files so updated code takes
 * effect instantly on incoming control events & stream connections without
 * restarting active WebSocket connections or dropping device streams.
 */
function invalidateModuleCache() {
  const targets = [
    './stream-service',
    './scrcpy-engine',
    './stealth-service',
    './api-client',
    './binding-service',
    './license-service',
    './rental-payment-service',
    './verify-payment'
  ];

  for (const t of targets) {
    try {
      const p = require.resolve(t);
      if (require.cache[p]) {
        delete require.cache[p];
      }
    } catch (_) {}
  }
}

const { promisify } = require('util');
const execFileAsync = promisify(execFile);

async function checkAndSyncGithub() {
  const gitBin = resolveGitBin();
  const TARGET_REPO = 'https://github.com/sammysam254/flexpulse.git';

  logger.info('[AutoSync] ═══════════════════════════════════════════════════');
  logger.info('[AutoSync] Starting 30-minute GitHub background sync check...');

  try {
    // First verify current repository configuration
    const { stdout: currentRemote } = await execFileAsync(gitBin, ['remote', 'get-url', 'origin'], { cwd: REPO_ROOT }).catch(() => ({ stdout: '' }));
    const currentUrl = (currentRemote || '').trim();
    logger.info(`[AutoSync] Current repository: ${currentUrl}`);

    if (currentUrl && currentUrl !== TARGET_REPO) {
      logger.warn(`[AutoSync] ⚠️  Repository mismatch detected!`);
      logger.warn(`[AutoSync] Expected: ${TARGET_REPO}`);
      logger.warn(`[AutoSync] Got:      ${currentUrl}`);
      logger.warn(`[AutoSync] Enforcing correct repository...`);
    }

    const { stdout: branch } = await execFileAsync(gitBin, ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: REPO_ROOT }).catch(() => ({ stdout: 'unknown' }));
    logger.info(`[AutoSync] Current branch: ${(branch || 'unknown').trim()}`);

    const { stdout: commit } = await execFileAsync(gitBin, ['rev-parse', '--short', 'HEAD'], { cwd: REPO_ROOT }).catch(() => ({ stdout: 'unknown' }));
    logger.info(`[AutoSync] Current commit: ${(commit || 'unknown').trim()}`);

    // Ensure origin remote points strictly to flexpulse repository
    await execFileAsync(gitBin, ['remote', 'set-url', 'origin', TARGET_REPO], { cwd: REPO_ROOT }).catch(() => {});
    logger.info(`[AutoSync] Repository remote enforced to: ${TARGET_REPO}`);

    // 1. Fetch remote origin/main
    try {
      await execFileAsync(gitBin, ['fetch', 'origin', 'main'], { cwd: REPO_ROOT, timeout: 45000 });
      logger.info('[AutoSync] ✓ Fetch successful from origin/main');
    } catch (fetchErr) {
      logger.warn(`[AutoSync] git fetch notice: ${fetchErr.message}`);
      logger.info('[AutoSync] ═══════════════════════════════════════════════════');
      return false;
    }

    // 2. Compare local HEAD hash vs origin/main hash
    const { stdout: localHead } = await execFileAsync(gitBin, ['rev-parse', 'HEAD'], { cwd: REPO_ROOT }).catch(() => ({ stdout: '' }));
    const { stdout: remoteHead } = await execFileAsync(gitBin, ['rev-parse', 'origin/main'], { cwd: REPO_ROOT }).catch(() => ({ stdout: '' }));

    const localHash = (localHead || '').trim();
    const remoteHash = (remoteHead || '').trim();

    if (localHash && remoteHash && localHash !== remoteHash) {
      logger.info(`[AutoSync] ⚡ New GitHub commit detected!`);
      logger.info(`[AutoSync] Local:  ${localHash.substring(0,7)}`);
      logger.info(`[AutoSync] Remote: ${remoteHash.substring(0,7)}`);
      logger.info(`[AutoSync] Pulling changes silently...`);

      const onUpdateSuccess = () => {
        execFile(gitBin, ['clean', '-fd'], { cwd: REPO_ROOT }, () => {});
        try {
          const wifiCache = path.join(REPO_ROOT, 'wifi-devices-cache.json');
          if (fs.existsSync(wifiCache)) fs.unlinkSync(wifiCache);
        } catch (_) {}
        invalidateModuleCache();
        logger.info('[AutoSync] ✓ GitHub changes applied successfully');
        logger.info('[AutoSync] ✓ Module cache invalidated');
        logger.info('[AutoSync] Scheduling graceful restart in 3s...');
        logger.info('[AutoSync] Watchdog will restart with latest code');
        logger.info('[AutoSync] ═══════════════════════════════════════════════════');
        setTimeout(() => {
          try {
            const { app } = require('electron');
            if (app && app.quit) app.quit();
          } catch (_) {}
          process.exit(0);
        }, 3000);
      };

      try {
        await execFileAsync(gitBin, ['pull', '--ff-only', 'origin', 'main'], { cwd: REPO_ROOT, timeout: 45000 });
        logger.info('[AutoSync] ✓ Fast-forward pull successful');
        onUpdateSuccess();
        return true;
      } catch (pullErr) {
        logger.warn(`[AutoSync] Pull conflict detected, using reset --hard fallback`);
        try {
          await execFileAsync(gitBin, ['reset', '--hard', 'origin/main'], { cwd: REPO_ROOT });
          logger.info('[AutoSync] ✓ Hard reset to origin/main successful');
          onUpdateSuccess();
          return true;
        } catch (resetErr) {
          logger.warn(`[AutoSync] git reset notice: ${resetErr.message}`);
          logger.info('[AutoSync] ═══════════════════════════════════════════════════');
          return false;
        }
      }
    } else {
      logger.info('[AutoSync] ✓ Agent code is up to date with origin/main');
      logger.info(`[AutoSync] Running commit: ${localHash.substring(0,7)}`);
      logger.info('[AutoSync] Active device streams running smoothly');
      logger.info('[AutoSync] ═══════════════════════════════════════════════════');
      return false;
    }
  } catch (err) {
    logger.warn(`[AutoSync] Error during check: ${err.message}`);
    return false;
  }
}

let syncTimer = null;

/**
 * Start recurring 30-minute auto-sync loop.
 */
function startAutoSync(intervalMs = 30 * 60 * 1000) {
  if (syncTimer) clearInterval(syncTimer);

  logger.info('[AutoSync] ═══════════════════════════════════════════════════');
  logger.info('[AutoSync] AUTONOMOUS GITHUB SYNC SYSTEM INITIALIZED');
  logger.info('[AutoSync] ═══════════════════════════════════════════════════');
  logger.info('[AutoSync] Repository: https://github.com/sammysam254/flexpulse.git');
  logger.info('[AutoSync] Branch: main');
  logger.info('[AutoSync] Check interval: 30 minutes');
  logger.info('[AutoSync] First check: 30 seconds after startup');
  logger.info('[AutoSync] Auto-restart: Yes (on update detection)');
  logger.info('[AutoSync] ═══════════════════════════════════════════════════');

  // Initial check after 30 seconds of uptime
  setTimeout(() => {
    checkAndSyncGithub().catch(() => {});
  }, 30000);

  // Recurring 30-minute interval check
  syncTimer = setInterval(() => {
    checkAndSyncGithub().catch(() => {});
  }, intervalMs);
}

/**
 * Stop auto-sync loop.
 */
function stopAutoSync() {
  if (syncTimer) {
    clearInterval(syncTimer);
    syncTimer = null;
  }
}

module.exports = { startAutoSync, stopAutoSync, checkAndSyncGithub };
