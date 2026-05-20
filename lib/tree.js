/**
 * lib/tree.js — Chrome bookmark tree walkers, depth helpers, and subtree cache.
 *
 * The cache stores full subtree results keyed by folderId.
 * Invalidation removes the target folder AND all ancestors up to depth 1,
 * since their subtrees have changed.
 *
 * Cache invalidation is called explicitly by event handlers (Step 11).
 *
 * Depth definition:
 *   depth 1 = ids "1", "2", "3" (Bookmarks Bar, Other Bookmarks, Mobile Bookmarks)
 *   depth 2 = direct children of 1/2/3
 *   depth 3+ = deeper
 *   id "0" (hidden super-root) is illegal to pass — throws.
 */

// ---------------------------------------------------------------------------
// Subtree cache
// ---------------------------------------------------------------------------

/** @type {Map<string, BookmarkTreeNode[]>} */
const subtreeCache = new Map();

/**
 * Fetch the subtree rooted at folderId, using cache when available.
 *
 * @param {string} folderId
 * @returns {Promise<BookmarkTreeNode[]>}  The array returned by getSubTree (length 1, root node)
 */
async function fetchSubtree(folderId) {
  if (subtreeCache.has(folderId)) {
    return subtreeCache.get(folderId);
  }
  const result = await chrome.bookmarks.getSubTree(folderId);
  subtreeCache.set(folderId, result);
  return result;
}

/**
 * Invalidate cache for folderId AND walk up the ancestor chain (via parentId)
 * removing each ancestor from cache as well, up to but not including id "0".
 *
 * Called by event handlers when the tree changes.
 *
 * @param {string}      folderId
 * @param {string|null} [knownParentId=null]  When provided (e.g. from an onRemoved
 *   event), skip the chrome.bookmarks.get call for the starting node (which may
 *   no longer exist) and use this value as the first ancestor to walk from.
 * @returns {Promise<void>}
 */
export async function invalidateCache(folderId, knownParentId = null) {
  subtreeCache.delete(folderId);

  let currentId = knownParentId;
  if (!currentId) {
    try {
      const nodes = await chrome.bookmarks.get(folderId);
      currentId = nodes[0]?.parentId;
    } catch {
      // Node no longer exists (e.g. just removed) — can't walk ancestors.
      // Safe: the cache entry for folderId was already deleted above.
      return;
    }
  }

  // Walk up the ancestor chain
  while (currentId && currentId !== "0") {
    subtreeCache.delete(currentId);
    // Stop once we've cleared a depth-1 root — no need to go to "0"
    if (currentId === "1" || currentId === "2" || currentId === "3") {
      break;
    }
    try {
      const nodes = await chrome.bookmarks.get(currentId);
      currentId = nodes[0]?.parentId;
      if (!currentId || currentId === "0") {
        break;
      }
    } catch {
      break; // Can't continue walking
    }
  }
}

/**
 * Clear the entire subtree cache (e.g., on extension startup or full refresh).
 */
export function clearCache() {
  subtreeCache.clear();
}

// ---------------------------------------------------------------------------
// Depth helpers
// ---------------------------------------------------------------------------

/**
 * Returns the numeric depth of folderId.
 *   depth 1 = ids "1", "2", "3"
 *   depth 2 = direct children of "1"/"2"/"3"
 *   depth 3+ = deeper
 *
 * Throws if folderId is "0" (hidden super-root — callers must never pass it).
 *
 * @param {string} folderId
 * @returns {Promise<number>}
 */
export async function getDepth(folderId) {
  if (folderId === "0") {
    throw new Error('getDepth: folderId "0" is the hidden super-root; callers must not pass it.');
  }

  // Walk up the ancestor chain counting steps until we hit id "1", "2", or "3"
  let depth = 0;
  let currentId = folderId;

  while (true) {
    if (currentId === "1" || currentId === "2" || currentId === "3") {
      // We've reached a depth-1 root
      return depth + 1;
    }
    if (currentId === "0") {
      // Should not normally reach here — means node is not under the standard roots
      throw new Error(`getDepth: could not resolve depth for folderId "${folderId}"`);
    }

    const nodes = await chrome.bookmarks.get(currentId);
    const node = nodes[0];

    if (!node) {
      throw new Error(`getDepth: bookmark node "${currentId}" not found`);
    }

    if (!node.parentId || node.parentId === "0") {
      // Node is a direct child of the super-root — this is depth 1 (for ids 1/2/3)
      // but we already handled that above; any other node here is depth 1 effectively
      return 1;
    }

    depth++;
    currentId = node.parentId;
  }
}

/**
 * Returns true iff getDepth(folderId) <= 2.
 *
 * @param {string} folderId
 * @returns {Promise<boolean>}
 */
export async function isDepthAtMost2(folderId) {
  const depth = await getDepth(folderId);
  return depth <= 2;
}

// ---------------------------------------------------------------------------
// Tree walkers
// ---------------------------------------------------------------------------

/**
 * Walk every descendant of folderId, calling callback(node) for each.
 * Includes both folders and bookmarks. Does NOT include folderId itself.
 * Uses cached subtree data where available.
 *
 * @param {string}   folderId
 * @param {function(BookmarkTreeNode): void} callback
 * @returns {Promise<void>}
 */
export async function walkSubtree(folderId, callback) {
  const result = await fetchSubtree(folderId);
  const root = result[0];
  if (!root) return;

  // Iterative BFS/DFS through children — skip the root itself
  function walkChildren(node) {
    if (!node.children) return;
    for (const child of node.children) {
      callback(child);
      walkChildren(child);
    }
  }

  walkChildren(root);
}

/**
 * Count leaf bookmarks (nodes with a `url` property, i.e. not folders)
 * in folderId's subtree. Does NOT count folderId itself.
 *
 * @param {string} folderId
 * @returns {Promise<number>}
 */
export async function countLeafBookmarks(folderId) {
  let count = 0;
  await walkSubtree(folderId, (node) => {
    if (node.url !== undefined) {
      count++;
    }
  });
  return count;
}
