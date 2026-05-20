/**
 * background.js — Extension service worker
 *
 * Handles:
 *   - chrome.runtime.onInstalled: first-install setup and update logging
 *
 * Future steps will add alarm scheduling, event listeners, etc.
 */

import storage from './lib/storage.js';

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

    // 3. Open the onboarding tab
    chrome.tabs.create({ url: chrome.runtime.getURL('onboarding.html') });
  }

  if (reason === 'update') {
    // Schema migrations only — lib/storage.js handles this on next read
    // No onboarding, no rebuild, no snapshot
    console.log('[background] extension updated — schema migrations will run on next storage read');
  }
});
