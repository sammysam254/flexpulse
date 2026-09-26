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

function checkAndSyncGithub() {
  return new Promise((resolve) => {
    const gitBin = resolveGitBin();
    logger.info('[AutoSync] Checking GitHub for updates (30-min background sync)...');

    // 1. Fetch remote origin/main
    execFile(gitBin, ['fetch', 'origin', 'main'], { cwd: REPO_ROOT, timeout: 45000 }, (fetchErr) => {
      if (fetchErr) {
        logger.warn(`[AutoSync] git fetch notice: ${fetchErr.message}`);
        return resolve(false);
      }

      // 2. Compare local HEAD hash vs origin/main hash
      execFile(gitBin, ['rev-parse', 'HEAD'], { cwd: REPO_ROOT }, (err1, localHead) => {
        if (err1) return resolve(false);
        execFile(gitBin, ['rev-parse', 'origin/main'], { cwd: REPO_ROOT }, (err2, remoteHead) => {
          if (err2) return resolve(false);

          const localHash = (localHead || '').trim();
          const remoteHash = (remoteHead || '').trim();

          if (localHash && remoteHash && localHash !== remoteHash) {
            logger.info(`[AutoSync] New GitHub commit detected (${localHash.substring(0,7)} -> ${remoteHash.substring(0,7)}). Pulling changes silently...`);

            // 3. Pull changes cleanly into working copy
            execFile(gitBin, ['pull', '--ff-only', 'origin', 'main'], { cwd: REPO_ROOT, timeout: 45000 }, (pullErr) => {
              const onUpdateSuccess = () => {
                execFile(gitBin, ['clean', '-fd'], { cwd: REPO_ROOT }, () => {});
                try {
                  const wifiCache = path.join(REPO_ROOT, 'wifi-devices-cache.json');
                  if (fs.existsSync(wifiCache)) fs.unlinkSync(wifiCache);
                } catch (_) {}
                invalidateModuleCache();
                logger.info('[AutoSync] GitHub changes updated. Scheduling graceful restart in 3s so watchdog restarts clean runtime...');
                setTimeout(() => {
                  try {
                    const { app } = require('electron');
                    if (app && app.quit) app.quit();
                  } catch (_) {}
                  process.exit(0);
                }, 3000);
              };

              if (pullErr) {
                // Fallback to reset --hard origin/main if untracked changes exist
                execFile(gitBin, ['reset', '--hard', 'origin/main'], { cwd: REPO_ROOT }, (resetErr) => {
                  if (resetErr) {
                    logger.warn(`[AutoSync] git reset notice: ${resetErr.message}`);
                  } else {
                    onUpdateSuccess();
                  }
                  resolve(true);
                });
              } else {
                onUpdateSuccess();
                resolve(true);
              }
            });
          } else {
            logger.info('[AutoSync] Agent code is up to date with origin/main. Active device streams running smoothly.');
            resolve(false);
          }
        });
      });
    });
  });
}

let syncTimer = null;

/**
 * Start recurring 30-minute auto-sync loop.
 */
function startAutoSync(intervalMs = 30 * 60 * 1000) {
  if (syncTimer) clearInterval(syncTimer);

  // Initial check after 30 seconds of uptime
  setTimeout(() => {
    checkAndSyncGithub().catch(() => {});
  }, 30000);

  // Recurring 30-minute interval check
  syncTimer = setInterval(() => {
    checkAndSyncGithub().catch(() => {});
  }, intervalMs);

  logger.info('[AutoSync] Automatic 30-minute silent GitHub background synchronization initialized');
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
