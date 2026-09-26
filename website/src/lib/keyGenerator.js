/**
 * Key and PIN Generator for Device Stream Access
 */

// Generates a 16-character random word + number key for URL stream link
export function generate16CharKey() {
  const words = ['flex', 'pulse', 'cloud', 'agent', 'cyber', 'hyper', 'nexus', 'shield', 'matrix', 'stream', 'turbo', 'quantum', 'vector', 'blaze', 'alpha', 'delta'];
  const w1 = words[Math.floor(Math.random() * words.length)];
  const w2 = words[Math.floor(Math.random() * words.length)];
  const num = Math.floor(1000 + Math.random() * 9000).toString();
  let key = `${w1}${w2}${num}`.toLowerCase();
  if (key.length > 16) key = key.substring(0, 16);
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  while (key.length < 16) {
    key += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return key;
}

// Generates a clean 6-digit PIN for stream unlock & dashboard copy
export function generate6DigitPin() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

export const DEFAULT_STREAM_DOMAIN = import.meta.env.VITE_STREAM_DOMAIN || 'https://stream.dennoh.site';

// Normalizes any device stream URL to ensure it always routes to stream.dennoh.site
export function normalizeStreamUrl(url, serial) {
  const baseDomain = (DEFAULT_STREAM_DOMAIN || 'https://stream.dennoh.site').replace(/\/+$/, '');
  if (!url) {
    return serial ? `${baseDomain}/?udid=${encodeURIComponent(serial)}` : baseDomain;
  }
  try {
    const raw = url.startsWith('http') ? url : `https://${url}`;
    const u = new URL(raw);
    const target = new URL(baseDomain.startsWith('http') ? baseDomain : `https://${baseDomain}`);
    
    // Rewrite host if it points to dennoh.site, agent.dennoh.site, localhost, or old diamt host
    if (u.hostname === 'agent.dennoh.site' || u.hostname === 'dennoh.site' || u.hostname.includes('diamt') || u.hostname.includes('localhost') || u.hostname.includes('127.0.0.1')) {
      u.protocol = target.protocol;
      u.host = target.host;
    }
    if (serial && !u.searchParams.get('udid')) {
      u.searchParams.set('udid', serial);
    }
    return u.toString();
  } catch (_) {
    return serial ? `${baseDomain}/?udid=${encodeURIComponent(serial)}` : baseDomain;
  }
}

// Constructs stream URL with 16-character key and 6-digit PIN strictly on stream.dennoh.site
export function rotateUrlWithKeyAndPin(currentUrl, serial, newKey, newPin) {
  const baseDomain = (DEFAULT_STREAM_DOMAIN || 'https://stream.dennoh.site').replace(/\/+$/, '');
  return `${baseDomain}/?udid=${encodeURIComponent(serial)}&key=${encodeURIComponent(newKey)}&pin=${encodeURIComponent(newPin)}`;
}
