/**
 * background.js — Extension service worker
 *
 * Handles:
 *   - chrome.runtime.onInstalled: first-install setup and update logging
 *
 * Future steps will add alarm scheduling, event listeners, etc.
 */

import storage from './lib/storage.js';
import { invalidateCache, getDepth, isDepthAtMost2, walkSubtree } from './lib/tree.js';
import { addSuppression, cleanExpiredSuppressions } from './lib/suppression.js';
import { notifyRemoved, notifyCreated } from './lib/bulk-import.js';
import { takeSnapshot } from './lib/undo.js';
import { rebuildFolder } from './lib/rebuild.js';
import { initTracker } from './lib/tracker.js';

// ---------------------------------------------------------------------------
// populateEnabledFolders
// ---------------------------------------------------------------------------

/**
 * Walk the full bookmark tree and add every folder at depth <= 2 to
 * storage.local.enabledFolders with default settings.
 *
 * Depth definition (from lib/tree.js):
 *   depth 1 = ids "1", "2", "3"  (Bookmarks Bar, Other Bookmarks, Mobile Bookmarks)
 *   depth 2 = direct children of "1"/"2"/"3" that are folders
 *
 * Both depth-1 roots and depth-2 folder children are included.
 * The hidden super-root (id "0") is never passed to getDepth.
 *
 * @returns {Promise<void>}
 */
async function populateEnabledFolders() {
  const rootArray = await chrome.bookmarks.getTree();

  // enabledFolders may already have entries (unlikely on fresh install, but safe
  // to merge rather than overwrite so we don't clobber any existing config).
  const existing = (await storage.local.get('enabledFolders')) ?? {};
  const updated  = { ...existing };

  /**
   * Recursively walk the tree, tracking the title path and current depth.
   * Only adds folder nodes (no `url` property) at depth <= 2.
   * Does NOT descend into nodes deeper than depth 2 (we only want the top two levels).
   *
   * @param {chrome.bookmarks.BookmarkTreeNode} node
   * @param {number}   depth      - 0 for the super-root, 1 for roots 1/2/3, 2 for their children
   * @param {string[]} titlePath  - Ancestor titles accumulated so far
   */
  function visit(node, depth, titlePath) {
    // Skip the hidden super-root (id "0") — descend straight into its children
    if (node.id === '0') {
      if (node.children) {
        for (const child of node.children) {
          visit(child, 1, []);
        }
      }
      return;
    }

    const isFolder = node.url === undefined;

    if (isFolder && depth >= 1 && depth <= 2) {
      // Only add if not already present (preserve any existing user config)
      if (!updated[node.id]) {
        updated[node.id] = {
          mruEnabled:      true,
          sortEnabled:     true,
          candidateScope:  'subtree',
          lastUserEditAt:  null,
          path:            [...titlePath, node.title],
        };
      }

      // Descend into depth-1 roots to find their depth-2 folder children,
      // but do NOT descend further (depth 3+ is out of scope for this function).
      if (depth === 1 && node.children) {
        for (const child of node.children) {
          visit(child, 2, [...titlePath, node.title]);
        }
      }
      // depth === 2: do not recurse further
    }
    // depth === 0 is handled by the id "0" guard at the top;
    // depth > 2: skip (we only want <= 2).
  }

  // getTree() returns an array with one element: the super-root (id "0")
  for (const root of rootArray) {
    visit(root, 0, []);
  }

  await storage.local.set('enabledFolders', updated);

  console.log(
    '[background] populateEnabledFolders: added/merged',
    Object.keys(updated).length,
    'folders'
  );
}

// ---------------------------------------------------------------------------
// onInstalled handler
// ---------------------------------------------------------------------------

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  if (reason === 'install') {
    // 1. Record installation timestamp
    await storage.local.set('installedAt', Date.now());

    // 2. Populate enabledFolders with all depth <= 2 folders
    await populateEnabledFolders();

    // 3. Register the hourly rebuild alarm
    chrome.alarms.create('rebuild', { periodInMinutes: 60 });

    // 4. Open the onboarding tab
    chrome.tabs.create({ url: chrome.runtime.getURL('onboarding.html') });

    // 5. Run startup initialization (service workers don't fire onStartup on first install)
    await onStartup();
  }

  if (reason === 'update') {
    // Schema migrations only — lib/storage.js handles this on next read
    // No onboarding, no rebuild, no snapshot
    console.log('[background] extension updated — schema migrations will run on next storage read');
  }
});

// ---------------------------------------------------------------------------
// Shared helpers (Step 11)
// ---------------------------------------------------------------------------

/**
 * Recursively collect all ids in a removed node tree (from onRemoved removeInfo.node).
 * @param {chrome.bookmarks.BookmarkTreeNode} node
 * @param {string[]} result
 * @returns {string[]}
 */
function collectRemovedIds(node, result = []) {
  result.push(node.id);
  if (node.children) {
    for (const child of node.children) collectRemovedIds(child, result);
  }
  return result;
}

/**
 * Walk up from nodeId's parent, stamping lastUserEditAt = Date.now() on every
 * ancestor that is in enabledFolders (i.e., depth ≤ 2 folders).
 * Writes the updated enabledFolders back to storage.
 * @param {string} nodeId
 * @returns {Promise<void>}
 */
async function stampLastUserEditAt(nodeId) {
  const enabledFolders = (await storage.local.get('enabledFolders')) ?? {};
  let currentId;
  try {
    const nodes = await chrome.bookmarks.get(nodeId);
    currentId = nodes[0]?.parentId;
  } catch { return; }

  let changed = false;
  while (currentId && currentId !== '0') {
    if (enabledFolders[currentId]) {
      enabledFolders[currentId].lastUserEditAt = Date.now();
      changed = true;
    }
    if (currentId === '1' || currentId === '2' || currentId === '3') break;
    try {
      const nodes = await chrome.bookmarks.get(currentId);
      currentId = nodes[0]?.parentId;
    } catch { break; }
  }
  if (changed) await storage.local.set('enabledFolders', enabledFolders);
}

// ---------------------------------------------------------------------------
// Handler: onRemoved (Step 11)
// ---------------------------------------------------------------------------

async function handleRemoved(id, removeInfo) {
  // Reactive cleanup — no snapshot needed; next scheduled rebuild provides the snapshot safety net.
  try {
    const currentJob = await storage.local.get('currentJob');
    if (currentJob) return;

    // Check if this is a bulk import situation (large subtree removal).
    // notifyRemoved returns true when it detects > 50 leaf bookmarks removed
    // at once, enters a monitoring window, and takes over cleanup responsibility.
    const isBulkImport = notifyRemoved(removeInfo.node);
    if (isBulkImport) return; // bulk-import.js takes over

    const removedIds = collectRemovedIds(removeInfo.node);

    // Read all relevant maps upfront
    let duplicates = (await storage.local.get('duplicates')) ?? {};
    let enabledFolders = (await storage.local.get('enabledFolders')) ?? {};
    let folderHashes = (await storage.local.get('folderHashes')) ?? {};

    // Build a reverse lookup: originalId → [duplicateId, ...]
    const originalToDups = {};
    for (const [dupId, dup] of Object.entries(duplicates)) {
      if (!originalToDups[dup.originalId]) originalToDups[dup.originalId] = [];
      originalToDups[dup.originalId].push(dupId);
    }

    for (const removedId of removedIds) {
      // Case (a): removedId is an ORIGINAL
      if (originalToDups[removedId]) {
        const dupIds = originalToDups[removedId];

        // Delete duplicates from map
        for (const dupId of dupIds) {
          delete duplicates[dupId];
        }

        // Write updated duplicates BEFORE calling chrome.bookmarks.remove
        // (cascade safety: cascading onRemoved for the duplicate will see
        // an already-cleaned map and won't add spurious suppressions)
        await storage.local.set('duplicates', duplicates);

        // Remove actual duplicate bookmarks (best-effort)
        for (const dupId of dupIds) {
          try {
            await chrome.bookmarks.remove(dupId);
          } catch (e) {
            console.error('[background] onRemoved failed to remove duplicate', dupId, e);
          }
        }

        // Also clean up counts
        const counts = (await storage.local.get('counts')) ?? {};
        delete counts[removedId];
        await storage.local.set('counts', counts);

        // Refresh local reference after storage write
        duplicates = (await storage.local.get('duplicates')) ?? {};

      // Case (b): removedId is a DUPLICATE
      } else if (duplicates[removedId]) {
        const dup = duplicates[removedId];
        await addSuppression(dup.originalId, dup.parentFolderId);
        delete duplicates[removedId];
        await storage.local.set('duplicates', duplicates);
      }

      // Case (c): removedId is an ENABLED FOLDER
      if (enabledFolders[removedId]) {
        delete enabledFolders[removedId];
        delete folderHashes[removedId];
        await storage.local.set('enabledFolders', enabledFolders);
        await storage.local.set('folderHashes', folderHashes);
      }
    }

    // Invalidate tree cache; pass knownParentId since the node no longer exists
    await invalidateCache(removeInfo.node.id, removeInfo.parentId);

  } catch (e) {
    console.error('[background] onRemoved error', e);
  }
}

// ---------------------------------------------------------------------------
// Handler: onChanged (Step 11)
// ---------------------------------------------------------------------------

async function handleChanged(id, changeInfo) {
  // Reactive cleanup — no snapshot needed; next scheduled rebuild provides the snapshot safety net.
  try {
    const currentJob = await storage.local.get('currentJob');
    if (currentJob) return;

    const duplicates = (await storage.local.get('duplicates')) ?? {};

    // Collect all duplicates whose originalId === id
    const affectedDups = Object.entries(duplicates)
      .filter(([, dup]) => dup.originalId === id);

    if (affectedDups.length === 0) return;

    const mruPrefix = (await storage.sync.get('mruPrefix')) ?? '★ ';

    console.log(
      '[background] onChanged original=%s propagating to %d duplicates',
      id,
      affectedDups.length
    );

    for (const [dupId] of affectedDups) {
      const updateFields = {};
      if (changeInfo.title !== undefined) updateFields.title = mruPrefix + changeInfo.title;
      if (changeInfo.url !== undefined) updateFields.url = changeInfo.url;
      if (Object.keys(updateFields).length > 0) {
        try {
          await chrome.bookmarks.update(dupId, updateFields);
        } catch (e) {
          console.error('[background] onChanged update failed', e);
        }
      }
    }

    // Stamp lastUserEditAt on the original bookmark's parent folder
    await stampLastUserEditAt(id);

  } catch (e) {
    console.error('[background] onChanged error', e);
  }
}

// ---------------------------------------------------------------------------
// Handler: onMoved (Step 11)
// ---------------------------------------------------------------------------

async function handleMoved(id, moveInfo) {
  // Reactive cleanup — no snapshot needed; next scheduled rebuild provides the snapshot safety net.
  try {
    const currentJob = await storage.local.get('currentJob');
    if (currentJob) return;

    let duplicates = (await storage.local.get('duplicates')) ?? {};

    // Case A: id is a DUPLICATE moved out of its registered parentFolderId
    if (duplicates[id] && duplicates[id].parentFolderId !== moveInfo.newParentId) {
      const dup = duplicates[id];

      // Strip mruPrefix from title
      const mruPrefix = (await storage.sync.get('mruPrefix')) ?? '★ ';
      try {
        const nodes = await chrome.bookmarks.get(id);
        const currentTitle = nodes[0]?.title ?? '';
        const strippedTitle = currentTitle.startsWith(mruPrefix)
          ? currentTitle.slice(mruPrefix.length)
          : currentTitle;
        await chrome.bookmarks.update(id, { title: strippedTitle });
      } catch (e) {
        console.error('[background] onMoved strip prefix failed', e);
      }

      // Add 7-day suppression using OLD parentFolderId
      await addSuppression(dup.originalId, dup.parentFolderId);

      delete duplicates[id];
      await storage.local.set('duplicates', duplicates);

      console.log('[background] onMoved duplicate=%s moved out of MRU folder', id);

    } else {
      // Case B: check if id is a FOLDER (no url property)
      let node;
      try {
        const nodes = await chrome.bookmarks.get(id);
        node = nodes[0];
      } catch (e) {
        console.error('[background] onMoved could not get node', id, e);
        return;
      }

      if (node && node.url === undefined) {
        // It's a folder
        let newDepth;
        try {
          newDepth = await getDepth(id);
        } catch (e) {
          console.error('[background] onMoved getDepth(new) failed', e);
          return;
        }

        // Old depth: parent's depth + 1
        let oldDepth;
        try {
          const oldParentDepth = await getDepth(moveInfo.oldParentId);
          oldDepth = oldParentDepth + 1;
        } catch (e) {
          console.error('[background] onMoved getDepth(old) failed', e);
          return;
        }

        let enabledFolders = (await storage.local.get('enabledFolders')) ?? {};
        let folderHashes = (await storage.local.get('folderHashes')) ?? {};
        let changed = false;

        if (oldDepth <= 2 && newDepth > 2) {
          // Moved deeper — remove from enabledFolders
          if (enabledFolders[id]) {
            delete enabledFolders[id];
            delete folderHashes[id];
            changed = true;
          }
        } else if (oldDepth > 2 && newDepth <= 2) {
          // Moved shallower — add to enabledFolders with defaults
          if (!enabledFolders[id]) {
            enabledFolders[id] = {
              mruEnabled: true,
              sortEnabled: true,
              candidateScope: 'subtree',
              lastUserEditAt: null,
              path: [],
            };
            changed = true;
          }
        }

        if (changed) {
          await storage.local.set('enabledFolders', enabledFolders);
          await storage.local.set('folderHashes', folderHashes);
        }

        // Invalidate tree cache for old and new parents
        await invalidateCache(moveInfo.oldParentId);
        await invalidateCache(moveInfo.newParentId);
      }
    }

    // Stamp lastUserEditAt on DESTINATION parent folder and its ancestors
    // We stamp relative to moveInfo.newParentId by using a synthetic lookup:
    // stampLastUserEditAt walks up from nodeId's parentId, so we pass id
    // and let it find newParentId as the parent (the move already happened).
    await stampLastUserEditAt(id);

  } catch (e) {
    console.error('[background] onMoved error', e);
  }
}

// ---------------------------------------------------------------------------
// Handler: onCreated (Step 11)
// ---------------------------------------------------------------------------

async function handleCreated(id, bookmark) {
  // Reactive cleanup — no snapshot needed; next scheduled rebuild provides the snapshot safety net.
  try {
    const currentJob = await storage.local.get('currentJob');
    if (currentJob) return;

    notifyCreated(); // notify bulk-import detector (no-op when not monitoring)

    // Invalidate tree cache for the new node's parent
    await invalidateCache(bookmark.parentId);

    // Check if new node is a FOLDER (no url = folder)
    if (bookmark.url === undefined) {
      let atMost2;
      try {
        atMost2 = await isDepthAtMost2(id);
      } catch (e) {
        console.error('[background] onCreated isDepthAtMost2 failed', e);
        atMost2 = false;
      }

      if (atMost2) {
        const enabledFolders = (await storage.local.get('enabledFolders')) ?? {};
        if (!enabledFolders[id]) {
          enabledFolders[id] = {
            mruEnabled: true,
            sortEnabled: true,
            candidateScope: 'subtree',
            lastUserEditAt: null,
            path: [],
          };
          await storage.local.set('enabledFolders', enabledFolders);
          console.log('[background] onCreated new folder at depth ≤ 2: id=%s', id);
        }
      }
    }

    // Stamp lastUserEditAt on the parent folder and its ancestors
    await stampLastUserEditAt(id);

  } catch (e) {
    console.error('[background] onCreated error', e);
  }
}

// ---------------------------------------------------------------------------
// Bookmark event handlers (Step 11)
// ---------------------------------------------------------------------------

chrome.bookmarks.onRemoved.addListener(handleRemoved);
chrome.bookmarks.onChanged.addListener(handleChanged);
chrome.bookmarks.onMoved.addListener(handleMoved);
chrome.bookmarks.onCreated.addListener(handleCreated);

// ---------------------------------------------------------------------------
// Startup initialization (Step 13)
// ---------------------------------------------------------------------------

/**
 * Run on every service-worker startup and on first install.
 * Registers webNavigation listener, cleans expired suppressions,
 * and recovers from any stale job left by a previous crash.
 */
async function onStartup() {
  initTracker();  // register webNavigation listener
  await cleanExpiredSuppressions();
  await checkStaleJob();
}

chrome.runtime.onStartup.addListener(() => onStartup());

// ---------------------------------------------------------------------------
// Stale-job recovery (Step 13)
// ---------------------------------------------------------------------------

/**
 * If a currentJob was recorded more than 10 minutes ago the service worker
 * likely crashed mid-run.  Clear the flag and raise staleJobDetected so the
 * popup can show a warning badge.
 */
async function checkStaleJob() {
  const job = await storage.local.get('currentJob');
  if (!job) return;
  const ageMs = Date.now() - job.startedAt;
  if (ageMs > 10 * 60 * 1000) {  // > 10 minutes
    // Clear the stale job and flag for popup to show badge
    await storage.local.set('currentJob', null);
    await storage.local.set('staleJobDetected', true);
    console.log('[background] stale currentJob cleared after %d minutes', Math.round(ageMs / 60000));
  }
}

// ---------------------------------------------------------------------------
// Core rebuild orchestration (Step 13)
// ---------------------------------------------------------------------------

/**
 * Run a full scheduled rebuild.
 * @param {{ ignoreNextRunAt?: boolean, ignoreIdle?: boolean }} opts
 */
async function runRebuild(opts = {}) {
  const [primaryDeviceId, deviceId] = await Promise.all([
    storage.sync.get('primaryDeviceId'),
    storage.local.get('deviceId'),
  ]);
  if (!primaryDeviceId || primaryDeviceId !== deviceId) return;  // not primary

  const now = Date.now();

  if (!opts.ignoreNextRunAt) {
    const nextRunAt = await storage.local.get('nextRunAt');
    if (nextRunAt && now < nextRunAt) return;  // not due yet
  }

  if (!opts.ignoreIdle) {
    const idleState = await chrome.idle.queryState(60);
    if (idleState === 'active') {
      await storage.local.set('nextRunAt', now + 15 * 60 * 1000);
      console.log('[background] rebuild deferred 15m (device active)');
      return;
    }
  }

  // Primary-handoff reconciliation (if newly became primary)
  await maybeReconcileOnHandoff(primaryDeviceId);

  // Take snapshot BEFORE any mutations
  await takeSnapshot('Pre-scheduled rebuild');

  // Set currentJob
  await storage.local.set('currentJob', { startedAt: now, kind: 'scheduled' });

  try {
    await executeRebuild(now);
  } finally {
    await storage.local.set('currentJob', null);
  }
}

/**
 * The actual rebuild loop: load all data, run depth-≤2 folders bottom-up,
 * then run deep folders (alphabetical sort only), then update timestamps.
 * @param {number} now
 */
async function executeRebuild(now) {
  // Load all data once
  const [localData, syncData] = await Promise.all([
    loadLocalRebuildData(),
    loadSyncRebuildData(),
  ]);

  const { enabledFolders } = localData;

  // --- Depth ≤ 2 folders: full rebuild (MRU + sort) ---
  // Sort depth-2 folders before depth-1 (bottom-up so subtree caches are warm)
  const depthOneFolders = ['1', '2', '3'].filter(id => enabledFolders[id]);
  const depthTwoFolders = Object.keys(enabledFolders).filter(id => !['1', '2', '3'].includes(id));

  for (const folderId of [...depthTwoFolders, ...depthOneFolders]) {
    const settings = enabledFolders[folderId] ?? {};
    const options = buildFolderOptions(folderId, settings, localData, syncData);
    const result = await rebuildFolder(folderId, options);
    if (result.errors.length > 0) {
      console.warn('[background] rebuildFolder errors for folder %s:', folderId, result.errors);
    }
  }

  // --- Depth > 2 folders: alphabetical sort only ---
  await rebuildDeepFolders(localData, syncData);

  // Update run timestamps
  const scheduleDays = syncData.scheduleDays ?? 1;
  const nextRunAt = (typeof scheduleDays === 'number')
    ? now + scheduleDays * 86_400_000
    : null;  // "manual" schedule

  await Promise.all([
    storage.local.set('nextRunAt', nextRunAt),
    storage.local.set('lastRebuildCompletedAt', now),
    // Write final state of folderHashes and duplicates (already written per-folder by rebuildFolder, but ensure final state is persisted)
  ]);

  console.log('[background] rebuild complete');
}

// ---------------------------------------------------------------------------
// Data loading helpers (Step 13)
// ---------------------------------------------------------------------------

async function loadLocalRebuildData() {
  const [counts, duplicates, suppression, enabledFolders, folderHashes, lastRebuildCompletedAt] =
    await Promise.all([
      storage.local.get('counts'),
      storage.local.get('duplicates'),
      storage.local.get('suppression'),
      storage.local.get('enabledFolders'),
      storage.local.get('folderHashes'),
      storage.local.get('lastRebuildCompletedAt'),
    ]);
  return {
    counts: counts ?? {},
    duplicates: duplicates ?? {},
    suppression: suppression ?? [],
    enabledFolders: enabledFolders ?? {},
    folderHashes: folderHashes ?? {},
    lastRebuildCompletedAt: lastRebuildCompletedAt ?? null,
  };
}

async function loadSyncRebuildData() {
  const [mruEnabledGlobally, mruItemsPerFolder, mruMinSubtreeSize, mruPrefix, defaultCandidateScope,
         duplicateCap, sortBookmarksBar, sortOtherBookmarks, sortMobileBookmarks, scheduleDays] =
    await Promise.all([
      storage.sync.get('mruEnabledGlobally'),
      storage.sync.get('mruItemsPerFolder'),
      storage.sync.get('mruMinSubtreeSize'),
      storage.sync.get('mruPrefix'),
      storage.sync.get('defaultCandidateScope'),
      storage.sync.get('duplicateCap'),
      storage.sync.get('sortBookmarksBar'),
      storage.sync.get('sortOtherBookmarks'),
      storage.sync.get('sortMobileBookmarks'),
      storage.sync.get('scheduleDays'),
    ]);
  return {
    mruEnabledGlobally: mruEnabledGlobally ?? true,
    mruItemsPerFolder: mruItemsPerFolder ?? 5,
    mruMinSubtreeSize: mruMinSubtreeSize ?? 8,
    mruPrefix: mruPrefix ?? '★ ',
    defaultCandidateScope: defaultCandidateScope ?? 'subtree',
    duplicateCap: duplicateCap ?? 500,
    sortBookmarksBar: sortBookmarksBar ?? false,
    sortOtherBookmarks: sortOtherBookmarks ?? true,
    sortMobileBookmarks: sortMobileBookmarks ?? false,
    scheduleDays: scheduleDays ?? 1,
  };
}

// ---------------------------------------------------------------------------
// Folder options builder (Step 13)
// ---------------------------------------------------------------------------

/**
 * Build the options object to pass to rebuildFolder for a given folder.
 * Applies root sort overrides for the three depth-1 roots ("1", "2", "3").
 */
function buildFolderOptions(folderId, settings, localData, syncData) {
  // Root sort overrides for the three depth-1 roots
  let sortEnabled = settings.sortEnabled ?? true;
  if (folderId === '1') sortEnabled = syncData.sortBookmarksBar;
  if (folderId === '2') sortEnabled = syncData.sortOtherBookmarks;
  if (folderId === '3') sortEnabled = syncData.sortMobileBookmarks;

  return {
    mruEnabled: (syncData.mruEnabledGlobally) && (settings.mruEnabled ?? true),
    sortEnabled,
    candidateScope: settings.candidateScope ?? syncData.defaultCandidateScope,
    lastUserEditAt: settings.lastUserEditAt ?? null,
    counts: localData.counts,
    duplicates: localData.duplicates,     // shared, mutated in-place
    suppression: localData.suppression,
    folderHashes: localData.folderHashes, // shared, mutated in-place
    lastRebuildCompletedAt: localData.lastRebuildCompletedAt,
    mruItemsPerFolder: syncData.mruItemsPerFolder,
    mruMinSubtreeSize: syncData.mruMinSubtreeSize,
    mruPrefix: syncData.mruPrefix,
    duplicateCap: syncData.duplicateCap,
  };
}

// ---------------------------------------------------------------------------
// Deep folder rebuild — depth > 2 alphabetical sort only (Step 13)
// ---------------------------------------------------------------------------

/**
 * Walk the full tree, find all folders at depth > 2, and rebuild each with
 * mruEnabled: false and sortEnabled: true (alphabetical sort only).
 */
async function rebuildDeepFolders(localData, syncData) {
  const tree = await chrome.bookmarks.getTree();
  const deepFolderIds = [];

  function collectDeepFolders(node, depth) {
    if (node.id === '0') {
      (node.children ?? []).forEach(c => collectDeepFolders(c, 1));
      return;
    }
    if (!node.url && depth > 2) deepFolderIds.push(node.id);
    if (!node.url) {
      (node.children ?? []).forEach(c => collectDeepFolders(c, depth + 1));
    }
  }
  collectDeepFolders(tree[0], 0);

  for (const folderId of deepFolderIds) {
    const options = buildFolderOptions(folderId, { sortEnabled: true }, localData, syncData);
    options.mruEnabled = false;  // depth > 2 never gets MRU
    await rebuildFolder(folderId, options).catch(e =>
      console.error('[background] deep folder rebuild error for %s', folderId, e)
    );
  }
}

// ---------------------------------------------------------------------------
// Primary-handoff reconciliation (Step 13)
// ---------------------------------------------------------------------------

/**
 * If the primary device has changed (handoff from another device to this one),
 * reconcile the duplicates map so stale MRU entries don't persist.
 * @param {string} currentPrimary
 */
async function maybeReconcileOnHandoff(currentPrimary) {
  const lastKnownPrimary = await storage.local.get('lastKnownPrimary');
  if (lastKnownPrimary === currentPrimary) return;  // no change

  // Became primary (or first ever rebuild as primary) — update lastKnownPrimary
  await storage.local.set('lastKnownPrimary', currentPrimary);

  if (lastKnownPrimary === null || lastKnownPrimary === undefined) return;  // first-ever primary claim, no reconciliation needed

  // Primary changed from a different device to this one — reconcile duplicates map
  // by scanning depth-≤2 folders for mruPrefix-titled children
  console.log('[background] primary handoff detected, reconciling duplicates map');
  await reconcileDuplicatesMap();
}

/**
 * Scan all depth-≤2 folders for children whose title starts with mruPrefix.
 * Rebuild the duplicates map from what's actually in the tree.
 *
 * Known v1 limitation: user bookmarks with ★ prefix will be falsely treated
 * as duplicates — documented as a known limitation.
 */
async function reconcileDuplicatesMap() {
  // No direct chrome.storage.* calls — all via storage wrapper (invariant 1)
  const mruPrefix = (await storage.sync.get('mruPrefix')) ?? '★ ';
  const enabledFolders = (await storage.local.get('enabledFolders')) ?? {};
  const duplicates = {};

  for (const folderId of Object.keys(enabledFolders)) {
    let children;
    try {
      children = await chrome.bookmarks.getChildren(folderId);
    } catch { continue; }

    const prefixedChildren = children.filter(c => c.url && c.title.startsWith(mruPrefix));
    if (!prefixedChildren.length) continue;

    // Build URL → original map for this subtree (all non-prefixed bookmarks)
    const urlToOriginal = new Map();
    await walkSubtree(folderId, node => {
      if (node.url && !node.title.startsWith(mruPrefix)) {
        if (!urlToOriginal.has(node.url)) urlToOriginal.set(node.url, node.id);
      }
    });

    for (const child of prefixedChildren) {
      const originalId = urlToOriginal.get(child.url);
      if (originalId) {
        duplicates[child.id] = {
          originalId,
          parentFolderId: folderId,
          originalUrl: child.url,
          createdAt: Date.now(),
        };
      }
      // If no match: treat as user-prefixed regular bookmark, leave alone
    }
  }

  await storage.local.set('duplicates', duplicates);
  console.log('[background] reconcileDuplicatesMap: found %d duplicates', Object.keys(duplicates).length);
}

// ---------------------------------------------------------------------------
// Alarm handler and manual rebuild message listener (Step 13)
// ---------------------------------------------------------------------------

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== 'rebuild') return;
  try {
    await runRebuild({});
  } catch (e) {
    console.error('[background] alarm rebuild error', e);
  }
});

/**
 * Message listener for popup "Rebuild now" button.
 * popup.js sends: { action: 'rebuildNow' }
 * Response: { ok: true } or { ok: false, error: string }
 */
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.action === 'rebuildNow') {
    runRebuild({ ignoreNextRunAt: true, ignoreIdle: true })
      .then(() => sendResponse({ ok: true }))
      .catch(e => sendResponse({ ok: false, error: String(e) }));
    return true;  // keep channel open for async response
  }
});
