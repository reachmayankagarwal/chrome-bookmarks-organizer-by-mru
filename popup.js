/**
 * popup.js — Popup UI logic for the Bookmark Organizer extension.
 *
 * Invariant: no chrome.storage.* calls here. All storage access goes through
 * lib/storage.js via the storage.local / storage.sync API.
 */

import storage from './lib/storage.js';
import { updateKnownDevices, maybeAutoClaimPrimary } from './lib/device.js';
import { isUndoAvailable, listSnapshots, restoreSnapshot } from './lib/undo.js';
import { recordClick } from './lib/tracker.js';

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

document.addEventListener('DOMContentLoaded', () => { initPopup(); });

// ---------------------------------------------------------------------------
// initPopup
// ---------------------------------------------------------------------------

async function initPopup() {
  // 1. Update known devices + maybe auto-claim (30-day inert path)
  await updateKnownDevices();
  const autoClaimed = await maybeAutoClaimPrimary();
  if (autoClaimed) {
    showAutoclaimBanner(autoClaimed.deviceName);
  }

  // 2. Load storage data
  const [primaryDeviceId, primaryDeviceName, deviceId,
         firstRunCompleted, lastRebuildCompletedAt, nextRunAt, scheduleDays,
         duplicates, enabledFolders, counts, staleJobDetected] = await Promise.all([
    storage.sync.get('primaryDeviceId'),
    storage.sync.get('primaryDeviceName'),
    storage.local.get('deviceId'),
    storage.local.get('firstRunCompleted'),
    storage.local.get('lastRebuildCompletedAt'),
    storage.local.get('nextRunAt'),
    storage.sync.get('scheduleDays'),
    storage.local.get('duplicates'),
    storage.local.get('enabledFolders'),
    storage.local.get('counts'),
    storage.local.get('staleJobDetected'),
  ]);

  const isPrimary = primaryDeviceId && primaryDeviceId === deviceId;
  const hasPrimary = !!primaryDeviceId;

  // 3. Stale-job banner
  if (staleJobDetected) {
    document.getElementById('stale-banner').classList.remove('hidden');
    await storage.local.set('staleJobDetected', false);  // clear flag
  }

  // 4. Device banner (non-primary only)
  if (!isPrimary) {
    const banner = document.getElementById('device-banner');
    banner.classList.remove('hidden');
    if (!hasPrimary) {
      banner.innerHTML = 'Pick a primary device to start organizing. <a href="#" id="link-to-devices">Go to settings</a>';
    } else {
      banner.textContent = `Secondary device — rebuilds run on ${primaryDeviceName}. Click tracking active here.`;
    }
  }

  // 5. Status line (primary only)
  if (isPrimary) {
    renderStatusLine(lastRebuildCompletedAt, nextRunAt, scheduleDays, firstRunCompleted, duplicates);
  }

  // 6. Footprint line
  const dupCount = Object.keys(duplicates ?? {}).length;
  const folderCount = Object.keys(enabledFolders ?? {}).length;
  document.getElementById('footprint-line').textContent =
    `Maintaining ${dupCount} duplicate${dupCount !== 1 ? 's' : ''} across ${folderCount} folder${folderCount !== 1 ? 's' : ''}.`;

  // 7. Buttons
  await setupButtons(isPrimary, primaryDeviceName);

  // 8. Quick search
  setupSearch(counts ?? {});

  // 9. Top 5
  renderTop5(counts ?? {});

  // 10. Footer links
  document.getElementById('link-options').addEventListener('click', (e) => {
    e.preventDefault();
    chrome.tabs.create({ url: chrome.runtime.getURL('options.html') });
  });
  document.getElementById('link-teardown').addEventListener('click', (e) => {
    e.preventDefault();
    chrome.tabs.create({ url: chrome.runtime.getURL('options.html#teardown') });
  });
  document.getElementById('link-to-devices')?.addEventListener('click', (e) => {
    e.preventDefault();
    chrome.tabs.create({ url: chrome.runtime.getURL('options.html#devices') });
  });

  // 11. Stale restore link
  document.getElementById('stale-restore')?.addEventListener('click', async (e) => {
    e.preventDefault();
    await doUndo();
  });
}

// ---------------------------------------------------------------------------
// renderStatusLine
// ---------------------------------------------------------------------------

function renderStatusLine(lastAt, nextAt, scheduleDays, firstRunCompleted, duplicates) {
  const el = document.getElementById('status-line');
  const parts = [];

  if (lastAt) {
    parts.push(`Last rebuild: ${timeAgo(lastAt)}`);
  }

  if (scheduleDays === 'manual') {
    parts.push('Manual only');
  } else if (nextAt) {
    parts.push(`Next: ${timeUntil(nextAt)}`);
  }

  el.textContent = parts.join(' · ');

  // MRU notice: firstRun done but no duplicates yet
  if (firstRunCompleted && Object.keys(duplicates ?? {}).length === 0) {
    el.textContent += ' — MRU regions appear after next rebuild.';
  }
}

// ---------------------------------------------------------------------------
// Time helpers
// ---------------------------------------------------------------------------

function timeAgo(ms) {
  const diff = Date.now() - ms;
  const mins = Math.round(diff / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(diff / 3600000);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(diff / 86400000)}d ago`;
}

function timeUntil(ms) {
  const diff = ms - Date.now();
  if (diff <= 0) return 'soon';
  const mins = Math.round(diff / 60000);
  if (mins < 60) return `in ${mins}m`;
  const hours = Math.round(diff / 3600000);
  if (hours < 24) return `in ${hours}h`;
  return `in ${Math.round(diff / 86400000)}d`;
}

// ---------------------------------------------------------------------------
// setupButtons
// ---------------------------------------------------------------------------

async function setupButtons(isPrimary, primaryDeviceName) {
  const btnRebuild = document.getElementById('btn-rebuild');
  const btnUndo = document.getElementById('btn-undo');

  // Rebuild button
  if (!isPrimary) {
    btnRebuild.disabled = true;
    btnRebuild.title = primaryDeviceName
      ? `Rebuilds run on ${primaryDeviceName}`
      : 'No primary device selected';
  } else {
    btnRebuild.addEventListener('click', async () => {
      btnRebuild.disabled = true;
      btnRebuild.textContent = 'Rebuilding…';
      try {
        await chrome.runtime.sendMessage({ action: 'rebuildNow' });
        btnRebuild.textContent = 'Done!';
      } catch (e) {
        btnRebuild.textContent = 'Failed';
        console.error('[popup] rebuild error', e);
      }
    });
  }

  // Undo button
  const undoAvailable = await isUndoAvailable();
  if (!undoAvailable) {
    btnUndo.disabled = true;
    btnUndo.title = 'No rebuild to undo (snapshots expire after 24h)';
  } else {
    const snapshots = await listSnapshots();
    if (snapshots.length > 0) {
      btnUndo.title = `Undo: ${snapshots[0].summary} (${timeAgo(snapshots[0].takenAt)})`;
    }
    btnUndo.addEventListener('click', async () => {
      btnUndo.disabled = true;
      btnUndo.textContent = 'Restoring…';
      await doUndo();
    });
  }
}

async function doUndo() {
  const snapshots = await listSnapshots();
  if (!snapshots.length) return;
  try {
    await restoreSnapshot(snapshots[0].takenAt);
    document.getElementById('btn-undo').textContent = 'Restored!';
  } catch (e) {
    document.getElementById('btn-undo').textContent = 'Failed';
    console.error('[popup] undo error', e);
  }
}

// ---------------------------------------------------------------------------
// setupSearch — live filter with debounce
// ---------------------------------------------------------------------------

function setupSearch(counts) {
  const input = document.getElementById('search-input');
  const resultList = document.getElementById('search-results');
  let searchTimer;

  input.addEventListener('input', () => {
    clearTimeout(searchTimer);
    const query = input.value.trim();
    if (!query) { resultList.classList.add('hidden'); resultList.innerHTML = ''; return; }
    searchTimer = setTimeout(async () => {
      const results = await chrome.bookmarks.search(query);
      const bookmarks = results.filter(r => r.url).slice(0, 10);
      renderResultList(resultList, bookmarks, counts);
      resultList.classList.toggle('hidden', bookmarks.length === 0);
    }, 200);  // 200ms debounce
  });
}

// ---------------------------------------------------------------------------
// renderTop5 — most-used bookmarks
// ---------------------------------------------------------------------------

async function renderTop5(counts) {
  const top5El = document.getElementById('top5-list');

  // Score: count * exp(-ageInDays / 30)  (same scoring as mru.js)
  const scored = Object.entries(counts)
    .map(([id, data]) => {
      const ageInDays = (Date.now() - (data.lastUsed ?? 0)) / 86_400_000;
      const score = (data.count ?? 0) * Math.exp(-ageInDays / 30);
      return { id, title: data.titleAtLastClick ?? data.url ?? id, url: data.url, score };
    })
    .filter(e => e.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);

  if (scored.length === 0) {
    top5El.innerHTML = '<li class="empty-note">No click data yet.</li>';
    return;
  }

  // Verify bookmarks still exist before showing
  const items = await Promise.all(scored.map(async e => {
    try {
      const nodes = await chrome.bookmarks.get(e.id);
      return nodes[0]?.url ? { ...e, title: nodes[0].title, url: nodes[0].url } : null;
    } catch { return null; }
  }));

  renderResultList(top5El, items.filter(Boolean).map(e => ({ id: e.id, title: e.title, url: e.url })), counts);
}

// ---------------------------------------------------------------------------
// renderResultList — shared renderer for search + top5
// ---------------------------------------------------------------------------

function renderResultList(listEl, bookmarks, counts) {
  listEl.innerHTML = '';
  for (const bm of bookmarks) {
    const li = document.createElement('li');
    li.textContent = bm.title || bm.url;
    li.title = bm.url;
    // Popup click = precise attribution (documented: popup clicks are exact, webNavigation is heuristic)
    li.addEventListener('click', async () => {
      await recordClick(bm.id);
      chrome.tabs.create({ url: bm.url });
    });
    listEl.appendChild(li);
  }
}

// ---------------------------------------------------------------------------
// showAutoclaimBanner
// ---------------------------------------------------------------------------

function showAutoclaimBanner(deviceName) {
  const banner = document.getElementById('autoclaim-banner');
  banner.textContent = `${deviceName} is now your primary device. Rebuild will run on schedule.`;
  banner.classList.remove('hidden');
}
