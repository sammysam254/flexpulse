'use strict';

const logger = require('../utils/logger');
const { killTunnel } = require('../services/tunnel-service');
const { killStreamServer } = require('../services/stream-service');

/**
 * Active Device Sessions Map
 * key: serial (string)
 */
const activeSessions = new Map();

/**
 * Add or update an active device session.
 *
 * @param {string} serial
 * @param {object} sessionData
 */
function addDevice(serial, sessionData) {
  const model = sessionData.model || sessionData.deviceModel || 'SM-A042F';
  const brand = sessionData.brand || sessionData.deviceBrand || 'samsung';

  activeSessions.set(serial, {
    serial,
    port: sessionData.port,
    tunnelProcess: sessionData.tunnelProcess || null,
    streamProcess: sessionData.streamProcess || null,
    publicUrl: sessionData.publicUrl || null,
    localUrl: sessionData.localUrl || `http://localhost:${sessionData.port}`,
    streamUrl: sessionData.streamUrl || sessionData.publicUrl || sessionData.localUrl || `http://localhost:${sessionData.port}`,
    model: model,
    brand: brand,
    paymentStatus: sessionData.paymentStatus || 'unpaid',
    isPaid: sessionData.isPaid || false,
    monthlyFeeUsd: sessionData.monthlyFeeUsd || 30,
    startedAt: new Date().toISOString(),
  });

  logger.info(`Process manager: registered device ${serial}`, {
    port: sessionData.port,
    model: model,
    brand: brand,
    rentalPaid: sessionData.isPaid || false,
  });
}

/**
 * Retrieve session data for a specific device.
 * @param {string} serial
 * @returns {object|null}
 */
function getDevice(serial) {
  return activeSessions.get(serial) || null;
}

/**
 * List all active device serial numbers.
 * @returns {string[]}
 */
function getActiveSerials() {
  return Array.from(activeSessions.keys());
}

/**
 * Return summary list of all active devices for API responses / dashboard.
 * @returns {Array<{ serial: string, model: string, brand: string, port: number, streamUrl: string, isPaid: boolean, paymentStatus: string, monthlyFeeUsd: number }>}
 */
function getActiveDeviceSummaries() {
  const seenPorts = new Set();
  const seenSerials = new Set();
  const summaries = [];

  // Sort entries so physical hardware serials (non-IP) come first
  const entries = Array.from(activeSessions.entries()).sort(([a], [b]) => {
    const aIsIp = a.includes(':');
    const bIsIp = b.includes(':');
    if (aIsIp && !bIsIp) return 1;
    if (!aIsIp && bIsIp) return -1;
    return 0;
  });

  for (const [key, session] of entries) {
    if (!session || !session.port) continue;
    const primarySerial = session.hardwareSerial || session.serial || key;
    if (seenPorts.has(session.port) || seenSerials.has(primarySerial)) {
      continue;
    }
    seenPorts.add(session.port);
    seenSerials.add(primarySerial);

    summaries.push({
      serial: primarySerial,
      adbSerial: session.adbSerial || key,
      hardwareSerial: session.hardwareSerial || primarySerial,
      model: session.model,
      brand: session.brand,
      port: session.port,
      streamUrl: session.streamUrl,
      paymentStatus: session.paymentStatus,
      isPaid: session.isPaid,
      monthlyFeeUsd: session.monthlyFeeUsd,
      isWifi: session.isWifi,
      isUsb: session.isUsb,
    });
  }
  return summaries;
}

/**
 * Kill all processes associated with a specific device.
 * Called when a device disconnects or errors out.
 *
 * @param {string} serial
 */
function killDeviceProcesses(serial) {
  const session = activeSessions.get(serial);
  if (!session) {
    logger.warn(`No active session found to kill for ${serial}`);
    return;
  }

  logger.info(`Killing processes for disconnected device ${serial}`);

  // Kill tunnel process
  if (session.tunnelProcess) {
    try {
      killTunnel(session.tunnelProcess);
      logger.info(`Terminated tunnel process for ${serial}`);
    } catch (err) {
      logger.error(`Error killing tunnel for ${serial}:`, err.message);
    }
  }

  // Kill stream server process
  if (session.streamProcess) {
    try {
      killStreamServer(session.streamProcess);
      logger.info(`Terminated stream server for ${serial}`);
    } catch (err) {
      logger.error(`Error killing stream server for ${serial}:`, err.message);
    }
  }

  activeSessions.delete(serial);
  logger.info(`Removed session state for ${serial}`);
}

/**
 * Kill ALL active device sessions.
 * Called during application shutdown.
 */
function killAllProcesses() {
  const serials = getActiveSerials();
  logger.info(`Killing all processes for ${serials.length} active device(s)`);

  for (const serial of serials) {
    killDeviceProcesses(serial);
  }

  logger.info('All device sessions terminated');
}

/**
 * Get the count of active devices.
 * @returns {number}
 */
function getActiveCount() {
  return activeSessions.size;
}

module.exports = {
  addDevice,
  getDevice,
  getActiveSerials,
  getActiveDeviceSummaries,
  killDeviceProcesses,
  killAllProcesses,
  getActiveCount,
  getDeviceCount: getActiveCount,
  stopAll: killAllProcesses,
};
