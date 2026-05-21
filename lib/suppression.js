/**
 * lib/suppression.js — 7-day suppression helpers
 *
 * Prevents duplicate-detection prompts from reappearing for a bookmark pair
 * that the user has already dismissed, for a rolling 7-day window.
 *
 * Public API
 * ----------
 *   isSuppressed(originalId, parentFolderId)  → Promise<boolean>
 *   addSuppression(originalId, parentFolderId) → Promise<void>
 *   cleanExpiredSuppressions()                 → Promise<number>
 *
 * Storage
 * -------
 *   storage.local.suppression:
 *     [{ originalId, parentFolderId, until }]
 *
 * All log lines are prefixed `[suppression]`.
 */

import storage from './storage.js';

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// isSuppressed
// ---------------------------------------------------------------------------

/**
 * Returns true if there is a non-expired suppression entry for the given
 * (originalId, parentFolderId) pair.
 *
 * @param {string} originalId      - The canonical bookmark ID
 * @param {string} parentFolderId  - The folder containing the duplicate
 * @returns {Promise<boolean>}
 */
export async function isSuppressed(originalId, parentFolderId) {
  const suppression = (await storage.local.get('suppression')) ?? [];
  const now = Date.now();

  return suppression.some(
    s => s.originalId === originalId &&
         s.parentFolderId === parentFolderId &&
         s.until > now
  );
}

// ---------------------------------------------------------------------------
// addSuppression
// ---------------------------------------------------------------------------

/**
 * Adds (or refreshes) a 7-day suppression for the given (originalId,
 * parentFolderId) pair. Any existing entry for the same pair is replaced so
 * the window is always measured from the most recent dismissal.
 *
 * @param {string} originalId      - The canonical bookmark ID
 * @param {string} parentFolderId  - The folder containing the duplicate
 * @returns {Promise<void>}
 */
export async function addSuppression(originalId, parentFolderId) {
  const suppression = (await storage.local.get('suppression')) ?? [];

  // Remove any existing entry for this pair to avoid duplicates
  const filtered = suppression.filter(
    s => !(s.originalId === originalId && s.parentFolderId === parentFolderId)
  );

  const until = Date.now() + SEVEN_DAYS_MS;
  filtered.push({ originalId, parentFolderId, until });

  await storage.local.set('suppression', filtered);

  console.log(
    '[suppression] addSuppression originalId=%s parentFolderId=%s until=%d',
    originalId,
    parentFolderId,
    until
  );
}

// ---------------------------------------------------------------------------
// cleanExpiredSuppressions
// ---------------------------------------------------------------------------

/**
 * Removes all expired suppression entries from storage.
 * Skips the write if nothing was removed.
 *
 * @returns {Promise<number>} The number of entries removed
 */
export async function cleanExpiredSuppressions() {
  const suppression = (await storage.local.get('suppression')) ?? [];
  const now = Date.now();

  const filtered = suppression.filter(s => s.until > now);
  const removedCount = suppression.length - filtered.length;

  if (removedCount > 0) {
    await storage.local.set('suppression', filtered);
  }

  console.log('[suppression] cleanExpiredSuppressions removed=%d', removedCount);

  return removedCount;
}
