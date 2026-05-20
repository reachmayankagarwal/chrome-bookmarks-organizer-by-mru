/**
 * lib/sorter.js — Alphabetical sort plan generator
 *
 * This module is PURE COMPUTATION. It reads the bookmark tree to determine
 * current positions, computes the desired sorted order, and returns a plan
 * of move operations as a plain array. It NEVER calls chrome.bookmarks.move
 * or any mutating Chrome API.
 *
 * The returned plan is an array of { type: 'move', id, parentId, index }
 * objects ordered such that applying them sequentially produces the desired
 * sorted state.
 */

import { sortByTitle } from './locale.js';

/**
 * Returns a plan of move operations needed to alphabetize a folder's children.
 *
 * @param {string} folderId  - The folder whose children to sort
 * @param {object} [options]
 * @param {boolean} [options.sortFolders=true]    - Sort subfolder children among each other
 * @param {boolean} [options.sortBookmarks=true]  - Sort bookmark children among each other
 * @param {number}  [options.mruCount=0]          - Number of leading children to leave untouched (MRU region)
 * @returns {Promise<Array<{type: 'move', id: string, parentId: string, index: number}>>}
 */
export async function planSortForFolder(folderId, options = {}) {
  const {
    sortFolders   = true,
    sortBookmarks = true,
    mruCount      = 0,
  } = options;

  // Step 1: Get current children of folderId
  const children = await chrome.bookmarks.getChildren(folderId);

  // If folder is empty or has only MRU items, nothing to sort
  if (children.length <= mruCount) {
    return [];
  }

  // Step 2: Separate the MRU region (leave untouched) from the sortable region
  const mruRegion      = children.slice(0, mruCount);
  const sortableRegion = children.slice(mruCount);

  // Step 3: Partition the sortable region into subfolders and bookmarks
  const subfolders  = sortableRegion.filter(node => node.url === undefined);
  const bookmarks   = sortableRegion.filter(node => node.url !== undefined);

  // Step 4: Sort each partition (only if the corresponding option is enabled)
  const sortedFolders   = sortFolders   ? sortByTitle(subfolders)  : subfolders;
  const sortedBookmarks = sortBookmarks ? sortByTitle(bookmarks)   : bookmarks;

  // Step 5: Desired order = [...sortedFolders, ...sortedBookmarks]
  //         starting at index mruCount (immediately after the MRU region)
  const desiredOrder = [...sortedFolders, ...sortedBookmarks];

  // Step 6: Build the plan — only emit a move op when the desired index differs
  //         from the item's current index in the full children array.
  //
  // We compare against sortableRegion's original positions (offset by mruCount).
  // The Chrome bookmarks API expects absolute index within the parent.
  const plan = [];

  for (let i = 0; i < desiredOrder.length; i++) {
    const desiredIndex  = mruCount + i;       // absolute index in parent
    const item          = desiredOrder[i];
    const currentIndex  = item.index;         // chrome provides this on the node

    if (currentIndex !== desiredIndex) {
      plan.push({
        type:     'move',
        id:       item.id,
        parentId: folderId,
        index:    desiredIndex,
      });
    }
  }

  return plan;
}
