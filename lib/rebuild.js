/**
 * lib/rebuild.js — Per-folder rebuild enforcing the layout invariant:
 *   [MRU duplicates][sorted subfolders][sorted plain bookmarks]
 *
 * Errors are log-and-continue; this function never aborts mid-run.
 */

import storage from './storage.js';
import { sortByTitle } from './locale.js';
import { selectCandidates } from './mru.js';

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

/**
 * DJB2 hash — deterministic 32-bit hash used for folder state fingerprinting.
 * @param {string} str
 * @returns {string} hex string
 */
function djb2(str) {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash) ^ str.charCodeAt(i);
    hash |= 0; // keep 32-bit
  }
  return hash.toString(16);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

// Caller must call takeSnapshot() before invoking this function.
async function rebuildFolder(folderId, options) {
  const errors = [];
  let movedCount = 0;
  let updatedCount = 0;
  let createdCount = 0;
  let removedCount = 0;

  // -------------------------------------------------------------------------
  // Step 1 — Get current children
  // -------------------------------------------------------------------------
  let children;
  try {
    children = await chrome.bookmarks.getChildren(folderId);
  } catch (e) {
    console.error('[rebuild] %s failed for id=%s', 'getChildren', folderId, e);
    return {
      movedCount: 0,
      updatedCount: 0,
      createdCount: 0,
      removedCount: 0,
      errors: [{ op: 'getChildren', id: folderId, error: e }],
    };
  }

  // -------------------------------------------------------------------------
  // Step 2 — Orphan conversion
  // -------------------------------------------------------------------------
  for (const [duplicateId, dup] of Object.entries(options.duplicates)) {
    if (dup.parentFolderId !== folderId) continue;

    const originalId = dup.originalId;
    let originalGone = false;

    try {
      const results = await chrome.bookmarks.get(originalId);
      if (!results || results.length === 0) {
        originalGone = true;
      }
    } catch (e) {
      originalGone = true;
    }

    if (!originalGone) continue;

    // Original is gone — convert the duplicate to a regular bookmark
    const childNode = children.find(c => c.id === duplicateId);
    const rawTitle = childNode ? childNode.title : '';
    const strippedTitle = rawTitle.startsWith(options.mruPrefix)
      ? rawTitle.slice(options.mruPrefix.length)
      : rawTitle;

    try {
      await chrome.bookmarks.update(duplicateId, { title: strippedTitle });
      updatedCount++;
    } catch (e) {
      console.error('[rebuild] %s failed for id=%s', 'update-orphan', duplicateId, e);
      errors.push({ op: 'update-orphan', id: duplicateId, error: e });
    }

    // Always delete from duplicates map regardless of whether the update succeeded
    delete options.duplicates[duplicateId];
  }

  // -------------------------------------------------------------------------
  // Step 3 — Refresh children
  // -------------------------------------------------------------------------
  try {
    children = await chrome.bookmarks.getChildren(folderId);
  } catch (e) {
    console.error('[rebuild] %s failed for id=%s', 'getChildren-refresh', folderId, e);
    errors.push({ op: 'getChildren-refresh', id: folderId, error: e });
    return { movedCount, updatedCount, createdCount, removedCount, errors };
  }

  // -------------------------------------------------------------------------
  // Step 4 — Identify current duplicate ids in this folder
  // -------------------------------------------------------------------------
  const currentDupIds = new Set(
    Object.entries(options.duplicates)
      .filter(([, d]) => d.parentFolderId === folderId)
      .map(([id]) => id)
  );

  // -------------------------------------------------------------------------
  // Step 5 — Separate non-duplicate children
  // -------------------------------------------------------------------------
  const subfolders = children.filter(c => !c.url && !currentDupIds.has(c.id));
  const plainBookmarks = children.filter(c => c.url && !currentDupIds.has(c.id));

  // -------------------------------------------------------------------------
  // Step 6 — Sort-skip check
  // -------------------------------------------------------------------------
  const now = Date.now();
  const sevenDaysAgo = now - 7 * 24 * 60 * 60 * 1000;
  const skipSort = !options.sortEnabled ||
    (options.lastUserEditAt != null &&
     options.lastUserEditAt > Math.max(sevenDaysAgo, options.lastRebuildCompletedAt ?? 0));

  // -------------------------------------------------------------------------
  // Step 7 — Select MRU candidates
  // -------------------------------------------------------------------------
  const candidates = options.mruEnabled
    ? await selectCandidates(folderId, options.counts, options.duplicates, {
        mruItemsPerFolder: options.mruItemsPerFolder,
        mruMinSubtreeSize: options.mruMinSubtreeSize,
        duplicateCap: options.duplicateCap,
        candidateScope: options.candidateScope,
      }, options.suppression)
    : [];

  // -------------------------------------------------------------------------
  // Step 8 — Compute desired hash and check for early exit
  // -------------------------------------------------------------------------
  const sortedSubfolders = skipSort ? subfolders : sortByTitle(subfolders);
  const sortedBookmarks  = skipSort ? plainBookmarks : sortByTitle(plainBookmarks);

  const desiredState = JSON.stringify({
    mru:       candidates.map(c => c.id),
    folders:   sortedSubfolders.map(c => c.id),
    bookmarks: sortedBookmarks.map(c => c.id),
  });
  const desiredHash = djb2(desiredState);

  if (options.folderHashes[folderId] === desiredHash) {
    return { movedCount: 0, updatedCount: 0, createdCount: 0, removedCount: 0, errors };
  }

  // -------------------------------------------------------------------------
  // Step 9 — Build map: originalId → existing duplicateId in this folder
  // -------------------------------------------------------------------------
  const dupByOriginal = new Map(); // originalId → duplicateId
  for (const [id, d] of Object.entries(options.duplicates)) {
    if (d.parentFolderId === folderId) {
      dupByOriginal.set(d.originalId, id);
    }
  }

  // -------------------------------------------------------------------------
  // Step 10 — Remove obsolete duplicates (in folder but not in top-M candidates)
  // -------------------------------------------------------------------------
  const candidateIdSet = new Set(candidates.map(c => c.id));
  for (const [dupId, dup] of Object.entries(options.duplicates)) {
    if (dup.parentFolderId !== folderId) continue;
    if (candidateIdSet.has(dup.originalId)) continue;
    // This duplicate is no longer in top-M — remove
    try {
      await chrome.bookmarks.remove(dupId);
      delete options.duplicates[dupId];
      dupByOriginal.delete(dup.originalId);
      removedCount++;
    } catch (e) {
      console.error('[rebuild] %s failed for id=%s', 'remove-duplicate', dupId, e);
      errors.push({ op: 'remove-duplicate', id: dupId, error: e });
    }
  }

  // -------------------------------------------------------------------------
  // Step 11 — Create new duplicates / update existing
  // -------------------------------------------------------------------------
  const mruNodeIds = []; // actual node ids in MRU region order

  for (const candidate of candidates) {
    if (dupByOriginal.has(candidate.id)) {
      // Existing duplicate — check if refresh needed
      const dupId = dupByOriginal.get(candidate.id);
      const dup = options.duplicates[dupId];
      const desiredTitle = options.mruPrefix + candidate.title;
      // Get the current title from children
      const childNode = children.find(c => c.id === dupId);
      const needsUpdate = (dup.originalUrl !== candidate.url) ||
                          (childNode?.title !== desiredTitle);
      if (needsUpdate) {
        try {
          await chrome.bookmarks.update(dupId, { title: desiredTitle, url: candidate.url });
          options.duplicates[dupId].originalUrl = candidate.url;
          updatedCount++;
        } catch (e) {
          console.error('[rebuild] %s failed for id=%s', 'update-duplicate', dupId, e);
          errors.push({ op: 'update-duplicate', id: dupId, error: e });
        }
      }
      mruNodeIds.push(dupId);
    } else {
      // New duplicate — create
      // Note: double-prefix is intentional if original title already starts with mruPrefix
      try {
        const newNode = await chrome.bookmarks.create({
          parentId: folderId,
          title: options.mruPrefix + candidate.title,
          url: candidate.url,
        });
        options.duplicates[newNode.id] = {
          originalId: candidate.id,
          parentFolderId: folderId,
          originalUrl: candidate.url,
          createdAt: Date.now(),
        };
        dupByOriginal.set(candidate.id, newNode.id);
        mruNodeIds.push(newNode.id);
        createdCount++;
      } catch (e) {
        console.error('[rebuild] %s failed for id=%s', 'create-duplicate', candidate.id, e);
        errors.push({ op: 'create-duplicate', id: candidate.id, error: e });
      }
    }
  }

  // -------------------------------------------------------------------------
  // Step 12 — Execute moves
  // -------------------------------------------------------------------------
  const desiredOrder = [
    ...mruNodeIds,
    ...sortedSubfolders.map(c => c.id),
    ...sortedBookmarks.map(c => c.id),
  ];

  for (let i = 0; i < desiredOrder.length; i++) {
    try {
      await chrome.bookmarks.move(desiredOrder[i], { parentId: folderId, index: i });
      movedCount++;
    } catch (e) {
      console.error('[rebuild] %s failed for id=%s', 'move', desiredOrder[i], e);
      errors.push({ op: 'move', id: desiredOrder[i], error: e });
    }
  }

  // -------------------------------------------------------------------------
  // Step 13 — Persist changes
  // -------------------------------------------------------------------------
  options.folderHashes[folderId] = desiredHash;
  await storage.local.set('duplicates', options.duplicates);
  await storage.local.set('folderHashes', options.folderHashes);

  // -------------------------------------------------------------------------
  // Step 14 — Return stats
  // -------------------------------------------------------------------------
  return { movedCount, updatedCount, createdCount, removedCount, errors };
}

export { rebuildFolder };
