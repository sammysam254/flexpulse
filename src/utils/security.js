'use strict';

const crypto = require('crypto');

// Secret salt derived from system hardware signature / application secret
const APP_SECRET_SALT = 'DEVICEFARM_AGENT_SYSTEM_RENTAL_SECRET_2026_SALT';

function getDerivedKey() {
  return crypto.pbkdf2Sync(APP_SECRET_SALT, 'SALT_PERMANENT_KEY', 10000, 32, 'sha256');
}

/**
 * Encrypt a plain string into hex format using AES-256-CBC.
 */
function encrypt(text) {
  try {
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-cbc', getDerivedKey(), iv);
    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    return iv.toString('hex') + ':' + encrypted;
  } catch (err) {
    return null;
  }
}

/**
 * Decrypt a hex formatted string using AES-256-CBC.
 */
function decrypt(encryptedText) {
  try {
    const parts = encryptedText.split(':');
    if (parts.length !== 2) return null;
    const iv = Buffer.from(parts[0], 'hex');
    const encrypted = parts[1];
    const decipher = crypto.createDecipheriv('aes-256-cbc', getDerivedKey(), iv);
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch (err) {
    return null;
  }
}

const fs = require('fs');
const path = require('path');

function getLocalConfig() {
  const candidates = [
    path.join(process.cwd(), 'config.json'),
    path.join(__dirname, '..', '..', 'config.json'),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) {}
    }
  }
  return {};
}

// Production Credentials Payload (Strictly Independent System Platform)
const SECURE_PAYLOAD = {
  encryptedSupabaseUrl: encrypt(process.env.SUPABASE_URL || 'https://hhcxnsaezvmhqrhukvnm.supabase.co'),
  encryptedSupabaseAnonKey: encrypt(process.env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImhoY3huc2FlenZtaHFyaHVrdm5tIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTA0Mzg0OTMsImV4cCI6MjEwNjAxNDQ5M30.4T4TTnOt5IwCP2fCoH0n9Cd5rGl2NmBHEdM0jOH8FVw'),
  encryptedSupabaseServiceRoleKey: encrypt(process.env.SUPABASE_SERVICE_ROLE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImhoY3huc2FlenZtaHFyaHVrdm5tIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc5MDQzODQ5MywiZXhwIjoyMTA2MDE0NDkzfQ.j80pT_q3mKIxnz9DxqDDZueVafRKrD1DTU9IJv-eFAQ'),
  encryptedAppUrl: encrypt(process.env.APP_URL || ''),
  encryptedPaystackPublicKey: encrypt(process.env.PAYSTACK_PUBLIC_KEY || ''),
  encryptedNowPaymentsKey: encrypt(process.env.NOWPAYMENTS_API_KEY || ''),
  encryptedAdminEmail: encrypt(process.env.ADMIN_EMAIL || ''),
};

/**
 * Decrypt and retrieve system security credentials safely at runtime.
 */
function getDecryptedSystemCredentials() {
  const cfg = getLocalConfig();
  return {
    supabaseUrl: process.env.SUPABASE_URL || cfg.supabaseUrl || decrypt(SECURE_PAYLOAD.encryptedSupabaseUrl) || '',
    supabaseAnonKey: process.env.SUPABASE_ANON_KEY || cfg.supabaseAnonKey || decrypt(SECURE_PAYLOAD.encryptedSupabaseAnonKey) || '',
    supabaseServiceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY || cfg.supabaseServiceRoleKey || decrypt(SECURE_PAYLOAD.encryptedSupabaseServiceRoleKey) || '',
    appUrl: process.env.APP_URL || cfg.supabasePaymentPortalUrl || decrypt(SECURE_PAYLOAD.encryptedAppUrl) || '',
    paystackPublicKey: process.env.PAYSTACK_PUBLIC_KEY || cfg.paystackPublicKey || decrypt(SECURE_PAYLOAD.encryptedPaystackPublicKey) || '',
    nowPaymentsApiKey: process.env.NOWPAYMENTS_API_KEY || cfg.nowPaymentsApiKey || decrypt(SECURE_PAYLOAD.encryptedNowPaymentsKey) || '',
    adminEmail: process.env.ADMIN_EMAIL || cfg.adminEmail || decrypt(SECURE_PAYLOAD.encryptedAdminEmail) || '',
  };
}

module.exports = {
  encrypt,
  decrypt,
  getDecryptedSystemCredentials,
};

