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

  const safeMruCount = Math.max(0, mruCount ?? 0);

  // Step 1: Get current children of folderId
  const children = await chrome.bookmarks.getChildren(folderId);

  // If folder is empty or has only MRU items, nothing to sort
  if (children.length <= safeMruCount) {
    return [];
  }

  // Step 2: Separate the sortable region (everything after the MRU region)
  const sortableRegion = children.slice(safeMruCount);

  // Step 3: Partition the sortable region into subfolders and bookmarks
  const subfolders  = sortableRegion.filter(node => node.url === undefined);
  const bookmarks   = sortableRegion.filter(node => node.url !== undefined);

  // Step 4: Sort each partition (only if the corresponding option is enabled)
  const sortedFolders   = sortFolders   ? sortByTitle(subfolders)  : subfolders;
  const sortedBookmarks = sortBookmarks ? sortByTitle(bookmarks)   : bookmarks;

  // Step 5: Desired order = [...sortedFolders, ...sortedBookmarks]
  //         starting at index safeMruCount (immediately after the MRU region)
  const desiredOrder = [...sortedFolders, ...sortedBookmarks];

  // Step 6: Always emit a move op for every item in desiredOrder.
  //         chrome.bookmarks.move to an already-correct position is a safe no-op,
  //         and skipping based on pre-move indices is incorrect because Chrome
  //         renumbers siblings in real time as each move is applied.
  const plan = [];

  for (let i = 0; i < desiredOrder.length; i++) {
    plan.push({
      type:     'move',
      id:       desiredOrder[i].id,
      parentId: folderId,
      index:    safeMruCount + i,
    });
  }

  return plan;
}
