/**
 * lib/mru.js — MRU candidate selection with scoring and skip rules.
 *
 * Pure computation: no chrome.storage.* calls, no import of ./storage.js.
 * All inputs are passed as parameters.
 */

import { walkSubtree, countLeafBookmarks } from './tree.js';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Returns true if there is already a duplicate of `id` placed in `folderId`.
 *
 * @param {string} id
 * @param {string} folderId
 * @param {object} duplicates  storage.local.duplicates
 * @returns {boolean}
 */
function alreadyHasDuplicateInFolder(id, folderId, duplicates) {
  return Object.values(duplicates).some(
    (d) => d.originalId === id && d.parentFolderId === folderId
  );
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Compute the MRU candidate list for a given folder.
 *
 * @param {string} folderId
 * @param {object} counts       storage.local.counts
 * @param {object} duplicates   storage.local.duplicates
 * @param {object} mruSettings  { mruItemsPerFolder, mruMinSubtreeSize, duplicateCap, candidateScope }
 * @param {Array}  suppression  storage.local.suppression
 * @returns {Promise<Array<{id: string, title: string, url: string, score: number}>>}
 */
export async function selectCandidates(
  folderId,
  counts,
  duplicates,
  mruSettings,
  suppression
) {
  const {
    mruItemsPerFolder = 5,
    mruMinSubtreeSize = 8,
    duplicateCap = 500,
    candidateScope = 'subtree',
  } = mruSettings;

  // -------------------------------------------------------------------------
  // Step 1: Collect leaf bookmarks
  // -------------------------------------------------------------------------
  const candidates = [];
  let fullSubtreeLeafCount = 0;

  await walkSubtree(folderId, (node) => {
    if (node.url === undefined) return; // not a leaf bookmark

    fullSubtreeLeafCount++;

    // Exclude duplicates-of-duplicates
    if (Object.prototype.hasOwnProperty.call(duplicates, node.id)) return;

    // candidateScope === 'direct': only include direct children of folderId
    if (candidateScope === 'direct' && node.parentId !== folderId) return;

    candidates.push({
      id: node.id,
      title: node.title,
      url: node.url,
      parentId: node.parentId,
    });
  });

  // -------------------------------------------------------------------------
  // Step 2: Minimum subtree size check (always full subtree count)
  // -------------------------------------------------------------------------
  if (fullSubtreeLeafCount < mruMinSubtreeSize) {
    return [];
  }

  // -------------------------------------------------------------------------
  // Step 3: Score each candidate
  // -------------------------------------------------------------------------
  for (const candidate of candidates) {
    const entry = counts[candidate.id];
    const ageInDays = (Date.now() - (entry?.lastUsed ?? 0)) / 86_400_000;
    candidate.score = (entry?.count ?? 0) * Math.exp(-ageInDays / 30);
  }

  // -------------------------------------------------------------------------
  // Step 4: Sort — score desc → lastUsed desc → id asc
  // -------------------------------------------------------------------------
  candidates.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const aLast = counts[a.id]?.lastUsed ?? 0;
    const bLast = counts[b.id]?.lastUsed ?? 0;
    if (bLast !== aLast) return bLast - aLast;
    return a.id < b.id ? -1 : 1;
  });

  // -------------------------------------------------------------------------
  // Step 5: Apply skip rules and collect survivors
  // -------------------------------------------------------------------------
  const now = Date.now();
  const survivors = [];

  for (const candidate of candidates) {
    if (survivors.length >= mruItemsPerFolder) break;

    // Skip rule 1: original already lives in this folder
    if (candidate.parentId === folderId) continue;

    // Skip rule 2: suppressed
    if (
      suppression.some(
        (s) =>
          s.originalId === candidate.id &&
          s.parentFolderId === folderId &&
          s.until > now
      )
    ) {
      continue;
    }

    // Skip rule 3: duplicate cap reached and no existing duplicate in this folder
    if (
      Object.keys(duplicates).length >= duplicateCap &&
      !alreadyHasDuplicateInFolder(candidate.id, folderId, duplicates)
    ) {
      continue;
    }

    survivors.push({
      id: candidate.id,
      title: candidate.title,
      url: candidate.url,
      score: candidate.score,
    });
  }

  return survivors;
}
