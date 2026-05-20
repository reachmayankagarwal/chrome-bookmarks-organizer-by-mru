/**
 * lib/duplicates.js — Duplicate bookmark registry
 *
 * Tracks which bookmark IDs are duplicates of an original so that click
 * counts and MRU promotions are always attributed to the canonical original.
 *
 * Public API
 * ----------
 *   recordDuplicate(duplicateId, originalId, parentFolderId, originalUrl) → Promise<void>
 *   getOriginalId(bookmarkId)                                              → Promise<string>
 *
 * Storage
 * -------
 *   storage.local.duplicates:
 *     { [duplicateId]: { originalId, parentFolderId, originalUrl, createdAt } }
 *
 * All log lines are prefixed `[duplicates]`.
 */

import storage from './storage.js';

// ---------------------------------------------------------------------------
// recordDuplicate
// ---------------------------------------------------------------------------

/**
 * Records a duplicate bookmark entry so future clicks on `duplicateId` can be
 * attributed to `originalId`.
 *
 * @param {string} duplicateId     - The bookmark ID that is the duplicate
 * @param {string} originalId      - The canonical bookmark ID it duplicates
 * @param {string} parentFolderId  - The folder containing the duplicate
 * @param {string} originalUrl     - The URL shared by both bookmarks
 * @returns {Promise<void>}
 */
export async function recordDuplicate(duplicateId, originalId, parentFolderId, originalUrl) {
  const duplicates = (await storage.local.get('duplicates')) ?? {};

  duplicates[duplicateId] = {
    originalId,
    parentFolderId,
    originalUrl,
    createdAt: Date.now(),
  };

  await storage.local.set('duplicates', duplicates);

  console.log(`[duplicates] recordDuplicate duplicate=%s original=%s`, duplicateId, originalId);
}

// ---------------------------------------------------------------------------
// getOriginalId
// ---------------------------------------------------------------------------

/**
 * Returns the canonical (original) bookmark ID for a given bookmark ID.
 * If the ID is recorded as a duplicate, returns its originalId.
 * Otherwise returns the ID unchanged (identity — not a duplicate).
 *
 * @param {string} bookmarkId
 * @returns {Promise<string>}
 */
export async function getOriginalId(bookmarkId) {
  const duplicates = (await storage.local.get('duplicates')) ?? {};

  if (duplicates[bookmarkId]) {
    return duplicates[bookmarkId].originalId;
  }

  return bookmarkId;
}
