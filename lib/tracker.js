/**
 * lib/tracker.js — Click tracking with dedup window
 *
 * Records how often each bookmark is visited so the MRU (most-recently-used)
 * feature can surface frequently-accessed bookmarks at the top of folders.
 *
 * Public API
 * ----------
 *   initTracker()                                    → void
 *   recordClick(bookmarkId, titleAtLastClick?)        → Promise<void>
 *   getOriginalForDuplicate(bookmarkId)               → Promise<string>
 *
 * Storage
 * -------
 *   storage.local.counts: { [bookmarkId]: { count, lastUsed, url, titleAtLastClick } }
 *
 * All log lines are prefixed `[tracker]`.
 */

import storage from './storage.js';
import { getOriginalId } from './duplicates.js';

// ---------------------------------------------------------------------------
// Dedup window
// ---------------------------------------------------------------------------

// Tracks the last time each bookmark id was recorded so rapid duplicate
// events from the same navigation are suppressed.
// Map<bookmarkId: string, recordedAtMs: number>
const dedupWindow = new Map();

const DEDUP_MS = 5000;

// ---------------------------------------------------------------------------
// Duplicate resolution
// ---------------------------------------------------------------------------

/**
 * Returns the canonical (original) bookmark id for a given id.
 * Delegates to lib/duplicates.js to perform a storage lookup.
 * Returns bookmarkId unchanged when it is not recorded as a duplicate.
 *
 * @param {string} bookmarkId
 * @returns {Promise<string>}
 */
export async function getOriginalForDuplicate(bookmarkId) {
  return getOriginalId(bookmarkId);
}

// ---------------------------------------------------------------------------
// Core recording
// ---------------------------------------------------------------------------

/**
 * Increments the click count for `bookmarkId` in storage.local.counts and
 * updates the dedup window so subsequent rapid navigations to the same
 * bookmark are ignored.
 *
 * @param {string}          bookmarkId
 * @param {string|undefined} titleAtLastClick  - Title to store; falls back to
 *                                               the bookmark's current title.
 * @returns {Promise<void>}
 */
export async function recordClick(bookmarkId, titleAtLastClick) {
  const counts = (await storage.local.get('counts')) ?? {};

  const nodes = await chrome.bookmarks.get(bookmarkId).catch(() => null);

  if (!nodes || nodes.length === 0 || !nodes[0].url) {
    return;
  }

  const node = nodes[0];
  const url   = node.url;
  const title = titleAtLastClick !== undefined ? titleAtLastClick : node.title;

  const existing = counts[bookmarkId] ?? {};
  const newCount = (existing.count ?? 0) + 1;

  counts[bookmarkId] = {
    count:            newCount,
    lastUsed:         Date.now(),
    url,
    titleAtLastClick: title,
  };

  await storage.local.set('counts', counts);

  dedupWindow.set(bookmarkId, Date.now());

  console.log(`[tracker] recordClick bookmarkId=%s count=%d`, bookmarkId, newCount);
}

// ---------------------------------------------------------------------------
// webNavigation listener
// ---------------------------------------------------------------------------

/**
 * Registers the webNavigation.onCommitted listener that heuristically
 * attributes navigations to bookmark clicks.
 *
 * Popup clicks are exact attribution; webNavigation clicks are heuristic —
 * transitionType "auto_bookmark" is a best-effort signal, not guaranteed to
 * be exclusive to bookmark clicks.
 */
export function initTracker() {
  chrome.webNavigation.onCommitted.addListener(
    handleNavigation,
    { url: [{ schemes: ['http', 'https'] }] }
  );
}

/**
 * webNavigation.onCommitted handler.
 * Only processes navigations whose transitionType is "auto_bookmark".
 *
 * @param {chrome.webNavigation.WebNavigationTransitionCallbackDetails} details
 */
async function handleNavigation(details) {
  if (details.transitionType !== 'auto_bookmark') {
    return;
  }

  const results = await chrome.bookmarks.search({ url: details.url }).catch(() => []);

  for (const node of results) {
    const resolvedId = await getOriginalForDuplicate(node.id);

    const lastRecorded = dedupWindow.get(resolvedId);
    if (lastRecorded !== undefined && Date.now() - lastRecorded < DEDUP_MS) {
      continue;
    }

    await recordClick(resolvedId, node.title);
  }
}
