'use strict';

const axios = require('axios');
const path = require('path');
const fs = require('fs');
const logger = require('../utils/logger');
const { getDecryptedSystemCredentials } = require('../utils/security');

function loadConfigPath() {
  const candidates = [
    path.join(process.cwd(), 'config.json'),
    path.join(__dirname, '..', '..', 'config.json'),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      return p;
    }
  }
  return path.join(process.cwd(), 'config.json');
}

function loadConfig() {
  const cfgPath = loadConfigPath();
  let cfg = {};
  if (fs.existsSync(cfgPath)) {
    try {
      cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
    } catch (_) {}
  }

  // Pre-installed Encrypted Credentials Fallback
  const secureCreds = getDecryptedSystemCredentials();
  if (!cfg.supabaseUrl || cfg.supabaseUrl.includes('your-supabase-project.supabase.co')) {
    cfg.supabaseUrl = secureCreds.supabaseUrl;
  }
  if (!cfg.supabaseAnonKey || cfg.supabaseAnonKey === 'YOUR_SUPABASE_ANON_KEY') {
    cfg.supabaseAnonKey = secureCreds.supabaseAnonKey;
  }
  if (!cfg.supabasePaymentPortalUrl) {
    cfg.supabasePaymentPortalUrl = secureCreds.appUrl;
  }
  return cfg;
}

let config = loadConfig();

/**
 * Memory cache for device rental statuses to avoid high latency on 60FPS stream checks.
 * Map<serialNumber, { isPaid: boolean, status: string, expiresAt: string, lastChecked: number }>
 */
const rentalCache = new Map();
const CACHE_TTL_MS = 15000; // 15 seconds cache TTL

/** Local override map for testing or offline manual activation */
const localOverrides = new Map();

function isSupabaseConfigured() {
  return (
    config.supabaseUrl &&
    config.supabaseAnonKey
  );
}

function getSupabaseClient() {
  if (!isSupabaseConfigured()) return null;
  const secureCreds = getDecryptedSystemCredentials();
  const apiKey = config.supabaseServiceRoleKey || config.supabaseAnonKey || secureCreds.supabaseServiceRoleKey || secureCreds.supabaseAnonKey;

  return axios.create({
    baseURL: `${config.supabaseUrl.replace(/\/$/, '')}/rest/v1`,
    timeout: 6000,
    headers: {
      'Content-Type': 'application/json',
      apikey: apiKey,
      Authorization: `Bearer ${apiKey}`,
      Prefer: 'return=representation',
    },
  });
}

/**
 * Check rental payment status for a device link.
 * Every device link requires $30 USD / month subscription.
 *
 * @param {string} serialNumber
 * @returns {Promise<{ isPaid: boolean, status: string, monthlyFee: number, expiresAt: string|null, userProfileId: string }>}
 */
async function checkDeviceRentalStatus(serialNumber) {
  const monthlyFee = config.monthlyFeePerDeviceUsd || 30;
  const rentalUserId = config.rentalUserId || 'RENTAL_USER_DEFAULT';

  const client = getSupabaseClient();

  if (client) {
    try {
      // Query device_rentals table from Supabase for live status
      const response = await client.get(`/device_rentals?serial_number=eq.${encodeURIComponent(serialNumber)}&select=*`);
      const records = response.data;

      if (records && records.length > 0) {
        const record = records[0];
        const expiresAt = record.expires_at ? new Date(record.expires_at) : null;
        const now = new Date();
        const statusStr = (record.status || '').toLowerCase().trim();
        const isActiveStatus = statusStr === 'active' || statusStr === 'paid';
        const isNotExpired = expiresAt ? expiresAt > now : true;

        const isPaid = isActiveStatus && isNotExpired;
        const status = isPaid ? 'active' : (expiresAt && expiresAt <= now ? 'expired' : 'unpaid');

        // Clear any stale local overrides if Supabase returns active
        if (isPaid) {
          localOverrides.delete(serialNumber);
        }

        rentalCache.set(serialNumber, {
          isPaid,
          status,
          expiresAt: record.expires_at,
          lastChecked: Date.now(),
        });

        return {
          isPaid,
          status,
          monthlyFee: record.monthly_fee || monthlyFee,
          expiresAt: record.expires_at,
          userProfileId: record.user_id || rentalUserId,
        };
      }
    } catch (err) {
      logger.warn(`Failed to fetch rental status from Supabase for ${serialNumber}: ${err.message}`);
    }
  }

  // Fallback to manual local override if set
  if (localOverrides.has(serialNumber)) {
    const override = localOverrides.get(serialNumber);
    return {
      isPaid: override.isPaid,
      status: override.status,
      monthlyFee,
      expiresAt: override.expiresAt || new Date(Date.now() + 30 * 86400000).toISOString(),
      userProfileId: rentalUserId,
    };
  }

  // Check cache
  const cached = rentalCache.get(serialNumber);
  const dynamicTtl = (cached && cached.isPaid) ? CACHE_TTL_MS : 2000;
  if (cached && Date.now() - cached.lastChecked < dynamicTtl) {
    return {
      isPaid: cached.isPaid,
      status: cached.status,
      monthlyFee,
      expiresAt: cached.expiresAt,
      userProfileId: rentalUserId,
    };
  }

  // Default fallback: If Supabase is unconfigured (standalone local mode), default to active
  const hasSupabase = Boolean(config.supabaseUrl && config.supabaseAnonKey);
  const isStandalone = !hasSupabase;
  const isPaidDefault = isStandalone || config.allowOfflineGracePeriod !== false;
  return {
    isPaid: isPaidDefault,
    status: isPaidDefault ? (isStandalone ? 'active' : 'active_offline_grace') : 'unpaid',
    monthlyFee,
    expiresAt: null,
    userProfileId: rentalUserId,
  };
}

/**
 * Register or update device rental record in Supabase.
 *
 * @param {string} serialNumber
 * @param {object} options
 */
async function createOrUpdateDeviceRental(serialNumber, options = {}) {
  const monthlyFee = config.monthlyFeePerDeviceUsd || 30;
  const rentalUserId = config.rentalUserId || 'RENTAL_USER_DEFAULT';
  const client = getSupabaseClient();

  const payload = {
    serial_number: serialNumber,
    user_id: rentalUserId,
    device_model: options.deviceModel || 'Android Device',
    device_brand: options.deviceBrand || 'Generic',
    monthly_fee: monthlyFee,
    currency: 'USD',
    updated_at: new Date().toISOString(),
  };

  // Only set status if explicitly specified (e.g. when paid/activated or explicitly updating status)
  if (options.status) {
    payload.status = options.status;
  }

  if (options.status === 'active' || options.status === 'paid') {
    payload.expires_at = options.expiresAt || new Date(Date.now() + 30 * 86400000).toISOString();
  }

  // Clear cache for this serial
  rentalCache.delete(serialNumber);

  if (!client) {
    logger.info(`[Standalone Local Rental] Registered rental for device ${serialNumber} (Fee: $${monthlyFee}/mo)`);
    return payload;
  }

  try {
    // 1. Ensure user_profiles record exists to satisfy foreign key constraints
    try {
      await client.post(
        '/user_profiles',
        {
          id: rentalUserId,
          email: config.adminEmail || 'sammyseth260@gmail.com',
          updated_at: new Date().toISOString(),
        },
        { headers: { Prefer: 'resolution=merge-duplicates' } }
      );
    } catch (_) {}

    // 2. Try PATCH update first for existing serial_number (preserves active payment status if not passed)
    const patchRes = await client.patch(`/device_rentals?serial_number=eq.${encodeURIComponent(serialNumber)}`, payload);
    if (patchRes.data && Array.isArray(patchRes.data) && patchRes.data.length > 0) {
      logger.info(`[Supabase Rental] Device ${serialNumber} info updated cleanly`);
      return patchRes.data[0];
    }

    // 3. Fallback POST insert if new device serial
    if (!payload.status) payload.status = 'unpaid';
    const postRes = await client.post('/device_rentals', payload);
    logger.info(`[Supabase Rental] Registered new device rental for ${serialNumber} (Status: ${payload.status})`);
    return postRes.data;
  } catch (err) {
    logger.warn(`[Supabase Rental Note] Device rental record cached locally for ${serialNumber}: ${err.message}`);
    return payload;
  }
}

/**
 * Get summary of all device rentals for the machine/user.
 */
async function getMachineRentalSummary(activeDevices = []) {
  const monthlyFee = config.monthlyFeePerDeviceUsd || 30;
  const rentalUserId = config.rentalUserId || 'RENTAL_USER_DEFAULT';
  const isConfigured = isSupabaseConfigured();

  const deviceStatuses = [];
  let totalMonthlyCost = 0;
  let paidCount = 0;
  let unpaidCount = 0;

  for (const dev of activeDevices) {
    const status = await checkDeviceRentalStatus(dev.serial);
    if (status.isPaid) paidCount++;
    else unpaidCount++;

    totalMonthlyCost += monthlyFee;
    deviceStatuses.push({
      serial: dev.serial,
      model: dev.model || dev.deviceModel || 'Android Device',
      brand: dev.brand || dev.deviceBrand || 'Generic',
      port: dev.port,
      streamUrl: dev.streamUrl,
      monthlyFeeUsd: monthlyFee,
      expiresAt: status.expiresAt,
    });
  }

  const bindingService = require('./binding-service');
  const machineBindingCode = bindingService.getOrGenerateBindingCode();

  return {
    isSupabaseConfigured: isConfigured,
    supabaseUrl: config.supabaseUrl || '',
    rentalUserId,
    machineBindingCode,
    monthlyFeePerDeviceUsd: monthlyFee,
    totalActiveDevices: activeDevices.length,
    totalMonthlyCostUsd: totalMonthlyCost,
    paidCount,
    unpaidCount,
    overallPaymentStatus: unpaidCount === 0 && activeDevices.length > 0 ? 'ALL_PAID' : (activeDevices.length === 0 ? 'NO_DEVICES' : 'ACTION_REQUIRED'),
    devices: deviceStatuses,
    checkoutUrl: getPaymentCheckoutUrl(machineBindingCode),
  };
}

/**
 * Generate checkout or payment link for device rental renewal ($30 USD/month).
 */
function getPaymentCheckoutUrl(targetIdentifier) {
  if (config.supabasePaymentPortalUrl) {
    return `${config.supabasePaymentPortalUrl}?ref=${encodeURIComponent(targetIdentifier)}`;
  }
  const baseUrl = isSupabaseConfigured() ? config.supabaseUrl : 'https://supabase.com';
  return `${baseUrl}/functions/v1/checkout?user_id=${encodeURIComponent(targetIdentifier)}&amount=30&currency=USD`;
}

/**
 * Update system Supabase configuration.
 */
function updateRentalConfig(newConfig) {
  const cfgPath = loadConfigPath();
  config = { ...config, ...newConfig };
  fs.writeFileSync(cfgPath, JSON.stringify(config, null, 2), 'utf-8');
  rentalCache.clear();
  logger.info('[Rental Service] Configuration updated successfully');
  return config;
}

/**
 * Set a manual local payment override for testing/manual activation.
 */
function setLocalPaymentOverride(serialNumber, isPaid) {
  localOverrides.set(serialNumber, {
    isPaid,
    status: isPaid ? 'active' : 'unpaid',
    expiresAt: isPaid ? new Date(Date.now() + 30 * 86400000).toISOString() : null,
  });
  rentalCache.delete(serialNumber);
  logger.info(`[Rental Override] Device ${serialNumber} set to isPaid=${isPaid}`);
}

/**
 * Return SQL schema for setting up Supabase database tables.
 */
function getSupabaseSqlSchema() {
  return `-- ============================================================
-- DeviceFarm Monthly Rental ($30 USD/device/month) Database Schema
-- Run this in your Supabase SQL Editor
-- ============================================================

-- 1. Create User Profiles Table
CREATE TABLE IF NOT EXISTS public.user_profiles (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE,
  full_name TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 2. Create Device Rentals Table ($30 USD / Month per Device Link)
CREATE TABLE IF NOT EXISTS public.device_rentals (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  serial_number TEXT UNIQUE NOT NULL,
  user_id TEXT REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  device_model TEXT,
  device_brand TEXT,
  monthly_fee NUMERIC DEFAULT 30.00,
  currency TEXT DEFAULT 'USD',
  status TEXT DEFAULT 'unpaid', -- 'active', 'unpaid', 'expired'
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 3. Create Payment Logs Table
CREATE TABLE IF NOT EXISTS public.payment_logs (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  serial_number TEXT REFERENCES public.device_rentals(serial_number),
  user_id TEXT,
  amount NUMERIC NOT NULL DEFAULT 30.00,
  currency TEXT DEFAULT 'USD',
  stripe_payment_id TEXT,
  payment_status TEXT DEFAULT 'succeeded',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Enable RLS & Row level security policy
ALTER TABLE public.device_rentals ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow public read and sync access" ON public.device_rentals FOR ALL USING (true);
`;
}

module.exports = {
  checkDeviceRentalStatus,
  createOrUpdateDeviceRental,
  getMachineRentalSummary,
  getPaymentCheckoutUrl,
  updateRentalConfig,
  setLocalPaymentOverride,
  getSupabaseSqlSchema,
  isSupabaseConfigured,
};
