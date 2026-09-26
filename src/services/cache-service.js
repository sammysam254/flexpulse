'use strict';

/**
 * ─── Flexpulse Redis Cache Service ───────────────────────────────────────────────
 * Upstash Redis via TLS (ioredis) with automatic in-memory fallback.
 * Wraps all hot-path Supabase reads behind a unified cache layer.
 *
 * TTL strategy (chosen for fast admin-reset propagation vs. DB load):
 *   credentials   : 30s   — device access pins/keys
 *   device_info   : 60s   — device model, status, stream_url
 *   rental_info   : 45s   — rental status, expiry
 *   license_status: 300s  — machine binding license (5 min)
 *   sync_state    : 900s  — last sync signature (15 min)
 */

const fs   = require('fs');
const path = require('path');
const logger = require('../utils/logger');

// ─── TTL constants ────────────────────────────────────────────────────────────
const TTL = {
  CREDENTIALS : 30,   // seconds
  DEVICE_INFO : 60,
  RENTAL_INFO : 45,
  LICENSE     : 300,
  SYNC_STATE  : 900,
};

// ─── Config loader ────────────────────────────────────────────────────────────
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

// ─── Upstash Redis connection ─────────────────────────────────────────────────
const REDIS_URL = process.env.REDIS_URL || 'redis://default:gQAAAAAABJ7pAAIgcDIyM2VmMzM0MmZhNTg0OGEwOTYzM2Q0NTBiZTI0MDRjMA@summary-elephant-302825.upstash.io:6379';

let redis      = null;
let redisReady = false;
let redisError = null;

function initRedis() {
  let Redis;
  try {
    Redis = require('ioredis');
  } catch (_) {
    logger.warn('[CacheService] ioredis not installed — using in-memory fallback only');
    return;
  }

  const cfg = loadConfig();
  const url = process.env.REDIS_URL || cfg.redisUrl || REDIS_URL;
  if (!url) {
    logger.info('[CacheService] No Redis URL configured — using in-memory cache');
    return;
  }

  try {
    redis = new Redis(url, {
      tls: {},
      connectTimeout: 6000,
      commandTimeout: 4000,
      maxRetriesPerRequest: 2,
      retryStrategy: (times) => {
        if (times > 5) return null;
        return Math.min(times * 500, 3000);
      },
      lazyConnect: true,
    });

    redis.on('connect',      ()  => { redisReady = true;  redisError = null; logger.info('[CacheService] Redis connected to Upstash'); });
    redis.on('ready',        ()  => { redisReady = true;  logger.info('[CacheService] Redis ready — hot-path caching active'); });
    redis.on('error',        (e) => { redisReady = false; redisError = e.message; logger.warn(`[CacheService] Redis error: ${e.message} — in-memory fallback active`); });
    redis.on('close',        ()  => { redisReady = false; logger.warn('[CacheService] Redis closed'); });
    redis.on('reconnecting', ()  => logger.info('[CacheService] Redis reconnecting...'));

    redis.connect().catch(() => {});
  } catch (err) {
    logger.warn(`[CacheService] Redis init error: ${err.message} — using in-memory`);
  }
}

initRedis();

// ─── In-memory fallback (TTL-respecting Map) ──────────────────────────────────
const memStore = new Map();

function memSet(key, value, ttlSec) {
  memStore.set(key, { value, expiresAt: Date.now() + ttlSec * 1000 });
}
function memGet(key) {
  const e = memStore.get(key);
  if (!e) return null;
  if (Date.now() > e.expiresAt) { memStore.delete(key); return null; }
  return e.value;
}
function memDel(key) { memStore.delete(key); }
function memDelPrefix(prefix) {
  for (const k of memStore.keys()) {
    if (k.startsWith(prefix)) memStore.delete(k);
  }
}

// Periodic cleanup every 2 minutes
setInterval(() => {
  const now = Date.now();
  for (const [k, e] of memStore.entries()) {
    if (now > e.expiresAt) memStore.delete(k);
  }
}, 120_000).unref();

// ─── Public API ───────────────────────────────────────────────────────────────

async function get(key) {
  try {
    if (redisReady && redis) {
      const raw = await redis.get(key);
      if (raw === null || raw === undefined) return null;
      try { return JSON.parse(raw); } catch (_) { return raw; }
    }
  } catch (err) {
    logger.warn(`[CacheService] Redis GET failed for ${key}: ${err.message}`);
  }
  const raw = memGet(key);
  if (raw === null) return null;
  try { return JSON.parse(raw); } catch (_) { return raw; }
}

async function set(key, value, ttlSec = TTL.DEVICE_INFO) {
  const serialised = JSON.stringify(value);
  try {
    if (redisReady && redis) {
      await redis.set(key, serialised, 'EX', ttlSec);
      // Warm in-memory for ultra-fast same-process reads (max 10s)
      memSet(key, serialised, Math.min(ttlSec, 10));
      return;
    }
  } catch (err) {
    logger.warn(`[CacheService] Redis SET failed for ${key}: ${err.message}`);
  }
  memSet(key, serialised, ttlSec);
}

async function del(key) {
  try { if (redisReady && redis) await redis.del(key); } catch (_) {}
  memDel(key);
}

async function delPattern(pattern) {
  try {
    if (redisReady && redis) {
      let cursor = '0';
      do {
        const [next, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 200);
        cursor = next;
        if (keys.length > 0) await redis.del(...keys);
      } while (cursor !== '0');
    }
  } catch (err) {
    logger.warn(`[CacheService] Redis SCAN/DEL error: ${err.message}`);
  }
  const prefix = pattern.replace(/\*$/, '');
  memDelPrefix(prefix);
}

/**
 * Invalidate ALL cached data for a device serial.
 * Call when an admin resets credentials or changes device settings.
 */
async function invalidateDevice(serial) {
  if (!serial) return;
  logger.info(`[CacheService] Invalidating cache for device ${serial}`);
  await Promise.all([
    delPattern(`cred:${serial}:*`),
    del(`device:${serial}`),
    del(`device:${serial}:assignments`),
    del(`device:${serial}:rentals`),
    del(`sync:${serial}`),
  ]);
}

async function flush() {
  try { if (redisReady && redis) await redis.flushdb(); } catch (_) {}
  memStore.clear();
  logger.info('[CacheService] Cache flushed');
}

function status() {
  return {
    redisReady,
    redisError,
    memStoreSize: memStore.size,
    backend: redisReady ? 'upstash-redis' : 'in-memory',
  };
}

module.exports = { get, set, del, delPattern, invalidateDevice, flush, status, TTL };
