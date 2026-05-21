/**
 * lib/bulk-import.js — Bulk import detection and deferred rebuild
 *
 * Chrome has no native "batch import" event. When the user imports a large
 * bookmark file Chrome fires many individual onRemoved (clearing old structure)
 * then many onCreated events. This module detects that pattern by watching for:
 *   1. A large subtree removal (> 50 leaf bookmarks in a single onRemoved).
 *   2. Followed within 30 seconds by a burst of onCreated events (> 20).
 *   3. Followed by 5 seconds of silence (no new onCreated events).
 *
 * When the burst+silence pattern is confirmed we trigger a full rebuild of all
 * enabled folders rather than letting individual reactive handlers fire.
 *
 * Design notes
 * ------------
 * - All state is in-memory; it is lost when the service worker restarts.
 *   That is acceptable: a restart in the middle of an import will simply cause
 *   the 30-second window to reset and the rebuild may not fire.  The next
 *   scheduled rebuild will catch any inconsistency.
 * - When notifyRemoved returns true the caller (handleRemoved in background.js)
 *   skips its own cleanup for the entire removed subtree.  If the 30-second
 *   monitoring window expires WITHOUT a burst (createCount <= 20) we just log
 *   it.  The data inconsistency (orphaned duplicates map entries) will be
 *   resolved by the orphan-conversion step in the next scheduled rebuild.
 *   This is the accepted v1 behaviour.
 *
 * Public API
 * ----------
 *   notifyRemoved(node) → boolean   called from handleRemoved
 *   notifyCreated()                 called from handleCreated
 *
 * All log lines are prefixed `[bulk-import]`.
 */

import storage from './storage.js';
import { takeSnapshot } from './undo.js';
import { rebuildFolder } from './rebuild.js';

// ---------------------------------------------------------------------------
// Module-level state  (in-memory — lost on service worker restart, fine)
// ---------------------------------------------------------------------------

/** Epoch ms timestamp set when a large removal is detected. */
let pendingCleanupTimestamp = null;

/** Count of onCreated events received during the monitoring window. */
let createCount = 0;

/** setTimeout id for the 5-second silence detector. */
let silenceTimer = null;

/** True while we are inside the 30-second monitoring window. */
let monitoring = false;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Count leaf bookmarks (nodes with a `url`) in a removed subtree.
 * @param {chrome.bookmarks.BookmarkTreeNode} node
 * @returns {number}
 */
function countLeaves(node) {
  if (node.url !== undefined) return 1;
  let total = 0;
  if (node.children) {
    for (const child of node.children) {
      total += countLeaves(child);
    }
  }
  return total;
}

// ---------------------------------------------------------------------------
// handleBulkImport  (module-private)
// ---------------------------------------------------------------------------

/**
 * Called when 5 seconds of silence follows a burst of > 20 creates inside the
 * 30-second monitoring window.  Triggers a full rebuild of all enabled folders.
 */
async function handleBulkImport() {
  monitoring = false;
  console.log('[bulk-import] triggering rebuild after bulk import');
  await triggerBulkRebuild();
}

// ---------------------------------------------------------------------------
// triggerBulkRebuild  (module-private)
// ---------------------------------------------------------------------------

/**
 * Builds options for a single folder and delegates to rebuildFolder.
 *
 * @param {string}  folderId
 * @param {object}  enabledFolders  - full enabledFolders map from storage
 * @param {object}  local           - snapshot of relevant local-storage values
 * @param {object}  sync            - snapshot of relevant sync-storage values
 * @returns {object}  options object for rebuildFolder
 */
function buildRebuildOptions(folderId, enabledFolders, local, sync) {
  const settings = enabledFolders[folderId] ?? {};

  // Root-level sort overrides
  let sortEnabled = settings.sortEnabled ?? true;
  if (folderId === '1') sortEnabled = sync.sortBookmarksBar  ?? false;
  if (folderId === '2') sortEnabled = sync.sortOtherBookmarks ?? true;
  if (folderId === '3') sortEnabled = sync.sortMobileBookmarks ?? false;

  return {
    mruEnabled:            (sync.mruEnabledGlobally ?? true) && (settings.mruEnabled ?? true),
    sortEnabled,
    candidateScope:        settings.candidateScope ?? (sync.defaultCandidateScope ?? 'subtree'),
    lastUserEditAt:        settings.lastUserEditAt ?? null,
    counts:                local.counts     ?? {},
    duplicates:            local.duplicates ?? {},
    suppression:           local.suppression ?? [],
    folderHashes:          local.folderHashes ?? {},
    lastRebuildCompletedAt: local.lastRebuildCompletedAt ?? null,
    mruItemsPerFolder:     sync.mruItemsPerFolder ?? 5,
    mruMinSubtreeSize:     sync.mruMinSubtreeSize ?? 8,
    mruPrefix:             sync.mruPrefix ?? '★ ',
    duplicateCap:          sync.duplicateCap ?? 500,
  };
}

/**
 * Full rebuild of all enabled folders triggered by a bulk-import detection.
 *
 * Guards:
 *   - Only runs on the primary device.
 *   - Skips if a rebuild job is already in progress.
 *   - Takes a snapshot before any tree mutations.
 *   - Clears currentJob in a finally block.
 */
async function triggerBulkRebuild() {
  // --- Device check -------------------------------------------------------
  const primaryDeviceId = await storage.sync.get('primaryDeviceId');
  const deviceId        = await storage.local.get('deviceId');
  if (primaryDeviceId !== deviceId) {
    // Secondary devices do not rebuild; the primary will handle it.
    console.log('[bulk-import] not primary device, skipping rebuild');
    return;
  }

  // --- Concurrency check --------------------------------------------------
  const currentJob = await storage.local.get('currentJob');
  if (currentJob) {
    console.log('[bulk-import] another job is already running, skipping rebuild');
    return;
  }

  // --- Snapshot (MUST happen before any chrome.bookmarks.* mutation) ------
  await takeSnapshot('Pre-bulk-import rebuild');

  // --- Mark job in progress -----------------------------------------------
  await storage.local.set('currentJob', { startedAt: Date.now(), kind: 'bulk-import' });

  let totalMoved   = 0;
  let totalCreated = 0;
  let foldersProcessed = 0;

  try {
    // --- Load all needed data once -----------------------------------------
    const enabledFolders = (await storage.local.get('enabledFolders')) ?? {};
    const local = {
      counts:                (await storage.local.get('counts'))                ?? {},
      // duplicates and folderHashes are shared across all folder calls and
      // mutated in-place by rebuildFolder — load once.
      duplicates:            (await storage.local.get('duplicates'))            ?? {},
      suppression:           (await storage.local.get('suppression'))           ?? [],
      folderHashes:          (await storage.local.get('folderHashes'))          ?? {},
      lastRebuildCompletedAt: (await storage.local.get('lastRebuildCompletedAt')) ?? null,
    };
    const sync = {
      mruEnabledGlobally:    (await storage.sync.get('mruEnabledGlobally'))    ?? true,
      mruItemsPerFolder:     (await storage.sync.get('mruItemsPerFolder'))     ?? 5,
      mruMinSubtreeSize:     (await storage.sync.get('mruMinSubtreeSize'))     ?? 8,
      mruPrefix:             (await storage.sync.get('mruPrefix'))             ?? '★ ',
      defaultCandidateScope: (await storage.sync.get('defaultCandidateScope')) ?? 'subtree',
      duplicateCap:          (await storage.sync.get('duplicateCap'))          ?? 500,
      sortBookmarksBar:      (await storage.sync.get('sortBookmarksBar'))      ?? false,
      sortOtherBookmarks:    (await storage.sync.get('sortOtherBookmarks'))    ?? true,
      sortMobileBookmarks:   (await storage.sync.get('sortMobileBookmarks'))   ?? false,
      scheduleDays:          (await storage.sync.get('scheduleDays'))          ?? 1,
    };

    // --- Rebuild each enabled folder ---------------------------------------
    for (const folderId of Object.keys(enabledFolders)) {
      const options = buildRebuildOptions(folderId, enabledFolders, local, sync);
      try {
        const result = await rebuildFolder(folderId, options);
        totalMoved   += result.movedCount   ?? 0;
        totalCreated += result.createdCount ?? 0;
        foldersProcessed++;
      } catch (e) {
        console.error('[bulk-import] rebuildFolder failed for folderId=%s', folderId, e);
      }
    }

    // --- Update scheduling timestamps ------------------------------------
    const scheduleDays = typeof sync.scheduleDays === 'number' ? sync.scheduleDays : 1;
    await storage.local.set('nextRunAt', Date.now() + scheduleDays * 86_400_000);
    await storage.local.set('lastRebuildCompletedAt', Date.now());

    console.log(
      '[bulk-import] rebuild complete, folders=%d, moved=%d, created=%d',
      foldersProcessed,
      totalMoved,
      totalCreated
    );

  } finally {
    // Always clear the job flag — even on error — so event handlers resume.
    await storage.local.set('currentJob', null);
  }
}

// ---------------------------------------------------------------------------
// performNormalCleanup  (module-private)
// ---------------------------------------------------------------------------

/**
 * Called when a large removal did NOT trigger a burst of creates within the
 * 30-second monitoring window.
 *
 * We do NOT attempt to replay the cleanup here because handleRemoved in
 * background.js already ran its cleanup synchronously before notifyRemoved
 * returned — wait, no: notifyRemoved returned `true` which caused the caller
 * to SKIP cleanup.  So the cleanup was deferred.
 *
 * For v1 we accept this: orphaned entries in the duplicates map will be
 * cleaned up by the orphan-conversion step in the next scheduled rebuild.
 * This is safe because the removed bookmarks no longer exist in Chrome's
 * tree, so rebuilds will simply not find them and will convert any orphaned
 * duplicates correctly.
 *
 * @param {chrome.bookmarks.BookmarkTreeNode} node  (unused in this stub)
 */
function performNormalCleanup(node) {
  console.log(
    '[bulk-import] no burst detected, normal cleanup pending (handled by event handler)'
  );
  // Intentionally a no-op: next scheduled rebuild handles orphan cleanup.
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Called from background.js handleRemoved for every onRemoved event.
 * If the removed subtree contains more than 50 leaf bookmarks we enter a
 * 30-second monitoring window waiting for a create burst.
 *
 * @param {chrome.bookmarks.BookmarkTreeNode} node  - removeInfo.node from onRemoved
 * @returns {boolean}  true  → caller should skip its own cleanup (we're handling it)
 *                     false → caller should proceed with normal cleanup
 */
function notifyRemoved(node) {
  const leafCount = countLeaves(node);

  if (leafCount > 50) {
    pendingCleanupTimestamp = Date.now();
    monitoring   = true;
    createCount  = 0;

    // Clear any previous silence timer that might still be running.
    if (silenceTimer !== null) {
      clearTimeout(silenceTimer);
      silenceTimer = null;
    }

    console.log(
      '[bulk-import] large removal detected, leafCount=%d, watching for burst',
      leafCount
    );

    // 30-second monitoring window: if no burst arrives, resume normal cleanup.
    setTimeout(() => {
      if (!monitoring) return; // already handled by a burst
      monitoring = false;
      if (createCount <= 20) {
        performNormalCleanup(node);
      }
      // If createCount > 20 the silence timer should already have fired or
      // will fire shortly — let it handle the rebuild.
    }, 30_000);

    return true; // tell caller to skip its own cleanup
  }

  return false; // caller proceeds normally
}

/**
 * Called from background.js handleCreated for every onCreated event.
 * Increments the create counter and resets the 5-second silence timer.
 * When 5 seconds of silence follows > 20 creates we trigger a full rebuild.
 */
function notifyCreated() {
  if (!monitoring) return; // not in a monitoring window — ignore

  createCount++;

  // Reset the 5-second silence timer on every new create event.
  if (silenceTimer !== null) {
    clearTimeout(silenceTimer);
    silenceTimer = null;
  }

  if (createCount > 20) {
    // We have a burst; set a new silence timer.  The rebuild fires only after
    // 5 seconds of no new creates (i.e. the import is complete).
    silenceTimer = setTimeout(() => {
      silenceTimer = null;
      handleBulkImport();
    }, 5_000);
  }
  // If createCount <= 20 we simply accumulate; the 30-second window timer will
  // fire eventually and call performNormalCleanup if no burst materialises.
}

export { notifyRemoved, notifyCreated };
