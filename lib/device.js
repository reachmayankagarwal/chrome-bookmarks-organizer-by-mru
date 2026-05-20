/**
 * lib/device.js — Device identity helpers
 *
 * Manages per-device identity (deviceId, deviceName) and the concept of a
 * "primary device" stored in chrome.storage.sync so it is shared across all
 * of the user's Chrome profiles.
 *
 * Public API
 * ----------
 *   getDeviceId()                          → Promise<string>
 *   getOrCreateDeviceName(platformInfo)    → Promise<string>
 *   isPrimaryDevice(syncData, localData)   → boolean  (synchronous)
 *   updateKnownDevices()                   → Promise<void>
 *   maybeAutoClaimPrimary()                → Promise<{ claimed: true, deviceName: string } | null>
 */

import storage from './storage.js';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** 30 days in milliseconds */
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Maps a chrome.runtime.getPlatformInfo() `os` value to a human-readable OS
 * label.
 *
 * @param {string} os - Value from platformInfo.os
 * @returns {string}
 */
function osLabel(os) {
  switch (os) {
    case 'mac':     return 'Mac';
    case 'win':     return 'Windows';
    case 'linux':   return 'Linux';
    case 'cros':    return 'ChromeOS';
    case 'android': return 'Android';
    case 'openbsd': return 'OpenBSD';
    default:
      // Fallback: capitalise first letter
      return os.charAt(0).toUpperCase() + os.slice(1);
  }
}

/**
 * Formats an epoch-ms timestamp as "Mon DD" (e.g. "Jan 5").
 *
 * @param {number} epochMs
 * @returns {string}
 */
function formatInstallDate(epochMs) {
  const date = new Date(epochMs);
  const month = date.toLocaleString('en-US', { month: 'short' });
  const day   = date.getDate();
  return `${month} ${day}`;
}

// ---------------------------------------------------------------------------
// Exported functions
// ---------------------------------------------------------------------------

/**
 * Returns the stable device ID for this Chrome profile.
 *
 * Generates a new UUID via `crypto.randomUUID()` on first call and persists it
 * to storage.local so subsequent calls return the same value.
 *
 * @returns {Promise<string>} The UUID string
 */
export async function getDeviceId() {
  let deviceId = await storage.local.get('deviceId');

  if (!deviceId) {
    deviceId = crypto.randomUUID();
    await storage.local.set('deviceId', deviceId);
  }

  return deviceId;
}

/**
 * Returns the human-readable display name for this device.
 *
 * If the user has already set a custom name it is returned unchanged.
 * Otherwise a default name is generated in the format:
 *   "Chrome on {OS} (installed {Mon DD})"
 * and stored for future calls.
 *
 * @param {{ os: string }} platformInfo - Object from chrome.runtime.getPlatformInfo()
 * @returns {Promise<string>} The device name
 */
export async function getOrCreateDeviceName(platformInfo) {
  let deviceName = await storage.local.get('deviceName');

  if (deviceName) {
    return deviceName;
  }

  // Build default name
  const os          = osLabel(platformInfo.os);
  const installedAt = await storage.local.get('installedAt');
  const dateMs      = installedAt != null ? installedAt : Date.now();
  const dateLabel   = formatInstallDate(dateMs);

  deviceName = `Chrome on ${os} (installed ${dateLabel})`;
  await storage.local.set('deviceName', deviceName);

  return deviceName;
}

/**
 * Synchronous helper that determines whether this device is the primary device.
 *
 * Both arguments must be pre-read data objects — no async work is performed.
 *
 * @param {{ primaryDeviceId?: string | null }} syncData  - Data read from storage.sync
 * @param {{ deviceId?: string | null }}        localData - Data read from storage.local
 * @returns {boolean}
 */
export function isPrimaryDevice(syncData, localData) {
  const primaryId = syncData?.primaryDeviceId;
  const localId   = localData?.deviceId;

  if (typeof primaryId !== 'string' || primaryId === '') return false;
  if (typeof localId   !== 'string' || localId   === '') return false;

  return primaryId === localId;
}

/**
 * Updates this device's entry in storage.sync.knownDevices with the current
 * timestamp, and — if this is the primary device — refreshes
 * storage.sync.primaryDeviceName.
 *
 * @returns {Promise<void>}
 */
export async function updateKnownDevices() {
  const [deviceId, deviceName, knownDevices, primaryDeviceId] = await Promise.all([
    storage.local.get('deviceId'),
    storage.local.get('deviceName'),
    storage.sync.get('knownDevices'),
    storage.sync.get('primaryDeviceId'),
  ]);

  // Guard: device must have an id before it can be registered
  if (!deviceId) return;

  const updatedDevices = {
    ...knownDevices,
    [deviceId]: {
      name:       deviceName ?? null,
      lastSeenAt: Date.now(),
    },
  };

  await storage.sync.set('knownDevices', updatedDevices);

  // Keep primaryDeviceName in sync if this is the primary device
  if (primaryDeviceId === deviceId && deviceName) {
    await storage.sync.set('primaryDeviceName', deviceName);
  }
}

/**
 * Attempts to auto-claim primary-device status for this device.
 *
 * Auto-claim only fires when ALL of the following conditions are met:
 *   1. No primary device is currently set in storage.sync
 *   2. `storage.local.installedAt` is set (not null)
 *   3. The installation is older than 30 days
 *
 * On success, writes `primaryDeviceId` and `primaryDeviceName` to storage.sync
 * and returns `{ claimed: true, deviceName }` so the popup can show a badge
 * and banner.
 *
 * @returns {Promise<{ claimed: true, deviceName: string } | null>}
 */
export async function maybeAutoClaimPrimary() {
  const [primaryDeviceId, installedAt, deviceId, deviceName] = await Promise.all([
    storage.sync.get('primaryDeviceId'),
    storage.local.get('installedAt'),
    storage.local.get('deviceId'),
    storage.local.get('deviceName'),
  ]);

  // Condition 0: device not yet initialized — do nothing
  if (!deviceId) return null;          // device not yet initialized

  // Condition 1: primary already set — do nothing
  if (primaryDeviceId) {
    return null;
  }

  // Condition 2: no install timestamp — too early to decide
  if (installedAt == null) {
    return null;
  }

  // Condition 3: installation is too recent
  if (Date.now() - installedAt < THIRTY_DAYS_MS) {
    return null;
  }

  // All conditions met — auto-claim
  await Promise.all([
    storage.sync.set('primaryDeviceId',   deviceId),
    storage.sync.set('primaryDeviceName', deviceName),
  ]);

  console.log(
    `[device] auto-claimed primary: deviceId=${deviceId} deviceName=${deviceName}`
  );

  return { claimed: true, deviceName };
}
