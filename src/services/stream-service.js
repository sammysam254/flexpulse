'use strict';

const http = require('http');
const WebSocket = require('ws');
const { spawn, exec, execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
const logger = require('../utils/logger');
const ScrcpyEngine = require('./scrcpy-engine');
const bindingService = require('./binding-service');
const licenseService = require('./license-service');
const cache = require('./cache-service');

// ─── Config & ADB ────────────────────────────────────────────────────────────

function loadConfig() {
  for (const p of [path.join(process.cwd(), 'config.json'), path.join(__dirname, '..', '..', 'config.json')]) {
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf-8'));
  }
  return {};
}
const config = loadConfig();

function resolveAdbBin() {
  if (config.adbPath && fs.existsSync(config.adbPath)) return config.adbPath;
  const b = path.join(__dirname, '../../assets/bin/adb.exe');
  if (fs.existsSync(b)) return b;
  if (fs.existsSync('C:\\platform-tools\\adb.exe')) return 'C:\\platform-tools\\adb.exe';
  return 'adb';
}
const ADB_BIN = resolveAdbBin();

const activeServers = new Map();

// ─── Persistent ADB input shell (fallback when scrcpy not ready) ─────────────

const inputShells = new Map();
function getInputShell(serial) {
  const ex = inputShells.get(serial);
  if (ex && ex.stdin && !ex.stdin.destroyed) return ex;
  const p = spawn(ADB_BIN, ['-s', serial, 'shell'], { windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'] });
  if (p.stdin) try { p.stdin.setNoDelay(true); } catch (_) {}
  p.on('error', () => inputShells.delete(serial));
  p.on('close', () => inputShells.delete(serial));
  inputShells.set(serial, p);
  return p;
}
function adbInput(serial, cmd) {
  try { getInputShell(serial).stdin.write(cmd + '\n'); }
  catch (_) { exec(`"${ADB_BIN}" -s ${serial} shell ${cmd}`); }
}

// ─── Payment-blocked HTML ────────────────────────────────────────────────────

function getStreamBlockedHtml(serial, checkoutUrl, s = {}) {
  const fee = s.monthlyFee || 30;
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>Stream Blocked</title>
<style>*{margin:0;padding:0;box-sizing:border-box}body{background:#060911;color:#f8fafc;font-family:system-ui;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px}.card{background:#0f172a;border:1px solid rgba(239,68,68,.45);border-radius:24px;padding:40px 32px;max-width:520px;width:100%;text-align:center}.price{font-size:46px;font-weight:800;color:#38bdf8;margin:12px 0 4px}.btn{display:block;width:100%;padding:15px;background:linear-gradient(135deg,#ef4444,#dc2626);color:#fff;text-decoration:none;font-weight:700;border-radius:14px;font-size:15px;border:none;cursor:pointer;margin-top:16px}</style>
</head><body><div class="card">
<div style="font-size:28px;margin-bottom:12px">🔒</div>
<h2>Monthly Rental Payment Required</h2>
<div class="price">$${fee}.00 USD</div>
<p style="color:#94a3b8;margin:8px 0 16px">Device: <code>${serial}</code></p>
<a href="${checkoutUrl}" target="_blank" class="btn">💳 Pay to Unlock Stream</a>
<button onclick="location.reload()" class="btn" style="background:rgba(255,255,255,.08);color:#94a3b8;margin-top:8px">🔄 Refresh</button>
</div></body></html>`;
}

// ─── Screencap fallback (one-shot, for /screen.jpg HTTP endpoint) ────────────

function captureOneFrame(serial) {
  return new Promise((resolve) => {
    const p = spawn(ADB_BIN, ['-s', serial, 'exec-out', 'screencap -p'], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    const chunks = [];
    p.stdout.on('data', c => chunks.push(c));
    p.on('close', code => {
      if (code !== 0 || !chunks.length) return resolve(null);
      // exec-out via spawn stdio:pipe delivers clean binary — no CRLF stripping needed
      resolve(Buffer.concat(chunks));
    });
    p.on('error', () => resolve(null));
  });
}

// ─── Shared control dispatcher ────────────────────────────────────────────────

function get(data, key) {
  return typeof data.get === 'function' ? data.get(key) : data[key];
}

function handleControl(type, data, serial, engine) {
  const W = parseFloat(get(data, 'width'))  || engine.screenWidth  || 720;
  const H = parseFloat(get(data, 'height')) || engine.screenHeight || 1600;

  const realW = engine.screenWidth  || 720;
  const realH = engine.screenHeight || 1600;

  const ctrlOk = () => engine.controlSocket && !engine.controlSocket.destroyed;

  if (type === 'touch') {
    const action = parseInt(get(data, 'action'), 10);
    const x = parseFloat(get(data, 'x'));
    const y = parseFloat(get(data, 'y'));
    const ok = engine.sendTouchEvent(action, x, y, W, H);
    if (!ok && action === 0) {
      const sx = Math.round((x / W) * realW);
      const sy = Math.round((y / H) * realH);
      adbInput(serial, `input tap ${sx} ${sy}`);
    }
  } else if (type === 'tap') {
    const x = parseFloat(get(data, 'x')), y = parseFloat(get(data, 'y'));
    if (ctrlOk()) {
      engine.sendTouchEvent(0, x, y, W, H, 0.4);
      setTimeout(() => engine.sendTouchEvent(1, x, y, W, H, 0), 80);
    } else {
      const sx = Math.round((x / W) * realW);
      const sy = Math.round((y / H) * realH);
      adbInput(serial, `input tap ${sx} ${sy}`);
    }
  } else if (type === 'swipe') {
    const x1 = parseFloat(get(data, 'x1')), y1 = parseFloat(get(data, 'y1'));
    const x2 = parseFloat(get(data, 'x2')), y2 = parseFloat(get(data, 'y2'));
    const dur = Math.min(220, Math.max(70, parseInt(get(data, 'duration'), 10) || 120));

    if (!ctrlOk()) {
      const sx1 = Math.round((x1 / W) * realW), sy1 = Math.round((y1 / H) * realH);
      const sx2 = Math.round((x2 / W) * realW), sy2 = Math.round((y2 / H) * realH);
      adbInput(serial, `input swipe ${sx1} ${sy1} ${sx2} ${sy2} ${dur}`);
      return;
    }

    // Direct touch injection down immediately
    const downOk = engine.sendTouchEvent(0, x1, y1, W, H, 0.45);
    if (!downOk) {
      const sx1 = Math.round((x1 / W) * realW), sy1 = Math.round((y1 / H) * realH);
      const sx2 = Math.round((x2 / W) * realW), sy2 = Math.round((y2 / H) * realH);
      adbInput(serial, `input swipe ${sx1} ${sy1} ${sx2} ${sy2} ${dur}`);
      return;
    }

    // High-precision smooth swipe with cubic ease-out (fast initial flick, smooth glide)
    const steps = Math.max(8, Math.floor(dur / 12));
    const dt = dur / steps;
    for (let i = 1; i <= steps; i++) {
      setTimeout(() => {
        const progress = i / steps;
        const ease = 1 - Math.pow(1 - progress, 3);
        const currX = x1 + (x2 - x1) * ease;
        const currY = y1 + (y2 - y1) * ease;
        const action = (i === steps) ? 1 : 2; // UP on final step
        const pVal = (action === 1) ? 0 : 0.6;
        engine.sendTouchEvent(action, currX, currY, W, H, pVal);
      }, Math.round(i * dt));
    }
  } else if (type === 'code' || type === 'key') {
    const code = parseInt(get(data, 'code'), 10);
    if (ctrlOk()) {
      engine.sendKeycode(0, code);
      setTimeout(() => engine.sendKeycode(1, code), 50);
    } else {
      adbInput(serial, `input keyevent ${code}`);
    }
  } else if (type === 'text') {
    const text = get(data, 'text') || '';
    if (ctrlOk()) {
      engine.sendText(text);
    } else {
      const escaped = text.replace(/(["'`$\\!& |;()<>])/g, '\\$1');
      adbInput(serial, `input text ${escaped}`);
    }
  } else if (type === 'reboot') {
    exec(`"${ADB_BIN}" -s ${serial} reboot`);
  } else if (type === 'expand_notifications' || type === 'notifications') {
    exec(`"${ADB_BIN}" -s ${serial} shell cmd statusbar expand`);
  } else if (type === 'wake' || type === 'refresh') {
    try { adbInput(serial, 'input keyevent 224'); } catch (_) {}
  }
}


// ─── Server-Side Realtime Device Credential Verification (Redis-backed) ──────
const BRUTE_FORCE_LOCKS = new Map(); // key: ip_serial -> { attempts, lockedUntil }

async function verifyDeviceAccess(serial, inputCredential, candidateUserId = null, clientIp = 'unknown', candidateRole = null, isAdmin = false) {
  if (!serial) return { authorized: false, reason: 'Device UDID is required' };

  // 1. Admin Master Bypass: Administrators (admin, seed_admin, super_admin) can view and control all devices without needing a PIN
  if (isAdmin || ['admin', 'seed_admin', 'super_admin'].includes(candidateRole) || ['admin', 'seed_admin', 'super_admin'].includes(inputCredential)) {
    return { authorized: true, isAdmin: true };
  }

  const input = (inputCredential || '').trim();
  if (!input) {
    return { authorized: false, reason: 'Credential (PIN or access token) required. Please unlock from your account dashboard.' };
  }

  const lockKey = `${clientIp}_${serial}`;
  const now = Date.now();

  const recordFailure = () => {
    const current = BRUTE_FORCE_LOCKS.get(lockKey) || { attempts: 0, lockedUntil: 0 };
    current.attempts += 1;
    if (current.attempts >= 5) {
      current.lockedUntil = now + 2 * 60 * 1000; // 2 minute cooldown for repeated bad guesses
      logger.warn(`[StreamService] IP ${clientIp} exceeded 5 failed attempts for ${serial}. Locked for 2 mins.`);
    }
    BRUTE_FORCE_LOCKS.set(lockKey, current);
  };

  const recordSuccess = () => {
    BRUTE_FORCE_LOCKS.delete(lockKey);
  };

  // Check if currently locked out due to previous bad guesses
  const lock = BRUTE_FORCE_LOCKS.get(lockKey);
  if (lock && lock.lockedUntil && lock.lockedUntil > now) {
    const waitSec = Math.ceil((lock.lockedUntil - now) / 1000);
    return { authorized: false, reason: `Too many failed attempts. Device temporarily locked for ${waitSec}s.` };
  }

  // 2. High-speed multi-tier cache lookup (Redis / Memory) — 0 Supabase egress on repeat checks!
  const cacheKey = `dev_auth:${serial}`;
  let devRecord = null;
  try {
    devRecord = await cache.get(cacheKey);
  } catch (_) {}

  if (!devRecord) {
    const cfg = loadConfig();
    const supaUrl = cfg.supabaseUrl;
    const supaKey = cfg.supabaseServiceRoleKey || cfg.supabaseAnonKey;
    if (!supaUrl || !supaKey) {
      return { authorized: false, reason: 'Backend service configuration missing' };
    }

    try {
      // 1 single query fetching device record + device_assignments
      const fetchUrl = `${supaUrl.replace(/\/$/, '')}/rest/v1/devices?select=id,status,stream_url,binding_code,device_assignments(id,assigned_to_user_id,access_password)&serial=eq.${encodeURIComponent(serial)}&limit=1`;
      const devRes = await fetch(fetchUrl, {
        headers: { apikey: supaKey, Authorization: `Bearer ${supaKey}` }
      });
      if (!devRes.ok) {
        recordFailure();
        return { authorized: false, reason: 'Device authorization lookup failed' };
      }
      const rows = await devRes.json();
      if (!Array.isArray(rows) || rows.length === 0) {
        recordFailure();
        return { authorized: false, reason: 'Device not recognized on this server' };
      }
      devRecord = rows[0];

      // Also fetch rentals in parallel ONLY if present
      try {
        const rRes = await fetch(
          `${supaUrl.replace(/\/$/, '')}/rest/v1/device_rentals?serial_number=${encodeURIComponent(serial)}&status=in.(active,paid)&select=id,user_id,stream_url,expires_at`,
          { headers: { apikey: supaKey, Authorization: `Bearer ${supaKey}` } }
        );
        if (rRes.ok) {
          devRecord.rentals = await rRes.json();
        }
      } catch (_) {}

      // Cache for 20 seconds: fast propagation of unallocation/revocation with near-zero Supabase egress!
      try {
        await cache.set(cacheKey, devRecord, 20);
      } catch (_) {}
    } catch (err) {
      logger.warn(`[StreamService] Supabase fetch error for ${serial}: ${err.message}`);
      return { authorized: false, reason: 'Database connection error' };
    }
  }

  // 3. Verify Device Status
  const devStatus = devRecord.status || 'online';
  if (devStatus === 'suspended' || devStatus === 'blocked' || devStatus === 'revoked') {
    return { authorized: false, reason: `Device stream is currently ${devStatus} by administrator.` };
  }

  // 4. Verify Active Allocations / Assignments
  const assignments = Array.isArray(devRecord.device_assignments) ? devRecord.device_assignments : [];
  const rentals = Array.isArray(devRecord.rentals) ? devRecord.rentals : [];

  // Check if device is completely UNALLOCATED
  if (assignments.length === 0 && rentals.length === 0) {
    const currentStreamUrl = devRecord.stream_url || '';
    const matchPin = currentStreamUrl.match(/[?&]pin=([^&]+)/i);
    const fallbackPin = matchPin ? decodeURIComponent(matchPin[1]).trim() : null;
    const isBindingMatch = devRecord.binding_code && (input === String(devRecord.binding_code).trim() || input === String(devRecord.binding_code).slice(-4));

    if (!fallbackPin || (fallbackPin !== input && !isBindingMatch)) {
      recordFailure();
      return {
        authorized: false,
        reason: 'This device is currently unallocated. Please contact an administrator or access from your account.'
      };
    }
  }

  // Check matching credential against assignments
  let matchingAssignment = null;
  if (assignments.length > 0) {
    matchingAssignment = assignments.find(a => a.access_password && String(a.access_password).trim() === input);
  }

  // Check matching credential against rentals
  let matchingRental = null;
  if (rentals.length > 0) {
    matchingRental = rentals.find(r => {
      const isExpired = r.expires_at && new Date(r.expires_at) < new Date();
      if (isExpired) return false;
      const rUrl = r.stream_url || '';
      const rPin = rUrl.match(/[?&]pin=([^&]+)/i);
      const rKey = rUrl.match(/[?&]key=([^&]+)/i);
      const rToken = rUrl.match(/[?&]token=([^&]+)/i);
      return (
        (rPin && decodeURIComponent(rPin[1]).trim() === input) ||
        (rKey && decodeURIComponent(rKey[1]).trim() === input) ||
        (rToken && decodeURIComponent(rToken[1]).trim() === input)
      );
    });
  }

  // Check fallback stream_url on devices table
  let isFallbackMatch = false;
  const currentStreamUrl = devRecord.stream_url || '';
  const matchPin = currentStreamUrl.match(/[?&]pin=([^&]+)/i);
  const matchKey = currentStreamUrl.match(/[?&]key=([^&]+)/i);
  if (matchPin && decodeURIComponent(matchPin[1]).trim() === input) isFallbackMatch = true;
  if (matchKey && decodeURIComponent(matchKey[1]).trim().toLowerCase() === input.toLowerCase()) isFallbackMatch = true;
  const isBindingMatch = devRecord.binding_code && (input === String(devRecord.binding_code).trim() || input === String(devRecord.binding_code).slice(-4));

  if (!matchingAssignment && !matchingRental && !isFallbackMatch && !isBindingMatch) {
    recordFailure();
    return {
      authorized: false,
      reason: 'Invalid or expired stream PIN/token. Please verify credentials in your account dashboard.'
    };
  }

  // 5. User Ownership Confirmation:
  // If candidateUserId is provided, verify it matches the assigned user!
  const assignedUserId = matchingAssignment
    ? matchingAssignment.assigned_to_user_id
    : (matchingRental ? matchingRental.user_id : null);

  if (candidateUserId && assignedUserId && assignedUserId !== 'RENTAL_USER_DEFAULT') {
    if (candidateUserId !== assignedUserId) {
      logger.warn(`[StreamService] Security violation: requesting user ${candidateUserId} != assigned user ${assignedUserId} for ${serial}`);
      recordFailure();
      return {
        authorized: false,
        reason: 'Access Denied: This device is allocated to another user account.'
      };
    }
  }

  recordSuccess();
  return {
    authorized: true,
    assignedUserId: assignedUserId || candidateUserId || null,
  };
}

// ─── 5 Auto-Sliding Cards Presentation (Vertex Digital) ─────────────────────

function buildVertexCardsHtml(serial, attemptedCredential, isRevokedOrInvalid, customNotice) {
  const prefillSerial = serial ? serial.replace(/"/g, '&quot;') : '';
  const statusMessage = customNotice || (isRevokedOrInvalid 
    ? 'Access credentials for this device were revoked or reset by an administrator. Please provide an active PIN.'
    : 'Direct device authorization required. Individual streams are protected by dynamic cryptographic verification.');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Vertex Digital — Enterprise Systems &amp; Management</title>
  <style>
    *, *::before, *::after { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      min-height: 100vh;
      background: radial-gradient(circle at 50% 15%, #0f1c3f 0%, #060913 100%);
      color: #f8fafc;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 24px 16px;
      overflow-x: hidden;
    }

    .container {
      width: 100%;
      max-width: 680px;
      display: flex;
      flex-direction: column;
      gap: 20px;
      align-items: center;
    }

    /* Top Brand Header */
    .brand-bar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      width: 100%;
      padding: 12px 20px;
      background: rgba(15, 23, 42, 0.7);
      backdrop-filter: blur(12px);
      border: 1px solid rgba(56, 189, 248, 0.2);
      border-radius: 14px;
    }
    .brand-left {
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .status-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: #38bdf8;
      box-shadow: 0 0 10px #38bdf8;
    }
    .brand-name {
      font-size: 13px;
      font-weight: 700;
      letter-spacing: 1px;
      color: #f8fafc;
    }
    .brand-contact {
      font-size: 13px;
      font-weight: 600;
      color: #38bdf8;
      text-decoration: none;
      letter-spacing: 0.3px;
    }
    .brand-contact:hover {
      text-decoration: underline;
    }

    /* Notice Banner if access was revoked/reset */
    .notice-banner {
      width: 100%;
      padding: 12px 16px;
      background: rgba(225, 29, 72, 0.12);
      border: 1px solid rgba(225, 29, 72, 0.3);
      border-radius: 12px;
      font-size: 13px;
      color: #fda4af;
      line-height: 1.5;
      text-align: center;
    }

    /* 5-Card Auto-Sliding Carousel */
    .carousel-wrapper {
      position: relative;
      width: 100%;
      background: rgba(15, 23, 42, 0.85);
      backdrop-filter: blur(20px);
      border: 1px solid rgba(56, 189, 248, 0.25);
      border-radius: 22px;
      box-shadow: 0 25px 60px -15px rgba(0, 0, 0, 0.8), 0 0 40px rgba(37, 99, 235, 0.15);
      overflow: hidden;
      min-height: 320px;
    }

    .carousel-viewport {
      width: 100%;
      overflow: hidden;
      position: relative;
      min-height: 270px;
    }

    .carousel-track {
      display: flex;
      transition: transform 0.6s cubic-bezier(0.22, 1, 0.36, 1);
      width: 500%;
    }

    .carousel-slide {
      width: 20%;
      padding: 38px 36px 20px;
      display: flex;
      flex-direction: column;
      justify-content: space-between;
      user-select: none;
    }

    .slide-badge {
      display: inline-flex;
      align-items: center;
      padding: 4px 12px;
      border-radius: 9999px;
      background: rgba(56, 189, 248, 0.1);
      border: 1px solid rgba(56, 189, 248, 0.25);
      color: #38bdf8;
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.8px;
      text-transform: uppercase;
      margin-bottom: 16px;
      align-self: flex-start;
    }

    .slide-title {
      font-size: 24px;
      font-weight: 800;
      color: #ffffff;
      letter-spacing: -0.4px;
      line-height: 1.3;
      margin-bottom: 14px;
    }

    .slide-text {
      font-size: 14px;
      line-height: 1.7;
      color: #94a3b8;
      margin-bottom: 22px;
    }

    .slide-footer {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      padding-top: 14px;
      border-top: 1px solid rgba(255, 255, 255, 0.08);
    }

    .info-pill {
      font-size: 12px;
      font-weight: 600;
      padding: 6px 12px;
      border-radius: 8px;
      background: rgba(30, 41, 59, 0.7);
      border: 1px solid rgba(148, 163, 184, 0.15);
      color: #cbd5e1;
    }
    .info-pill.highlight {
      background: rgba(37, 99, 235, 0.2);
      border-color: rgba(56, 189, 248, 0.35);
      color: #38bdf8;
    }

    /* Carousel Controls & Dots */
    .carousel-bottom {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 14px 28px 20px;
      border-top: 1px solid rgba(255, 255, 255, 0.06);
    }

    .carousel-dots {
      display: flex;
      gap: 8px;
    }

    .dot-btn {
      width: 24px;
      height: 6px;
      border-radius: 4px;
      background: rgba(148, 163, 184, 0.25);
      border: none;
      cursor: pointer;
      transition: all 0.3s ease;
      padding: 0;
    }
    .dot-btn.active {
      width: 38px;
      background: #38bdf8;
      box-shadow: 0 0 10px rgba(56, 189, 248, 0.6);
    }

    .nav-arrows {
      display: flex;
      gap: 8px;
    }

    .arrow-btn {
      width: 32px;
      height: 32px;
      border-radius: 8px;
      background: rgba(255, 255, 255, 0.06);
      border: 1px solid rgba(255, 255, 255, 0.12);
      color: #f8fafc;
      font-size: 14px;
      font-weight: 700;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: all 0.2s;
    }
    .arrow-btn:hover {
      background: rgba(56, 189, 248, 0.2);
      border-color: #38bdf8;
      color: #38bdf8;
    }

    /* Unlock Form at bottom */
    .auth-card {
      width: 100%;
      padding: 22px 28px;
      background: rgba(15, 23, 42, 0.75);
      backdrop-filter: blur(16px);
      border: 1px solid rgba(148, 163, 184, 0.15);
      border-radius: 18px;
    }

    .auth-title {
      font-size: 13px;
      font-weight: 700;
      letter-spacing: 0.5px;
      text-transform: uppercase;
      color: #94a3b8;
      margin-bottom: 12px;
    }

    .auth-form {
      display: flex;
      gap: 10px;
    }

    .auth-input {
      flex: 1;
      background: rgba(30, 41, 59, 0.7);
      border: 1px solid rgba(148, 163, 184, 0.2);
      border-radius: 10px;
      padding: 12px 16px;
      font-size: 14px;
      color: #ffffff;
      outline: none;
      transition: all 0.2s;
    }
    .auth-input:focus {
      border-color: #38bdf8;
      box-shadow: 0 0 0 2px rgba(56, 189, 248, 0.2);
    }

    .auth-submit {
      background: linear-gradient(135deg, #2563eb 0%, #1d4ed8 100%);
      border: none;
      border-radius: 10px;
      padding: 12px 22px;
      font-size: 14px;
      font-weight: 700;
      color: #ffffff;
      cursor: pointer;
      transition: all 0.2s;
      white-space: nowrap;
    }
    .auth-submit:hover {
      background: linear-gradient(135deg, #3b82f6 0%, #2563eb 100%);
      transform: translateY(-1px);
    }

    .call-btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      width: 100%;
      margin-top: 10px;
      padding: 11px 18px;
      border-radius: 10px;
      background: rgba(30, 41, 59, 0.6);
      border: 1px solid rgba(56, 189, 248, 0.3);
      color: #38bdf8;
      font-size: 13px;
      font-weight: 700;
      text-decoration: none;
      transition: all 0.2s;
    }
    .call-btn:hover {
      background: rgba(56, 189, 248, 0.15);
      border-color: #38bdf8;
    }

    @media (max-width: 600px) {
      .carousel-slide { padding: 26px 20px 16px; }
      .slide-title { font-size: 20px; }
      .auth-form { flex-direction: column; }
    }
  </style>
</head>
<body>
  <div class="container">

    <!-- Top Header Bar -->
    <div class="brand-bar">
      <div class="brand-left">
        <span class="status-dot"></span>
        <span class="brand-name">VERTEX DIGITAL</span>
      </div>
      <a href="tel:0706499848" class="brand-contact">Call 0706499848</a>
    </div>

    <!-- Notice Banner -->
    <div class="notice-banner">
      ${statusMessage}
    </div>

    <!-- 5 Auto-Sliding Cards Carousel -->
    <div class="carousel-wrapper" id="carouselWrapper">
      <div class="carousel-viewport">
        <div class="carousel-track" id="track">

          <!-- Card 1: System Management & Infrastructure -->
          <div class="carousel-slide">
            <div>
              <span class="slide-badge">SYSTEM MANAGEMENT &amp; INFRASTRUCTURE</span>
              <h2 class="slide-title">Designed &amp; Managed by Vertex Digital</h2>
              <p class="slide-text">This system is designed and managed by Vertex Digital. Call 0706499848 for softwares and systems. Complete platform orchestration, device monitoring, and high-availability operations managed by lead developer Sam.</p>
            </div>
            <div class="slide-footer">
              <span class="info-pill highlight">Developer: Sam</span>
              <span class="info-pill highlight">Call: 0706499848</span>
              <span class="info-pill">Vertex Digital</span>
            </div>
          </div>

          <!-- Card 2: Mobile Device Virtualization -->
          <div class="carousel-slide">
            <div>
              <span class="slide-badge">MOBILE DEVICE VIRTUALIZATION</span>
              <h2 class="slide-title">Low-Latency Hardware Streaming</h2>
              <p class="slide-text">This system is designed and managed by Vertex Digital. Call 0706499848 for softwares and systems. Featuring sub-second H.264 video encoding, dynamic touch relays, and multi-node hardware clustering developed by Sam.</p>
            </div>
            <div class="slide-footer">
              <span class="info-pill highlight">Developer: Sam</span>
              <span class="info-pill highlight">Call: 0706499848</span>
              <span class="info-pill">Hardware Virtualization</span>
            </div>
          </div>

          <!-- Card 3: Dynamic Access Control & Security -->
          <div class="carousel-slide">
            <div>
              <span class="slide-badge">DYNAMIC ACCESS CONTROL &amp; SECURITY</span>
              <h2 class="slide-title">Server-Side Token Verification</h2>
              <p class="slide-text">This system is designed and managed by Vertex Digital. Call 0706499848 for softwares and systems. Protected by server-side verification: when an administrator resets credentials, unauthorized access is instantly terminated.</p>
            </div>
            <div class="slide-footer">
              <span class="info-pill highlight">Developer: Sam</span>
              <span class="info-pill highlight">Call: 0706499848</span>
              <span class="info-pill">Real-Time Revocation</span>
            </div>
          </div>

          <!-- Card 4: Custom Web & Cloud Platforms -->
          <div class="carousel-slide">
            <div>
              <span class="slide-badge">CUSTOM WEB &amp; CLOUD PLATFORMS</span>
              <h2 class="slide-title">Enterprise Software Development</h2>
              <p class="slide-text">This system is designed and managed by Vertex Digital. Call 0706499848 for softwares and systems. Full-stack cloud web applications, automated subscriber portals, and enterprise microservices engineered by Sam.</p>
            </div>
            <div class="slide-footer">
              <span class="info-pill highlight">Developer: Sam</span>
              <span class="info-pill highlight">Call: 0706499848</span>
              <span class="info-pill">Enterprise Software</span>
            </div>
          </div>

          <!-- Card 5: Engineering Consultation & Systems -->
          <div class="carousel-slide">
            <div>
              <span class="slide-badge">ENGINEERING CONSULTATION &amp; SYSTEMS</span>
              <h2 class="slide-title">Direct Technical Consultation</h2>
              <p class="slide-text">This system is designed and managed by Vertex Digital. Call 0706499848 for softwares and systems. Contact developer Sam directly at 0706499848 for custom software architecture, system integration, and commercial platforms.</p>
            </div>
            <div class="slide-footer">
              <span class="info-pill highlight">Developer: Sam</span>
              <span class="info-pill highlight">Call: 0706499848</span>
              <span class="info-pill">Systems Architecture</span>
            </div>
          </div>

        </div>
      </div>

      <!-- Controls and Indicators -->
      <div class="carousel-bottom">
        <div class="carousel-dots" id="dots">
          <button class="dot-btn active" onclick="goToSlide(0)"></button>
          <button class="dot-btn" onclick="goToSlide(1)"></button>
          <button class="dot-btn" onclick="goToSlide(2)"></button>
          <button class="dot-btn" onclick="goToSlide(3)"></button>
          <button class="dot-btn" onclick="goToSlide(4)"></button>
        </div>
        <div class="nav-arrows">
          <button class="arrow-btn" onclick="prevSlide()">&larr;</button>
          <button class="arrow-btn" onclick="nextSlide()">&rarr;</button>
        </div>
      </div>
    </div>

    <!-- Authorized Access Form -->
    <div class="auth-card">
      <div class="auth-title">Authorized Device Stream Access</div>
      <form class="auth-form" onsubmit="handleUnlock(event)">
        <input 
          type="text" 
          id="udidField" 
          class="auth-input" 
          placeholder="Device UDID" 
          value="${prefillSerial}" 
          required 
          autocomplete="off" 
        />
        <input 
          type="password" 
          id="pinField" 
          class="auth-input" 
          placeholder="Current Stream PIN / Key" 
          required 
          autocomplete="off" 
        />
        <button type="submit" class="auth-submit">Connect</button>
      </form>
      <a href="tel:0706499848" class="call-btn">Contact Developer Sam: 0706499848</a>
    </div>

  </div>

  <script>
    let currentSlide = 0;
    const totalSlides = 5;
    const track = document.getElementById('track');
    const dots = document.querySelectorAll('.dot-btn');
    let autoSlideInterval = null;

    function updateCarousel() {
      track.style.transform = 'translateX(-' + (currentSlide * 20) + '%)';
      dots.forEach((dot, index) => {
        if (index === currentSlide) dot.classList.add('active');
        else dot.classList.remove('active');
      });
    }

    function goToSlide(index) {
      currentSlide = (index + totalSlides) % totalSlides;
      updateCarousel();
    }

    function nextSlide() {
      goToSlide(currentSlide + 1);
    }

    function prevSlide() {
      goToSlide(currentSlide - 1);
    }

    function startAutoSlide() {
      stopAutoSlide();
      autoSlideInterval = setInterval(nextSlide, 4500);
    }

    function stopAutoSlide() {
      if (autoSlideInterval) clearInterval(autoSlideInterval);
    }

    const wrapper = document.getElementById('carouselWrapper');
    wrapper.addEventListener('mouseenter', stopAutoSlide);
    wrapper.addEventListener('mouseleave', startAutoSlide);

    startAutoSlide();

    function handleUnlock(e) {
      e.preventDefault();
      const udid = document.getElementById('udidField').value.trim();
      const pin = document.getElementById('pinField').value.trim();
      if (!udid || !pin) return;
      const urlParams = new URLSearchParams(window.location.search);
      const userId = urlParams.get('user_id') || urlParams.get('uid') || '';
      const role = urlParams.get('role') || '';
      let targetUrl = '/?udid=' + encodeURIComponent(udid) + '&pin=' + encodeURIComponent(pin);
      if (userId) targetUrl += '&user_id=' + encodeURIComponent(userId);
      if (role) targetUrl += '&role=' + encodeURIComponent(role);
      window.location.href = targetUrl;
    }
  </script>
</body>
</html>`;
}

// ─── Player HTML (WebCodecs H264 decoder + screencap fallback) ───────────────

function buildPlayerHtml(serial, screenW, screenH) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
  <title>Stream ${serial}</title>
  <style>
    *,*::before,*::after{margin:0;padding:0;box-sizing:border-box}
    html,body{height:100%;background:#04060a;color:#f8fafc;font-family:system-ui;overflow:hidden}
    body{display:flex;flex-direction:column;align-items:center;padding:0;user-select:none;-webkit-user-select:none;-webkit-tap-highlight-color:transparent}
    
    /* Top Header Bar inside window */
    .header{display:flex;align-items:center;justify-content:space-between;width:100%;padding:8px 12px;background:rgba(15,23,42,.95);border-bottom:1px solid rgba(255,255,255,.1);flex-shrink:0;z-index:10}
    .hdr-left{display:flex;align-items:center;gap:10px}
    .hdr-title{font-weight:700;font-size:14px;color:#f8fafc;letter-spacing:.3px}
    .hdr-btn{background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.15);color:#f8fafc;border-radius:8px;width:32px;height:32px;display:flex;align-items:center;justify-content:center;font-size:15px;cursor:pointer;transition:all .15s ease}
    .hdr-btn:hover{background:rgba(56,189,248,.25);border-color:rgba(56,189,248,.5);color:#38bdf8}
    .hdr-btn:active{transform:scale(.92)}

    .badge{background:rgba(56,189,248,.15);color:#38bdf8;border:1px solid rgba(56,189,248,.3);padding:3px 10px;border-radius:100px;font-size:11px;font-weight:700;display:flex;align-items:center;gap:5px}
    .dot{width:6px;height:6px;background:#38bdf8;border-radius:50%;animation:pulse 1s infinite}
    @keyframes pulse{0%,100%{opacity:1}50%{opacity:.3}}

    .stage{flex:1;display:flex;align-items:center;justify-content:center;gap:10px;width:100%;min-height:0;padding:8px}
    .wrap{position:relative;background:#000;border-radius:18px;border:2px solid rgba(56,189,248,.4);box-shadow:0 0 30px rgba(56,189,248,.2);overflow:hidden;touch-action:none;flex-shrink:0;-webkit-tap-highlight-color:transparent}
    canvas{display:block;max-height:calc(100vh - 60px);width:auto;cursor:default;touch-action:none;-webkit-tap-highlight-color:transparent}

    /* Sidebar ALWAYS on the right side */
    .sidebar{display:flex !important;flex-direction:column;align-items:center;gap:5px;background:rgba(15,23,42,.95);border:1px solid rgba(255,255,255,.12);border-radius:14px;padding:8px 5px;max-height:calc(100vh - 52px);overflow-y:auto;flex-shrink:0;box-shadow:0 10px 25px rgba(0,0,0,.5);z-index:10}
    .btn{width:36px;height:36px;background:rgba(255,255,255,.07);border:1px solid rgba(255,255,255,.12);color:#f1f5f9;border-radius:9px;display:flex;align-items:center;justify-content:center;font-size:15px;cursor:pointer;transition:all .15s ease;user-select:none}
    .btn:hover{background:rgba(56,189,248,.25);border-color:rgba(56,189,248,.5);color:#38bdf8}
    .btn:active{transform:scale(.88)}
    .btn-red{background:rgba(248,113,113,.12);color:#f87171;border-color:rgba(248,113,113,.3)}
    .btn-red:hover{background:rgba(248,113,113,.3);border-color:rgba(248,113,113,.6);color:#ef4444}
    
    .vol-slider-box{display:flex;flex-direction:column;align-items:center;justify-content:center;padding:6px 0 2px;width:100%}
    .volume-slider-v{-webkit-appearance:slider-vertical;appearance:slider-vertical;writing-mode:bt-lr;width:6px;height:75px;background:rgba(255,255,255,.15);border-radius:4px;outline:none;cursor:pointer;accent-color:#22c55e}

    .modal{display:none;position:fixed;inset:0;background:rgba(0,0,0,.75);backdrop-filter:blur(6px);z-index:20;align-items:center;justify-content:center}
    .mbox{background:#0f172a;border:1px solid rgba(56,189,248,.4);border-radius:14px;padding:18px;width:90%;max-width:380px;box-shadow:0 20px 30px rgba(0,0,0,.6)}
    .minput{width:100%;padding:9px 12px;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.15);border-radius:9px;color:#fff;font-size:14px;margin-bottom:12px;outline:none}
    .mbtn{width:100%;padding:9px;background:#38bdf8;color:#0f172a;border:none;border-radius:9px;font-weight:700;cursor:pointer}

    .mobile-nav{display:none !important}
    .stage{flex:1;display:flex;flex-direction:row !important;align-items:center;justify-content:center;gap:10px;width:100%;min-height:0;padding:6px 10px}
    canvas{display:block;max-height:calc(100vh - 55px);max-width:calc(100vw - 65px);width:auto;height:auto;cursor:default;touch-action:none;-webkit-tap-highlight-color:transparent}
  </style>
</head>
<body>

<!-- Header Bar -->
<div class="header">
  <div class="hdr-left">
    <button tabindex="-1" onfocus="this.blur()" class="hdr-btn" onclick="if(history.length>1)history.back();else window.close()" title="Back">&#x2190;</button>
    <div class="hdr-title" id="hdrTitle">Stream ${serial}</div>
  </div>
  <div style="display:flex;align-items:center;gap:8px">
    <button tabindex="-1" onfocus="this.blur()" class="hdr-btn" onclick="reconnectStream()" title="Refresh Stream"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"/></svg></button>
    <button tabindex="-1" onfocus="this.blur()" class="hdr-btn" onclick="toggleDebugModal()" title="Stream Diagnostics"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg></button>
    <button tabindex="-1" onfocus="this.blur()" class="hdr-btn" onclick="popOutWindow()" title="Pop Out Chrome Window"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg></button>
    <div class="badge" id="badge"><span class="dot"></span><span id="modeText">CONNECTING</span></div>
    <span style="font-size:10px;color:#64748b;font-family:monospace" id="fps">--fps</span>
  </div>
</div>

<div class="stage">
  <div class="wrap" id="wrap">
    <canvas id="c" width="${screenW}" height="${screenH}"></canvas>
  </div>

  <!-- Sleek Dark Control Sidebar (Right Side) -->
  <div class="sidebar">
    <button tabindex="-1" onfocus="this.blur()" class="btn" onclick="expandNotifications()" title="Notification Bar"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="5" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="12" cy="19" r="1.5"/></svg></button>
    <button tabindex="-1" onfocus="this.blur()" class="btn btn-red" onclick="key(26)" title="Power"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M18.36 6.64a9 9 0 1 1-12.73 0"/><line x1="12" y1="2" x2="12" y2="12"/></svg></button>
    <button tabindex="-1" onfocus="this.blur()" class="btn btn-red" onclick="reboot()" title="Reboot Device"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M23 4v6h-6"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg></button>
    <button tabindex="-1" onfocus="this.blur()" class="btn btn-red" onclick="rotateScreen()" title="Rotate Screen"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"/></svg></button>
    <button tabindex="-1" onfocus="this.blur()" class="btn" onclick="key(24)" title="Volume Up"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="19" y1="12" x2="19" y2="12"/><line x1="15" y1="9" x2="15" y2="15"/><line x1="12" y1="12" x2="18" y2="12"/></svg></button>
    <button tabindex="-1" onfocus="this.blur()" class="btn" onclick="key(25)" title="Volume Down"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="15" y1="12" x2="20" y2="12"/></svg></button>
    <button tabindex="-1" onfocus="this.blur()" class="btn" onclick="key(4)" title="Back"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="15 18 9 12 15 6"/></svg></button>
    <button tabindex="-1" onfocus="this.blur()" class="btn" onclick="key(3)" title="Home"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="9"/></svg></button>
    <button tabindex="-1" onfocus="this.blur()" class="btn" onclick="key(187)" title="Recents"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><rect x="4" y="4" width="16" height="16" rx="2"/></svg></button>
    <button tabindex="-1" onfocus="this.blur()" class="btn" onclick="screenshot()" title="Screenshot"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg></button>
    <button tabindex="-1" onfocus="this.blur()" class="btn" onclick="openText()" title="Send Text"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><rect x="2" y="4" width="20" height="16" rx="2"/><line x1="6" y1="8" x2="6.01" y2="8"/><line x1="10" y1="8" x2="10.01" y2="8"/><line x1="14" y1="8" x2="14.01" y2="8"/><line x1="18" y1="8" x2="18.01" y2="8"/><line x1="7" y1="16" x2="17" y2="16"/></svg></button>
    <button tabindex="-1" onfocus="this.blur()" class="btn" onclick="openUpload()" title="Upload File"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg></button>
    <button tabindex="-1" onfocus="this.blur()" class="btn" id="muteBtn" onclick="toggleMute()" title="Audio Mute/Unmute"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/></svg></button>
    
    <!-- Vertical Green Volume Slider -->
    <div class="vol-slider-box" title="Volume Slider">
      <input tabindex="-1" onfocus="this.blur()" type="range" min="0" max="100" value="100" class="volume-slider-v" id="volSlider" oninput="setVolume(this.value)"/>
    </div>
  </div>
</div>

<div class="modal" id="textModal">
  <div class="mbox">
    <div style="font-weight:700;margin-bottom:10px">Send Text</div>
    <input class="minput" id="textVal" placeholder="Type here..." onkeydown="if(event.key==='Enter')doText()"/>
    <button class="mbtn" onclick="doText()">Send</button>
  </div>
</div>
<div class="modal" id="uploadModal">
  <div class="mbox">
    <div style="font-weight:700;margin-bottom:10px">Upload to Phone</div>
    <input class="minput" type="file" id="filePick" accept="image/*,video/*"/>
    <button class="mbtn" onclick="doUpload()">Upload</button>
  </div>
</div>

<div class="modal" id="debugModal">
  <div class="mbox">
    <div style="font-weight:700;margin-bottom:12px;display:flex;justify-content:space-between;align-items:center">
      <span>🐞 Stream Diagnostics</span>
      <button onclick="document.getElementById('debugModal').style.display='none'" style="background:none;border:none;color:#94a3b8;font-size:18px;cursor:pointer">&times;</button>
    </div>
    <div style="display:flex;flex-direction:column;gap:8px;font-size:13px;color:#94a3b8">
      <div>Device Serial: <strong style="color:#fff">${serial}</strong></div>
      <div>Stream Resolution: <strong style="color:#38bdf8" id="dbgRes">--</strong></div>
      <div>Decoder Engine: <strong style="color:#34d399" id="dbgCodec">--</strong></div>
      <div>WebSocket State: <strong style="color:#c084fc" id="dbgWs">--</strong></div>
    </div>
  </div>
</div>

<script>
  const canvas = document.getElementById('c');
  const ctx    = canvas.getContext('2d', { alpha: false, desynchronized: true });
  const wrap   = document.getElementById('wrap');
  const badge  = document.getElementById('badge');
  const modeText = document.getElementById('modeText');
  const fpsEl  = document.getElementById('fps');

  let nativeW = ${screenW}, nativeH = ${screenH};

  // ── FPS counter ─────────────────────────────────────────────────────────
  let fc = 0, fpsT = performance.now();
  function countFrame() {
    fc++;
    const now = performance.now();
    if (now - fpsT >= 1000) { fpsEl.textContent = fc + 'fps'; fc = 0; fpsT = now; }
  }

  // ── rAF draw queue ───────────────────────────────────────────────────────
  let pendingFrame = null, rafId = null;
  function queueDraw(bitmapOrImage) {
    if (pendingFrame && pendingFrame.close) pendingFrame.close();
    pendingFrame = bitmapOrImage;
    if (!rafId) rafId = requestAnimationFrame(doDraw);
  }
  function doDraw() {
    rafId = null;
    if (!pendingFrame) return;
    const f = pendingFrame; pendingFrame = null;
    const w = f.displayWidth  || f.codedWidth  || f.width;
    const h = f.displayHeight || f.codedHeight || f.height;
    if (w && h && (canvas.width !== w || canvas.height !== h)) {
      canvas.width = w; canvas.height = h; nativeW = w; nativeH = h;
      console.log('[Canvas] Resized to ' + w + 'x' + h);
    }
    ctx.drawImage(f, 0, 0, canvas.width, canvas.height);
    if (f.close) f.close();
    countFrame();
  }

  // ── Audio — WebCodecs AudioDecoder (Opus) with raw PCM fallback ────────────
  let audioCtx = null;
  let audioDecoder = null;
  let audioDecoderReady = false;
  let audioNextPlayTime = 0;
  const urlParams = new URLSearchParams(window.location.search);
  let isMuted = urlParams.get('muted') === '1' || urlParams.get('muted') === 'true';
  let gainNode = null;

  function initAudio() {
    if (audioCtx) {
      if (audioCtx.state === 'suspended') audioCtx.resume().catch(function() {});
      return;
    }
    try {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 48000, latencyHint: 'interactive' });
      gainNode = audioCtx.createGain();
      gainNode.gain.value = isMuted ? 0 : 1;
      gainNode.connect(audioCtx.destination);
      if (audioCtx.state === 'suspended') audioCtx.resume().catch(function() {});
    } catch (_) {}
  }

  function initOpusDecoder() {
    if (audioDecoderReady) return true;
    if (typeof AudioDecoder === 'undefined') return false;
    try {
      let layoutDetected = false;
      let isPlanar = false;

      audioDecoder = new AudioDecoder({
        output: function(audioData) {
          if (!audioCtx || !gainNode) { audioData.close(); return; }
          try {
            const nCh     = audioData.numberOfChannels;
            const nFrames = audioData.numberOfFrames;
            const sr      = audioData.sampleRate;

            // Detect planar vs interleaved once and cache it
            if (!layoutDetected) {
              if (nCh > 1) {
                try { audioData.allocationSize({ planeIndex: 1, format: 'f32-planar' }); isPlanar = true; }
                catch (_) { isPlanar = false; }
              } else {
                isPlanar = true;
              }
              layoutDetected = true;
            }

            const webAudioBuf = audioCtx.createBuffer(nCh, nFrames, sr);

            if (isPlanar) {
              for (let ch = 0; ch < nCh; ch++) {
                const byteLen = audioData.allocationSize({ planeIndex: ch, format: 'f32-planar' });
                const plane   = new Float32Array(byteLen / 4);
                audioData.copyTo(plane, { planeIndex: ch, format: 'f32-planar' });
                webAudioBuf.copyToChannel(plane, ch);
              }
            } else {
              const byteLen    = audioData.allocationSize({ planeIndex: 0, format: 'f32' });
              const interleaved = new Float32Array(byteLen / 4);
              audioData.copyTo(interleaved, { planeIndex: 0, format: 'f32' });
              for (let ch = 0; ch < nCh; ch++) {
                const chData = webAudioBuf.getChannelData(ch);
                for (let i = 0; i < nFrames; i++) chData[i] = interleaved[i * nCh + ch];
              }
            }

            audioData.close();

            const src = audioCtx.createBufferSource();
            src.buffer = webAudioBuf;
            src.connect(gainNode);

            const now = audioCtx.currentTime;
            if (audioNextPlayTime < now) audioNextPlayTime = now;
            src.start(audioNextPlayTime);
            audioNextPlayTime += webAudioBuf.duration;
          } catch (err) {
            console.warn('[Audio] output error:', err);
            try { audioData.close(); } catch (_) {}
          }
        },
        error: function(err) {
          console.warn('[Audio] AudioDecoder error:', err);
          audioDecoderReady = false;
          audioDecoder = null;
          layoutDetected = false;
        }
      });
      audioDecoder.configure({ codec: 'opus', sampleRate: 48000, numberOfChannels: 2 });
      audioDecoderReady = true;
      return true;
    } catch (err) {
      console.warn('[Audio] AudioDecoder init failed:', err);
      return false;
    }
  }

  function playOpusPacket(bytes) {
    if (isMuted) return;
    if (!audioCtx) initAudio();
    if (!audioCtx || audioCtx.state !== 'running') return;
    if (!audioDecoderReady) {
      if (!initOpusDecoder()) return;
    }
    if (!audioDecoder || audioDecoder.state === 'closed') { audioDecoderReady = false; return; }
    try {
      audioDecoder.decode(new EncodedAudioChunk({
        type: 'key',
        timestamp: performance.now() * 1000,
        data: bytes
      }));
    } catch (err) {
      console.warn('[Audio] Opus decode error:', err);
      audioDecoderReady = false;
      audioDecoder = null;
    }
  }

  function playRawPcm(bytes) {
    // Fallback: raw signed 16-bit LE stereo 48kHz PCM
    initAudio();
    if (!audioCtx || !gainNode || isMuted) return;
    if (audioCtx.state !== 'running') return;
    try {
      const int16 = new Int16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 2));
      const sampleCount = Math.floor(int16.length / 2);
      if (sampleCount <= 0) return;
      const buf = audioCtx.createBuffer(2, sampleCount, 48000);
      const L = buf.getChannelData(0), R = buf.getChannelData(1);
      for (let i = 0; i < sampleCount; i++) {
        L[i] = int16[i * 2]     / 32768.0;
        R[i] = int16[i * 2 + 1] / 32768.0;
      }
      const src = audioCtx.createBufferSource();
      src.buffer = buf;
      src.connect(gainNode);
      const now = audioCtx.currentTime;
      if (audioNextPlayTime < now) audioNextPlayTime = now;
      if (audioNextPlayTime > now + 0.12) audioNextPlayTime = now;
      src.start(audioNextPlayTime);
      audioNextPlayTime += buf.duration;
    } catch (_) {}
  }

  // ── Mute toggle ──────────────────────────────────────────────────────────
  function toggleMute() {
    isMuted = !isMuted;
    if (gainNode) gainNode.gain.value = isMuted ? 0 : 1;
    if (isMuted && audioDecoder && audioDecoder.state !== 'closed') {
      try { audioDecoder.flush().catch(function(){}); } catch (_) {}
    }
    // Sync desktop sidebar mute button
    const btn = document.getElementById('muteBtn');
    if (btn) {
      btn.innerHTML = isMuted
        ? '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="1" y1="1" x2="23" y2="23"/><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/></svg>'
        : '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/></svg>';
      btn.title = isMuted ? 'Unmute audio' : 'Mute audio';
      btn.style.color = isMuted ? '#f87171' : '';
      btn.style.borderColor = isMuted ? 'rgba(248,113,113,.5)' : '';
    }
    // Sync mobile bottom bar mute button
    const iconM = document.getElementById('muteBtnMIcon');
    const btnM  = document.getElementById('muteBtnM');
    if (iconM) iconM.innerHTML = isMuted
      ? '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="1" y1="1" x2="23" y2="23"/><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/></svg>'
      : '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>';
    if (btnM) {
      btnM.style.color = isMuted ? '#f87171' : '';
      btnM.style.borderColor = isMuted ? 'rgba(248,113,113,.5)' : '';
    }
  }

  // Resume AudioContext on first user gesture
  ['click', 'mousedown', 'pointerdown', 'touchstart', 'keydown'].forEach(function(evt) {
    window.addEventListener(evt, initAudio, { passive: true });
  });

  // ── WebCodecs H264 Decoder ───────────────────────────────────────────────
  let decoder = null;
  let decoderReady = false;
  let hasKeyframe = false;

  function resetDecoder() {
    hasKeyframe = false;
    if (decoder) {
      try { decoder.close(); } catch (_) {}
      decoder = null;
    }
    decoderReady = false;
  }

  function initDecoder() {
    resetDecoder();
    if (typeof VideoDecoder === 'undefined') {
      console.warn('[Stream] WebCodecs VideoDecoder not available in this browser');
      return false;
    }
    try {
      decoder = new VideoDecoder({
        output: function(frame) {
          lastFrameReceivedTime = Date.now();
          const w = frame.displayWidth  || frame.codedWidth  || frame.width;
          const h = frame.displayHeight || frame.codedHeight || frame.height;
          if (w && h && (canvas.width !== w || canvas.height !== h)) {
            canvas.width = w; canvas.height = h; nativeW = w; nativeH = h;
          }
          ctx.drawImage(frame, 0, 0, canvas.width, canvas.height);
          frame.close();
          countFrame();
        },
        error: function(err) {
          console.error('[Stream] VideoDecoder error:', err);
          resetDecoder();
        }
      });
      decoder.configure({
        codec: 'avc1.42E01E',
        optimizeForLatency: true,
        hardwareAcceleration: 'prefer-hardware'
      });
      decoderReady = true;
      return true;
    } catch (err) {
      console.error('[Stream] Failed to init VideoDecoder:', err);
      return false;
    }
  }

  function isH264Keyframe(u8) {
    for (let i = 0; i < Math.min(u8.length - 4, 256); i++) {
      if (u8[i] === 0 && u8[i+1] === 0) {
        let ntype = -1;
        if (u8[i+2] === 1 && i + 3 < u8.length) {
          ntype = u8[i+3] & 0x1f;
        } else if (u8[i+2] === 0 && u8[i+3] === 1 && i + 4 < u8.length) {
          ntype = u8[i+4] & 0x1f;
        }
        // WebCodecs key/config types: NAL 5 (IDR keyframe), NAL 7 (SPS), NAL 8 (PPS)
        if (ntype === 5 || ntype === 7 || ntype === 8) return true;
      }
    }
    return false;
  }

  // ── WebSocket connection ─────────────────────────────────────────────────
  let ws = null, wsOk = false;
  let wsFailCount = 0;
  let wsRetryTimer = null;
  let lastFrameReceivedTime = 0;

  // Fallback watchdog: only fires if WS is connected but no frames arrive for >15s.
  // 15s gives scrcpy time to start up before we fall back to HTTP screencap.
  setInterval(function() {
    if (!wsOk) return;
    if (lastFrameReceivedTime === 0) return;
    if (Date.now() - lastFrameReceivedTime > 15000 && !fbRunning) {
      console.warn('[Watchdog] No frames for 15s — starting HTTP fallback');
      startFallback();
    }
  }, 1000);

  // Separate first-frame watchdog — if WS is open but no frame ever arrives in 12s, fallback
  let firstFrameTimer = null;
  function startFirstFrameWatchdog() {
    if (firstFrameTimer) clearTimeout(firstFrameTimer);
    firstFrameTimer = setTimeout(function() {
      if (wsOk && lastFrameReceivedTime === 0 && !fbRunning) {
        console.warn('[Watchdog] No first frame within 12s — starting HTTP fallback');
        startFallback();
      }
    }, 12000);
  }

  function connectWS() {
    if (wsRetryTimer) { clearTimeout(wsRetryTimer); wsRetryTimer = null; }
    if (ws) {
      try {
        ws.onopen = null;
        ws.onmessage = null;
        ws.onerror = null;
        ws.onclose = null;
        ws.close();
      } catch (_) {}
      ws = null;
    }
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(proto + '//' + location.host + '/ws' + location.search);
    ws.binaryType = 'arraybuffer';

    ws.onopen = function() {
      wsOk = true;
      wsFailCount = 0;
      lastFrameReceivedTime = 0;
      modeText.textContent = 'LIVE 60FPS';
      resetDecoder();
      initDecoder();
      audioNextPlayTime = 0;
      fbRunning = false;
      if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume().catch(function(){});
      flushQueue();
      // Instantly nudge Android encoder to generate fresh keyframe
      send({ type: 'wake' });
    };

    ws.onmessage = function(e) {
      // JSON control messages (stream_reset, etc.)
      if (typeof e.data === 'string' || e.data instanceof ArrayBuffer && e.data.byteLength > 0 && new Uint8Array(e.data)[0] === 0x7B) {
        try {
          const txt = typeof e.data === 'string' ? e.data : new TextDecoder().decode(e.data);
          const msg = JSON.parse(txt);
          if (msg.type === 'stream_reset') {
            console.log('[Stream] Server stream reset — reinitialising decoder');
            resetDecoder();
            fbRunning = false;
            lastFrameReceivedTime = 0;
          } else if (msg.type === 'stream_revoked') {
            console.warn('[Stream] Stream status notice:', msg.reason);
            // Do not reload — keep session alive
            return;
          }
          return;
        } catch (_) {}
      }

      if (typeof e.data === 'string') {
        try {
          const msg = JSON.parse(e.data);
          if (msg.type === 'stream_revoked') {
            console.warn('[Stream] Access revoked or unallocated:', msg.reason);
            window.location.href = '/?udid=' + encodeURIComponent('${serial}') + '&revoked=1';
            return;
          }
        } catch (_) {}
        return;
      }

      if (!(e.data instanceof ArrayBuffer)) return;
      lastFrameReceivedTime = Date.now();
      if (fbRunning) { fbRunning = false; modeText.textContent = 'LIVE 60FPS'; }

      const rawU8 = new Uint8Array(e.data);
      if (rawU8.length < 4) return;

      // Handle tagged Audio binary frames — [0x41]['O'=opus / 'R'=raw][...payload]
      if (rawU8[0] === 0x41) {
        if (rawU8.length < 3) return;
        const codec = rawU8[1]; // 0x4F='O' opus, 0x52='R' raw
        const payload = rawU8.subarray(2);
        if (codec === 0x4F) {       // Opus
          playOpusPacket(payload);
        } else {                    // Raw PCM fallback
          playRawPcm(payload);
        }
        return;
      }

      const u8 = (rawU8[0] === 0x56) ? rawU8.subarray(1) : rawU8;

      // 1. PNG Image Auto-detection (0x89 0x50 0x4E 0x47)
      if (u8[0] === 0x89 && u8[1] === 0x50 && u8[2] === 0x4E && u8[3] === 0x47) {
        createImageBitmap(new Blob([u8], { type: 'image/png' }))
          .then(function(bmp) { queueDraw(bmp); })
          .catch(function(err) { console.warn('[Stream] PNG decode error:', err); });
        return;
      }

      // 2. JPEG Image Auto-detection (0xFF 0xD8)
      if (u8[0] === 0xFF && u8[1] === 0xD8) {
        createImageBitmap(new Blob([u8], { type: 'image/jpeg' }))
          .then(function(bmp) { queueDraw(bmp); })
          .catch(function(err) { console.warn('[Stream] JPEG decode error:', err); });
        return;
      }

      // 3. Raw H264 NAL stream via WebCodecs
      if (!decoderReady || !decoder || decoder.state !== 'configured') {
        if (!initDecoder()) {
          startFallback();
          return;
        }
      }

      const key = isH264Keyframe(u8);
      if (key) hasKeyframe = true;
      if (!hasKeyframe) return; // Wait for initial keyframe/config (SPS/PPS)

      // Prevent decode queue build-up in browser: if decoder is falling behind, drop stale delta frames
      if (decoder.decodeQueueSize > 4 && !key) {
        return;
      }

      try {
        const chunk = new EncodedVideoChunk({
          type: key ? 'key' : 'delta',
          timestamp: performance.now() * 1000,
          data: u8
        });
        decoder.decode(chunk);
      } catch (err) {
        hasKeyframe = false;
        console.warn('[Stream] H264 chunk decode error:', err);
        send({ type: 'wake' });
      }
    };

    // Auto-nudge Android screen compositor if frame updates stall
    setInterval(function() {
      if (wsOk && (lastFrameReceivedTime > 0 && Date.now() - lastFrameReceivedTime > 2500)) {
        send({ type: 'wake' });
      }
    }, 2000);

    ws.onerror = function() {};

    ws.onclose = function(e) {
      wsOk = false;
      if (e.code === 4003 || e.code === 4001 || e.code === 4004) {
        // Access revoked or unallocated -> immediately return to slides
        window.location.href = '/?udid=' + encodeURIComponent('${serial}') + '&revoked=1';
        return;
      }
      wsFailCount++;
      if (wsFailCount >= 15 && !fbRunning) startFallback();
      const delay = wsFailCount < 5 ? 500 : 1000;
      wsRetryTimer = setTimeout(connectWS, delay);
    };
  }

  // ── HTTP screencap fallback ───────────────────────────────────────────────
  // DISABLED — strict scrcpy H264 only, no fallback
  let fbRunning = false;
  function startFallback() {
    // Disabled
  }

  // ── Control: WS-only, never fetch ───────────────────────────────────────
  const ctrlQueue = [];
  function flushQueue() {
    while (ctrlQueue.length && ws && ws.readyState === 1)
      ws.send(JSON.stringify(ctrlQueue.shift()));
  }
  function send(data) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(data));
    else {
      if (data.type === 'touch' && data.action === 2) return; // drop stale moves
      ctrlQueue.push(data);
      if (ctrlQueue.length > 8) ctrlQueue.splice(0, ctrlQueue.length - 8);
    }
  }

  function coords(e) {
    const r = canvas.getBoundingClientRect();
    const cx = e.touches ? e.touches[0].clientX : e.clientX;
    const cy = e.touches ? e.touches[0].clientY : e.clientY;
    
    // Use canvas size first (actual rendered), fall back to nativeW/H, then server defaults
    const canvasW = canvas.width || nativeW || ${screenW};
    const canvasH = canvas.height || nativeH || ${screenH};
    
    // rect dimensions (CSS pixels on screen)
    const rectW = r.width || canvasW;
    const rectH = r.height || canvasH;
    
    // Prevent division by zero
    if (rectW === 0 || rectH === 0) return { x: 0, y: 0, cx, cy };
    
    const x = Math.round((cx - r.left) * (canvasW / rectW));
    const y = Math.round((cy - r.top)  * (canvasH / rectH));
    
    return {
      x: Math.max(0, Math.min(canvasW - 1, x)),
      y: Math.max(0, Math.min(canvasH - 1, y)),
      cx, cy
    };
  }

  // ── Natural Human Pointer & Fling Mechanics ──────────────────────────
  let down = false;
  let activePointerId = null;
  let moveRaf = null;
  let pendingMove = null;
  let pointerHistory = [];

  canvas.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    down = true;
    activePointerId = e.pointerId;
    try { canvas.setPointerCapture(e.pointerId); } catch (_) {}
    initAudio();
    const c = coords(e);
    pointerHistory = [{ x: c.x, y: c.y, t: performance.now() }];
    send({ type:'touch', action:0, x:c.x, y:c.y, width:nativeW, height:nativeH, pressure:0.45 });
  });

  canvas.addEventListener('pointermove', (e) => {
    if (!down) return;
    e.preventDefault();
    const c = coords(e);
    const now = performance.now();
    pointerHistory.push({ x: c.x, y: c.y, t: now });
    while (pointerHistory.length > 1 && now - pointerHistory[0].t > 120) {
      pointerHistory.shift();
    }
    pendingMove = c;

    if (!moveRaf) {
      moveRaf = requestAnimationFrame(() => {
        moveRaf = null;
        if (down && pendingMove) {
          send({ type:'touch', action:2, x:pendingMove.x, y:pendingMove.y, width:nativeW, height:nativeH, pressure:0.65 });
        }
      });
    }
  });

  function releasePointer(e) {
    if (!down) return;
    down = false;
    if (moveRaf) {
      cancelAnimationFrame(moveRaf);
      moveRaf = null;
    }
    if (activePointerId !== null) {
      try { canvas.releasePointerCapture(activePointerId); } catch (_) {}
      activePointerId = null;
    }

    const c = coords(e);
    const now = performance.now();
    pointerHistory.push({ x: c.x, y: c.y, t: now });

    // Only send MOVE on release if pointer actually moved, ensuring pure clicks register as taps
    const didMove = pointerHistory.length > 2 || (pointerHistory.length >= 2 && Math.hypot(c.x - pointerHistory[0].x, c.y - pointerHistory[0].y) > 4);
    if (didMove) {
      send({ type:'touch', action:2, x:c.x, y:c.y, width:nativeW, height:nativeH, pressure:0.5 });
    }

    // Calculate fling velocity for natural coasting physics
    if (pointerHistory.length >= 2) {
      const oldest = pointerHistory[0];
      const dt = now - oldest.t;
      const dx = c.x - oldest.x;
      const dy = c.y - oldest.y;
      const speed = Math.hypot(dx, dy) / Math.max(1, dt); // px/ms

      // If swift swipe/flick (> 0.35 px/ms), project an extra momentum step
      // so Android's native VelocityTracker produces a silky smooth momentum scroll
      if (speed > 0.35 && dt < 150) {
        const momentumDist = Math.min(220, speed * 35);
        const angle = Math.atan2(dy, dx);
        const flingX = Math.round(c.x + Math.cos(angle) * momentumDist);
        const flingY = Math.round(c.y + Math.sin(angle) * momentumDist);
        send({ type:'touch', action:2, x:flingX, y:flingY, width:nativeW, height:nativeH, pressure:0.3 });
      }
    }

    // Complete gesture with ACTION_UP: ensure minimum 45ms hold time for crisp clicks
    const timeDown = now - (pointerHistory[0] ? pointerHistory[0].t : now);
    if (!didMove && timeDown < 45) {
      setTimeout(() => {
        send({ type:'touch', action:1, x:c.x, y:c.y, width:nativeW, height:nativeH, pressure:0 });
      }, 50 - timeDown);
    } else {
      send({ type:'touch', action:1, x:c.x, y:c.y, width:nativeW, height:nativeH, pressure:0 });
    }
  }

  canvas.addEventListener('pointerup', releasePointer);
  canvas.addEventListener('pointercancel', releasePointer);
  window.addEventListener('pointerup', releasePointer);

  // ── Ultra-Smooth Continuous Wheel Scrolling (35ms Responsive Bucket) ───
  let wheelAccum = 0;
  let wheelTimer = null;
  let lastWheelPos = null;

  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    wheelAccum += e.deltaY;
    lastWheelPos = coords(e);

    if (!wheelTimer) {
      wheelTimer = setTimeout(() => {
        const d = wheelAccum;
        const c = lastWheelPos || { x: nativeW / 2, y: nativeH / 2 };
        wheelAccum = 0;
        wheelTimer = null;

        // Convert mouse wheel ticks into natural, fluid finger scroll strokes
        const scrollDist = Math.max(-550, Math.min(550, -d * 2.2));
        if (Math.abs(scrollDist) > 8) {
          const y1 = Math.max(120, Math.min(nativeH - 120, c.y));
          const y2 = Math.max(30, Math.min(nativeH - 30, y1 + scrollDist));
          const strokeDur = Math.max(50, Math.min(130, Math.round(Math.abs(scrollDist) * 0.25)));
          send({ type:'swipe', x1:c.x, y1:y1, x2:c.x, y2:y2, duration:strokeDur });
        }
      }, 35);
    }
  }, { passive:false });

  // ── Keyboard handling (Spacebar protection & full Android keys) ────────
  document.addEventListener('keydown', (e) => {
    // Never intercept if typing into an input/textarea inside a modal dialog
    if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) return;

    // Immediately blur any active button so Space cannot trigger click events on it
    if (document.activeElement && document.activeElement !== document.body && document.activeElement !== canvas) {
      document.activeElement.blur();
    }

    if (e.key === ' ' || e.code === 'Space') {
      e.preventDefault();
      key(62); // Android KEYCODE_SPACE = 62
    } else if (e.key === 'Backspace') {
      e.preventDefault();
      key(67); // Android KEYCODE_DEL = 67
    } else if (e.key === 'Enter') {
      e.preventDefault();
      key(66); // Android KEYCODE_ENTER = 66
    } else if (e.key === 'Escape') {
      e.preventDefault();
      key(4);  // Android KEYCODE_BACK = 4
    } else if (e.key === 'Tab') {
      e.preventDefault();
      key(61); // Android KEYCODE_TAB = 61
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      key(19);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      key(20);
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      key(21);
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      key(22);
    } else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      send({ type:'text', text:e.key });
    }
  });

  // Ensure all buttons instantly blur upon click or touch so they never retain keyboard focus
  window.addEventListener('pointerdown', (e) => {
    if (e.target && (e.target.tagName === 'BUTTON' || e.target.closest('button'))) {
      const btn = e.target.tagName === 'BUTTON' ? e.target : e.target.closest('button');
      setTimeout(() => { if (btn) btn.blur(); }, 0);
    }
  });
  window.addEventListener('click', (e) => {
    if (e.target && (e.target.tagName === 'BUTTON' || e.target.closest('button'))) {
      const btn = e.target.tagName === 'BUTTON' ? e.target : e.target.closest('button');
      setTimeout(() => { if (btn) btn.blur(); }, 0);
    }
  });

  function key(code) { send({ type:'code', code }); }
  function expandNotifications() { send({ type:'expand_notifications' }); }

  function screenshot() {
    const q = location.search ? location.search + '&t=' + Date.now() : '?t=' + Date.now();
    fetch('/screen.jpg' + q).then(r=>r.blob()).then(b=>{
      const a = document.createElement('a');
      a.href = URL.createObjectURL(b);
      a.download = 'shot-${serial}-'+Date.now()+'.jpg';
      a.click();
    });
  }
  function reboot() { if(confirm('Reboot ${serial}?')) send({type:'reboot'}); }
  function openText() { document.getElementById('textModal').style.display='flex'; document.getElementById('textVal').focus(); }
  function doText() {
    const v = document.getElementById('textVal').value;
    if (v) { send({type:'text',text:v}); document.getElementById('textVal').value=''; }
    document.getElementById('textModal').style.display='none';
  }
  function openUpload() { document.getElementById('uploadModal').style.display='flex'; }
  function doUpload() {
    const f = document.getElementById('filePick').files[0];
    if (!f) return alert('Pick a file first');
    const fd = new FormData(); fd.append('file', f);
    fetch('/upload',{method:'POST',body:fd}).then(r=>r.json())
      .then(()=>{ alert(f.name+' uploaded!'); document.getElementById('uploadModal').style.display='none'; })
      .catch(()=>alert('Upload failed'));
  }
  let currentVolume = 100;
  function setVolume(val) {
    currentVolume = parseFloat(val);
    if (gainNode) gainNode.gain.value = isMuted ? 0 : (currentVolume / 100);
    const btn = document.getElementById('muteBtn');
    if (btn) {
      btn.innerHTML = (isMuted || currentVolume === 0) 
        ? '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="1" y1="1" x2="23" y2="23"/><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/></svg>' 
        : '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>';
    }
  }

  function rotateScreen() {
    send({ type: 'code', code: 275 });
    setTimeout(reconnectStream, 300);
  }

  function reconnectStream() {
    modeText.textContent = 'RECONNECTING';
    resetDecoder();
    connectWS();
  }

  function toggleDebugModal() {
    const modal = document.getElementById('debugModal');
    if (modal) {
      document.getElementById('dbgRes').textContent = nativeW + ' x ' + nativeH;
      document.getElementById('dbgWs').textContent = wsOk ? 'CONNECTED' : 'DISCONNECTED';
      document.getElementById('dbgCodec').textContent = typeof VideoDecoder !== 'undefined' ? 'WebCodecs H264 (Hardware)' : 'Fallback Canvas';
      modal.style.display = modal.style.display === 'flex' ? 'none' : 'flex';
    }
  }

  function popOutWindow() {
    const width = 510, height = 900;
    const left = Math.max(0, Math.round((window.screen.width - width) / 2));
    const top = Math.max(0, Math.round((window.screen.height - height) / 2));
    window.open(window.location.href, 'Stream_${serial}', 'width=' + width + ',height=' + height + ',top=' + top + ',left=' + left + ',resizable=yes,scrollbars=no,status=no,location=no,toolbar=no,menubar=no,popup=yes');
  }

  window.addEventListener('click', e => { if (e.target.classList.contains('modal')) e.target.style.display='none'; });

  connectWS();
</script>
</body>
</html>`;
}


// ─── startStreamServer ───────────────────────────────────────────────────────


async function startStreamServer(serial, port) {
  logger.info(`[StreamServer] Starting for ${serial} on port ${port}`);

  // Start scrcpy engine asynchronously so stream server port listens immediately
  const engine = new ScrcpyEngine(serial);
  engine.enableAudio = true;  // Stream Opus audio to remote browsers
  const videoPort = port + 1000;
  engine.start(videoPort)
    .then(() => logger.info(`[StreamServer] ScrcpyEngine ready for ${serial}`))
    .catch((err) => logger.warn(`[StreamServer] ScrcpyEngine failed for ${serial}: ${err.message}`));


  // ── HTTP handler ──────────────────────────────────────────────────────────
  const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Permissions-Policy', 'geolocation=(), camera=(), microphone=(), interest-cohort=()');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline' https://static.cloudflareinsights.com; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self' ws: wss:;");
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    const url = new URL(req.url, `http://localhost:${port}`);
    const p   = url.pathname;
    const reqUdid = (url.searchParams.get('udid') || '').trim();
    const candidateAuth = (url.searchParams.get('pin') || url.searchParams.get('key') || url.searchParams.get('token') || '').trim();
    const candidateUserId = (url.searchParams.get('user_id') || '').trim();
    const candidateRole = (url.searchParams.get('role') || '').trim();
    const adminParam = url.searchParams.get('admin');
    const referer = req.headers['referer'] || '';
    const isAdmin = Boolean(
      adminParam === 'true' || 
      adminParam === '1' || 
      ['admin', 'seed_admin', 'super_admin'].includes(candidateRole) || 
      ['admin', 'seed_admin', 'super_admin'].includes(candidateAuth) ||
      referer.includes('/seed-admin') ||
      referer.includes('/super-admin') ||
      referer.includes('/admin')
    );
    const remoteIp = req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown';

    // 1. Bare domain or no UDID provided -> show the 5 auto-sliding cards presentation
    if (!reqUdid) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(buildVertexCardsHtml(null, null, false));
      return;
    }

    // 2. Identify active target session for requested device
    const targetSession = activeServers.get(reqUdid) || (reqUdid === serial ? { server, wss, engine, serial } : null);
    if (!targetSession) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(buildVertexCardsHtml(reqUdid, candidateAuth, true, `Device ${reqUdid} is offline or no active session exists.`));
      return;
    }

    const effectiveSerial = targetSession.serial || serial;
    const effectiveEngine = targetSession.engine || engine;

    // 3. Server-side token / PIN verification with user account binding
    const authResult = await verifyDeviceAccess(effectiveSerial, candidateAuth, candidateUserId, remoteIp, candidateRole, isAdmin);
    if (!authResult.authorized) {
      res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(buildVertexCardsHtml(
        effectiveSerial,
        candidateAuth,
        true,
        authResult.reason || `Access denied for ${effectiveSerial}. Valid server-confirmed PIN or access token required.`
      ));
      return;
    }

    // Handle file upload
    if (p === '/upload' && req.method === 'POST') {
      const chunks = [];
      req.on('data', c => chunks.push(c));
      req.on('end', () => {
        const tmp = path.join(process.cwd(), `upload_${Date.now()}.tmp`);
        fs.writeFileSync(tmp, Buffer.concat(chunks));
        const dest = `/sdcard/Download/media_${Date.now()}.jpg`;
        exec(`"${ADB_BIN}" -s ${effectiveSerial} push "${tmp}" "${dest}"`, () => {
          try { fs.unlinkSync(tmp); } catch (_) {}
          exec(`"${ADB_BIN}" -s ${effectiveSerial} shell am broadcast -a android.intent.action.MEDIA_SCANNER_SCAN_FILE -d file://${dest}`);
          res.writeHead(200, {'Content-Type':'application/json'});
          res.end(JSON.stringify({ status:'ok' }));
        });
      });
      return;
    }

    // Screenshot endpoint
    if (p === '/screen.jpg') {
      const frame = await captureOneFrame(effectiveSerial);
      if (frame) { res.writeHead(200, {'Content-Type':'image/png','Cache-Control':'no-cache'}); res.end(frame); }
      else        { res.writeHead(500); res.end('Capture error'); }
      return;
    }

    // Control endpoint
    if (p === '/control') {
      handleControl(url.searchParams.get('type'), url.searchParams, effectiveSerial, effectiveEngine);
      res.writeHead(200, {'Content-Type':'application/json'});
      res.end('{"status":"ok"}');
      return;
    }

    // Render Stream Player
    res.writeHead(200, {'Content-Type':'text/html; charset=utf-8'});
    const playerW = effectiveEngine.videoWidth  > 0 ? effectiveEngine.videoWidth  : effectiveEngine.screenWidth;
    const playerH = effectiveEngine.videoHeight > 0 ? effectiveEngine.videoHeight : effectiveEngine.screenHeight;
    res.end(buildPlayerHtml(effectiveSerial, playerW, playerH));
  });

  // ── WebSocket — relay H264 + audio from scrcpy engine to browser ─────────
  const wss = new WebSocket.Server({ server, path: '/ws', perMessageDeflate: false });

  wss.on('connection', async (ws, req) => {
    // Disable Nagle algorithm on the underlying TCP socket for immediate packet dispatch
    if (req.socket && typeof req.socket.setNoDelay === 'function') {
      try { req.socket.setNoDelay(true); } catch (_) {}
    }

    const wsUrl = new URL(req.url, 'http://localhost');
    const reqWsUdid = (wsUrl.searchParams.get('udid') || '').trim();
    const candidateWsAuth = (wsUrl.searchParams.get('pin') || wsUrl.searchParams.get('key') || wsUrl.searchParams.get('token') || '').trim();
    const candidateWsUserId = (wsUrl.searchParams.get('user_id') || '').trim();
    const candidateWsRole = (wsUrl.searchParams.get('role') || '').trim();
    const wsAdminParam = wsUrl.searchParams.get('admin');
    const wsReferer = req.headers['referer'] || '';
    const isWsAdmin = Boolean(
      wsAdminParam === 'true' || 
      wsAdminParam === '1' || 
      ['admin', 'seed_admin', 'super_admin'].includes(candidateWsRole) || 
      ['admin', 'seed_admin', 'super_admin'].includes(candidateWsAuth) ||
      wsReferer.includes('/seed-admin') ||
      wsReferer.includes('/super-admin') ||
      wsReferer.includes('/admin')
    );
    const remoteIp = req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown';

    if (!reqWsUdid) {
      ws.close(4000, 'Device UDID Required');
      return;
    }

    const targetWsSession = activeServers.get(reqWsUdid) || (reqWsUdid === serial ? { engine, serial } : null);
    if (!targetWsSession) {
      ws.close(4004, 'Device Not Found Or Offline');
      return;
    }

    const effectiveWsSerial = targetWsSession.serial || serial;
    const effectiveWsEngine = targetWsSession.engine || engine;

    // Check credential on initial WS connection (admins bypass PIN check)
    const wsAuthResult = await verifyDeviceAccess(effectiveWsSerial, candidateWsAuth, candidateWsUserId, remoteIp, candidateWsRole, isWsAdmin);
    if (!wsAuthResult.authorized) {
      logger.warn(`[StreamServer] Unauthorized WS connection attempt for ${effectiveWsSerial}: ${wsAuthResult.reason}`);
      try {
        ws.send(JSON.stringify({ type: 'stream_revoked', reason: wsAuthResult.reason }));
      } catch (_) {}
      ws.close(4003, wsAuthResult.reason || 'Unauthorized / Expired Credentials');
      return;
    }

    const boundUserId = wsAuthResult.assignedUserId || candidateWsUserId || null;
    logger.info(`[StreamServer] WS connected and authorized for ${effectiveWsSerial} (user=${boundUserId || 'admin'}, admin=${isWsAdmin})`);
    effectiveWsEngine.addClient(ws);

    // Periodic credential refresh (every 20s): admins are never revoked
    // Immediately terminates stream and kicks to slides if unallocated or re-assigned
    const authWatcherTimer = isWsAdmin ? null : setInterval(async () => {
      try {
        const check = await verifyDeviceAccess(effectiveWsSerial, candidateWsAuth, boundUserId, remoteIp, candidateWsRole, isWsAdmin);
        if (!check.authorized && !check.transientError && check.reason && !check.reason.includes('service error') && !check.reason.includes('failed')) {
          logger.warn(`[StreamServer] Access revoked for ${effectiveWsSerial} (${check.reason}). Terminating active stream.`);
          try {
            ws.send(JSON.stringify({ type: 'stream_revoked', reason: check.reason }));
          } catch (_) {}
          clearInterval(authWatcherTimer);
          effectiveWsEngine.removeClient(ws);
          ws.close(4003, check.reason || 'Credentials Revoked');
        }
      } catch (_) {}
    }, 20000);

    ws.on('message', (msg) => {
      try {
        const data = JSON.parse(msg.toString());
        handleControl(data.type, data, effectiveWsSerial, effectiveWsEngine);
      } catch (_) {}
    });

    const cleanup = () => {
      effectiveWsEngine.removeClient(ws);
      clearInterval(authWatcherTimer);
    };
    ws.on('close', cleanup);
    ws.on('error', cleanup);
  });

  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.on('clientError', (err, socket) => {
      try {
        if (socket.writable) socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
        socket.destroy();
      } catch (_) {}
    });
    server.listen(port, () => {
      const localUrl = `http://localhost:${port}`;
      logger.info(`[StreamServer] Listening at ${localUrl}`);
      activeServers.set(serial, { server, wss, engine, serial });

      const streamProcess = {
        pid: port, exitCode: null,
        kill() {
          engine.stop();
          try { wss.close(); } catch (_) {}
          server.close();
          activeServers.delete(serial);
        },
      };
      resolve({ streamProcess, localUrl });
    });
  });
}

// ─── Exports ─────────────────────────────────────────────────────────────────

function buildStreamUrl(tunnelDomain, port, serial, pin) {
  let cleanDomain = (tunnelDomain || 'agent.dennoh.site').replace(/\/+$/, '');
  const domain = cleanDomain.startsWith('http') ? cleanDomain : `https://${cleanDomain}`;
  const pinParam = pin ? `&pin=${encodeURIComponent(pin)}` : '';
  return `${domain}/?udid=${encodeURIComponent(serial)}${pinParam}`;
}

function killStreamServer(streamProcess) {
  if (streamProcess && typeof streamProcess.kill === 'function') {
    try { streamProcess.kill(); } catch (_) {}
  }
}

module.exports = { startStreamServer, buildStreamUrl, killStreamServer, verifyDeviceAccess };
