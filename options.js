/**
 * options.js — Options page controller (Step 15)
 *
 * Invariants:
 *   - No direct chrome.storage.* calls; all storage via storage.local / storage.sync.
 *   - Every path that calls chrome.bookmarks.* (teardown) calls takeSnapshot() first,
 *     and sets currentJob before any tree mutation, clearing it in a finally block.
 *   - currentJob is set before teardown to prevent background.js feedback loops.
 */

import storage from './lib/storage.js';
import { takeSnapshot, listSnapshots, restoreSnapshot } from './lib/undo.js';
import { getDeviceId, updateKnownDevices, isPrimaryDevice } from './lib/device.js';

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

/**
 * Show a "Saved" flash on the given element, then fade it out.
 * @param {HTMLElement} el
 */
function showSavedFlash(el) {
  el.classList.remove('hidden', 'fade-out');
  el.textContent = 'Saved';
  // Trigger fade after a short visible window
  setTimeout(() => {
    el.classList.add('fade-out');
    setTimeout(() => el.classList.add('hidden'), 1600);
  }, 1200);
}

/**
 * Show an error message in an element.
 * @param {HTMLElement} el
 * @param {string} msg
 */
function showError(el, msg) {
  el.textContent = msg;
  el.classList.remove('hidden');
}

/**
 * Clear an error/result element.
 * @param {HTMLElement} el
 */
function clearMsg(el) {
  el.textContent = '';
  el.classList.add('hidden');
}

/**
 * Format epoch ms as a readable local date+time string.
 * @param {number} ms
 * @returns {string}
 */
function formatDateTime(ms) {
  if (!ms) return '—';
  return new Date(ms).toLocaleString();
}

/**
 * Format epoch ms as a short date string (YYYY-MM-DD).
 * @param {number} ms
 * @returns {string}
 */
function formatDate(ms) {
  if (!ms) return '—';
  const d = new Date(ms);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// ---------------------------------------------------------------------------
// Section 1: Schedule
// ---------------------------------------------------------------------------

async function initSchedule() {
  const savedFlash = document.getElementById('schedule-saved');
  const currentVal = await storage.sync.get('scheduleDays');

  // Reflect current value in radio buttons
  const radios = document.querySelectorAll('input[name="scheduleDays"]');
  const strVal = String(currentVal ?? '1');
  for (const radio of radios) {
    radio.checked = radio.value === strVal;
  }

  // Auto-save on change
  for (const radio of radios) {
    radio.addEventListener('change', async () => {
      if (!radio.checked) return;
      const newVal = radio.value === 'manual' ? 'manual' : Number(radio.value);
      await storage.sync.set('scheduleDays', newVal);
      showSavedFlash(savedFlash);
    });
  }
}

// ---------------------------------------------------------------------------
// Section 2: MRU Region
// ---------------------------------------------------------------------------

async function initMru() {
  const savedFlash = document.getElementById('mru-saved');

  const [
    mruEnabledGlobally,
    mruItemsPerFolder,
    mruMinSubtreeSize,
    mruPrefix,
    defaultCandidateScope,
    duplicateCap,
  ] = await Promise.all([
    storage.sync.get('mruEnabledGlobally'),
    storage.sync.get('mruItemsPerFolder'),
    storage.sync.get('mruMinSubtreeSize'),
    storage.sync.get('mruPrefix'),
    storage.sync.get('defaultCandidateScope'),
    storage.sync.get('duplicateCap'),
  ]);

  // Global enable/disable
  const globalCheck = document.getElementById('mru-enabled-globally');
  globalCheck.checked = !!mruEnabledGlobally;
  globalCheck.addEventListener('change', async () => {
    await storage.sync.set('mruEnabledGlobally', globalCheck.checked);
    showSavedFlash(savedFlash);
  });

  // Items per folder
  const itemsInput = document.getElementById('mru-items-per-folder');
  itemsInput.value = mruItemsPerFolder ?? 5;
  itemsInput.addEventListener('change', async () => {
    const v = Math.max(3, Math.min(10, parseInt(itemsInput.value, 10) || 5));
    itemsInput.value = v;
    await storage.sync.set('mruItemsPerFolder', v);
    showSavedFlash(savedFlash);
  });

  // Min subtree size
  const minSubtreeInput = document.getElementById('mru-min-subtree');
  minSubtreeInput.value = mruMinSubtreeSize ?? 8;
  minSubtreeInput.addEventListener('change', async () => {
    const v = Math.max(1, parseInt(minSubtreeInput.value, 10) || 8);
    minSubtreeInput.value = v;
    await storage.sync.set('mruMinSubtreeSize', v);
    showSavedFlash(savedFlash);
  });

  // Prefix with live preview
  const prefixInput = document.getElementById('mru-prefix');
  const prefixPreview = document.getElementById('prefix-preview');
  prefixInput.value = mruPrefix ?? '★ ';
  prefixPreview.textContent = `e.g. ${mruPrefix ?? '★ '}GitHub`;

  prefixInput.addEventListener('input', () => {
    prefixPreview.textContent = `e.g. ${prefixInput.value}GitHub`;
  });
  prefixInput.addEventListener('change', async () => {
    await storage.sync.set('mruPrefix', prefixInput.value);
    showSavedFlash(savedFlash);
  });

  // Default candidate scope
  const scopeRadios = document.querySelectorAll('input[name="defaultCandidateScope"]');
  const scopeVal = defaultCandidateScope ?? 'subtree';
  for (const r of scopeRadios) {
    r.checked = r.value === scopeVal;
    r.addEventListener('change', async () => {
      if (!r.checked) return;
      await storage.sync.set('defaultCandidateScope', r.value);
      showSavedFlash(savedFlash);
    });
  }

  // Duplicate cap
  const dupCapInput = document.getElementById('duplicate-cap');
  dupCapInput.value = duplicateCap ?? 500;
  dupCapInput.addEventListener('change', async () => {
    const v = Math.max(1, parseInt(dupCapInput.value, 10) || 500);
    dupCapInput.value = v;
    await storage.sync.set('duplicateCap', v);
    showSavedFlash(savedFlash);
  });

  // Per-folder MRU overrides
  await renderMruFolderTable();
}

async function renderMruFolderTable() {
  const wrap = document.getElementById('mru-folder-table-wrap');
  const enabledFolders = (await storage.local.get('enabledFolders')) ?? {};

  // Only show depth-≤2 folders (path-based heuristic: depth ≤ 2 means ≤ 2 separators)
  const entries = Object.entries(enabledFolders).filter(([, v]) => {
    if (!v || typeof v.path !== 'string') return false;
    const depth = (v.path.match(/\//g) || []).length;
    return depth <= 2;
  });

  if (entries.length === 0) {
    wrap.innerHTML = '<span class="empty-note">No per-folder MRU overrides configured yet.</span>';
    return;
  }

  const table = document.createElement('table');
  table.className = 'folder-table';
  table.innerHTML = `
    <thead>
      <tr>
        <th>Folder</th>
        <th>MRU enabled</th>
        <th>Scope</th>
      </tr>
    </thead>
    <tbody></tbody>
  `;
  const tbody = table.querySelector('tbody');

  for (const [folderId, folderData] of entries) {
    const tr = document.createElement('tr');

    // Folder path cell
    const tdPath = document.createElement('td');
    tdPath.className = 'folder-path';
    tdPath.textContent = folderData.path || folderId;
    tr.appendChild(tdPath);

    // MRU enabled checkbox
    const tdMru = document.createElement('td');
    const mruCheck = document.createElement('input');
    mruCheck.type = 'checkbox';
    mruCheck.checked = !!folderData.mruEnabled;
    mruCheck.addEventListener('change', async () => {
      const ef = (await storage.local.get('enabledFolders')) ?? {};
      ef[folderId] = { ...(ef[folderId] ?? {}), mruEnabled: mruCheck.checked, lastUserEditAt: Date.now() };
      await storage.local.set('enabledFolders', ef);
    });
    tdMru.appendChild(mruCheck);
    tr.appendChild(tdMru);

    // Scope select
    const tdScope = document.createElement('td');
    const scopeSel = document.createElement('select');
    const optSubtree = new Option('Subtree', 'subtree');
    const optDirect = new Option('Direct children', 'direct');
    scopeSel.add(optSubtree);
    scopeSel.add(optDirect);
    scopeSel.value = folderData.candidateScope ?? 'subtree';
    scopeSel.addEventListener('change', async () => {
      const ef = (await storage.local.get('enabledFolders')) ?? {};
      ef[folderId] = { ...(ef[folderId] ?? {}), candidateScope: scopeSel.value, lastUserEditAt: Date.now() };
      await storage.local.set('enabledFolders', ef);
    });
    tdScope.appendChild(scopeSel);
    tr.appendChild(tdScope);

    tbody.appendChild(tr);
  }

  wrap.innerHTML = '';
  wrap.appendChild(table);
}

// ---------------------------------------------------------------------------
// Section 3: Alphabetical Sort
// ---------------------------------------------------------------------------

async function initSort() {
  const savedFlash = document.getElementById('sort-saved');

  const [sortBar, sortOther, sortMobile] = await Promise.all([
    storage.sync.get('sortBookmarksBar'),
    storage.sync.get('sortOtherBookmarks'),
    storage.sync.get('sortMobileBookmarks'),
  ]);

  const sortBarCheck = document.getElementById('sort-bookmarks-bar');
  const sortOtherCheck = document.getElementById('sort-other-bookmarks');
  const sortMobileCheck = document.getElementById('sort-mobile-bookmarks');

  sortBarCheck.checked = !!sortBar;
  sortOtherCheck.checked = !!sortOther;
  sortMobileCheck.checked = !!sortMobile;

  sortBarCheck.addEventListener('change', async () => {
    await storage.sync.set('sortBookmarksBar', sortBarCheck.checked);
    showSavedFlash(savedFlash);
  });
  sortOtherCheck.addEventListener('change', async () => {
    await storage.sync.set('sortOtherBookmarks', sortOtherCheck.checked);
    showSavedFlash(savedFlash);
  });
  sortMobileCheck.addEventListener('change', async () => {
    await storage.sync.set('sortMobileBookmarks', sortMobileCheck.checked);
    showSavedFlash(savedFlash);
  });

  // Per-folder sort overrides
  await renderSortFolderTable();
}

async function renderSortFolderTable() {
  const wrap = document.getElementById('sort-folder-table-wrap');
  const enabledFolders = (await storage.local.get('enabledFolders')) ?? {};

  const entries = Object.entries(enabledFolders).filter(([, v]) => {
    if (!v || typeof v.path !== 'string') return false;
    const depth = (v.path.match(/\//g) || []).length;
    return depth <= 2;
  });

  if (entries.length === 0) {
    wrap.innerHTML = '<span class="empty-note">No per-folder sort overrides configured yet.</span>';
    return;
  }

  const table = document.createElement('table');
  table.className = 'folder-table';
  table.innerHTML = `
    <thead>
      <tr>
        <th>Folder</th>
        <th>Sort enabled</th>
      </tr>
    </thead>
    <tbody></tbody>
  `;
  const tbody = table.querySelector('tbody');

  for (const [folderId, folderData] of entries) {
    const tr = document.createElement('tr');

    const tdPath = document.createElement('td');
    tdPath.className = 'folder-path';
    tdPath.textContent = folderData.path || folderId;
    tr.appendChild(tdPath);

    const tdSort = document.createElement('td');
    const sortCheck = document.createElement('input');
    sortCheck.type = 'checkbox';
    // Default sortEnabled to true when not explicitly set
    sortCheck.checked = folderData.sortEnabled !== false;
    sortCheck.addEventListener('change', async () => {
      const ef = (await storage.local.get('enabledFolders')) ?? {};
      ef[folderId] = { ...(ef[folderId] ?? {}), sortEnabled: sortCheck.checked, lastUserEditAt: Date.now() };
      await storage.local.set('enabledFolders', ef);
    });
    tdSort.appendChild(sortCheck);
    tr.appendChild(tdSort);

    tbody.appendChild(tr);
  }

  wrap.innerHTML = '';
  wrap.appendChild(table);
}

// ---------------------------------------------------------------------------
// Section 4: Devices
// ---------------------------------------------------------------------------

async function initDevices() {
  const deviceNameEl = document.getElementById('current-device-name');
  const deviceBadgeEl = document.getElementById('current-device-badge');
  const deviceNameInput = document.getElementById('device-name-input');
  const btnSaveName = document.getElementById('btn-save-device-name');
  const renameSaved = document.getElementById('device-rename-saved');
  const renameError = document.getElementById('device-rename-error');
  const knownDevicesList = document.getElementById('known-devices-list');
  const claimWrap = document.getElementById('btn-claim-primary-wrap');
  const btnClaim = document.getElementById('btn-claim-primary');
  const devicesError = document.getElementById('devices-error');

  async function reloadDevicesSection() {
    clearMsg(devicesError);
    try {
      const [deviceId, deviceName, primaryDeviceId, primaryDeviceName, knownDevices] = await Promise.all([
        storage.local.get('deviceId'),
        storage.local.get('deviceName'),
        storage.sync.get('primaryDeviceId'),
        storage.sync.get('primaryDeviceName'),
        storage.sync.get('knownDevices'),
      ]);

      // Current device summary
      deviceNameEl.textContent = deviceName || '(unnamed)';
      deviceNameInput.value = deviceName || '';

      const isThisPrimary = isPrimaryDevice({ primaryDeviceId }, { deviceId });
      const hasPrimary = typeof primaryDeviceId === 'string' && primaryDeviceId !== '';

      if (isThisPrimary) {
        deviceBadgeEl.textContent = 'Primary';
        deviceBadgeEl.className = 'badge badge-primary';
      } else if (hasPrimary) {
        deviceBadgeEl.textContent = 'Secondary';
        deviceBadgeEl.className = 'badge badge-secondary';
      } else {
        deviceBadgeEl.textContent = 'No primary set';
        deviceBadgeEl.className = 'badge badge-none';
      }

      // Show/hide the "Make Primary" button
      if (isThisPrimary) {
        claimWrap.classList.add('hidden');
      } else {
        claimWrap.classList.remove('hidden');
      }

      // Render known devices list
      const devices = knownDevices ?? {};
      const deviceEntries = Object.entries(devices);
      knownDevicesList.innerHTML = '';

      if (deviceEntries.length === 0) {
        const li = document.createElement('li');
        li.innerHTML = '<span class="empty-note">No other devices seen yet.</span>';
        knownDevicesList.appendChild(li);
      } else {
        for (const [devId, devInfo] of deviceEntries) {
          const li = document.createElement('li');
          if (devId === deviceId) li.classList.add('current-device');

          const namePart = document.createElement('span');
          namePart.className = 'device-name';
          namePart.textContent = devInfo.name || '(unnamed)';
          li.appendChild(namePart);

          if (devId === primaryDeviceId) {
            const badge = document.createElement('span');
            badge.className = 'badge badge-primary';
            badge.textContent = 'Primary';
            li.appendChild(badge);
          }
          if (devId === deviceId) {
            const badge = document.createElement('span');
            badge.className = 'badge badge-secondary';
            badge.style.background = '#0066cc33';
            badge.style.color = '#003380';
            badge.textContent = 'This device';
            li.appendChild(badge);
          }

          const lastSeen = document.createElement('span');
          lastSeen.className = 'device-lastseen';
          lastSeen.textContent = devInfo.lastSeenAt ? `Last seen: ${formatDateTime(devInfo.lastSeenAt)}` : '';
          li.appendChild(lastSeen);

          knownDevicesList.appendChild(li);
        }
      }
    } catch (err) {
      showError(devicesError, `Error loading devices: ${err.message}`);
    }
  }

  await reloadDevicesSection();

  // Save device name
  btnSaveName.addEventListener('click', async () => {
    clearMsg(renameError);
    const newName = deviceNameInput.value.trim();
    if (!newName) {
      showError(renameError, 'Device name cannot be empty.');
      return;
    }
    try {
      await storage.local.set('deviceName', newName);
      await updateKnownDevices();
      showSavedFlash(renameSaved);
      await reloadDevicesSection();
    } catch (err) {
      showError(renameError, `Could not save name: ${err.message}`);
    }
  });

  // Claim primary
  btnClaim.addEventListener('click', async () => {
    clearMsg(devicesError);
    try {
      const [deviceId, deviceName] = await Promise.all([
        storage.local.get('deviceId'),
        storage.local.get('deviceName'),
      ]);
      await storage.sync.set('primaryDeviceId', deviceId);
      await storage.sync.set('primaryDeviceName', deviceName);
      await reloadDevicesSection();
    } catch (err) {
      showError(devicesError, `Could not claim primary: ${err.message}`);
    }
  });
}

// ---------------------------------------------------------------------------
// Section 5a: Snapshots
// ---------------------------------------------------------------------------

async function initSnapshots() {
  const listEl = document.getElementById('snapshot-list');
  const resultEl = document.getElementById('snapshot-restore-result');

  async function reloadSnapshots() {
    clearMsg(resultEl);
    listEl.innerHTML = '';
    try {
      const snapshots = await listSnapshots();
      if (snapshots.length === 0) {
        listEl.innerHTML = '<li><span class="empty-note">No snapshots yet.</span></li>';
        return;
      }
      for (const snap of snapshots) {
        const li = document.createElement('li');

        const meta = document.createElement('div');
        meta.className = 'snapshot-meta';

        const time = document.createElement('div');
        time.className = 'snapshot-time';
        time.textContent = formatDateTime(snap.takenAt);
        meta.appendChild(time);

        if (snap.summary) {
          const sum = document.createElement('div');
          sum.className = 'snapshot-summary';
          sum.textContent = snap.summary;
          meta.appendChild(sum);
        }

        const nodes = document.createElement('div');
        nodes.className = 'snapshot-nodes';
        nodes.textContent = `${snap.treeSizeNodes} nodes`;
        meta.appendChild(nodes);

        li.appendChild(meta);

        const btn = document.createElement('button');
        btn.className = 'btn-secondary';
        btn.textContent = 'Restore';
        btn.addEventListener('click', async () => {
          const confirmed = confirm(
            'Restore to this snapshot? Current bookmark changes since then will be reversed.'
          );
          if (!confirmed) return;

          btn.disabled = true;
          clearMsg(resultEl);
          try {
            const report = await restoreSnapshot(snap.id);
            resultEl.className = 'success-msg';
            resultEl.textContent = `Restored. Moved: ${report.movedCount}, updated: ${report.updatedCount}, created: ${report.createdCount}, removed: ${report.removedCount}. Errors: ${report.errors.length}`;
            resultEl.classList.remove('hidden');
            await reloadSnapshots();
          } catch (err) {
            resultEl.className = 'error-msg';
            resultEl.textContent = `Restore failed: ${err.message}`;
            resultEl.classList.remove('hidden');
            btn.disabled = false;
          }
        });
        li.appendChild(btn);

        listEl.appendChild(li);
      }
    } catch (err) {
      listEl.innerHTML = `<li><span class="error-msg">Could not load snapshots: ${err.message}</span></li>`;
    }
  }

  await reloadSnapshots();
}

// ---------------------------------------------------------------------------
// Section 5b: Export counts
// ---------------------------------------------------------------------------

async function triggerCountsExport() {
  const counts = (await storage.local.get('counts')) ?? {};
  const json = JSON.stringify(counts, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `bookmark-organizer-counts-${formatDate(Date.now())}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function initExportCounts() {
  const btn = document.getElementById('btn-export-counts');
  btn.addEventListener('click', async () => {
    await triggerCountsExport();
  });
}

// ---------------------------------------------------------------------------
// Section 5c: Import counts
// ---------------------------------------------------------------------------

function initImportCounts() {
  const input = document.getElementById('import-counts-input');
  const resultEl = document.getElementById('import-result');

  input.addEventListener('change', async () => {
    const file = input.files[0];
    if (!file) return;
    clearMsg(resultEl);

    const text = await file.text();
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      resultEl.className = 'error-msg';
      resultEl.textContent = 'Invalid JSON file.';
      resultEl.classList.remove('hidden');
      input.value = '';
      return;
    }

    if (typeof parsed !== 'object' || Array.isArray(parsed) || parsed === null) {
      resultEl.className = 'error-msg';
      resultEl.textContent = 'File must be a JSON object (counts map).';
      resultEl.classList.remove('hidden');
      input.value = '';
      return;
    }

    try {
      const existing = (await storage.local.get('counts')) ?? {};
      let addedCount = 0;
      let mergedCount = 0;

      for (const [id, entry] of Object.entries(parsed)) {
        if (typeof entry !== 'object' || entry === null) continue;
        if (existing[id]) {
          // Merge: add counts together
          existing[id] = {
            ...existing[id],
            count: (existing[id].count || 0) + (entry.count || 0),
          };
          mergedCount++;
        } else {
          existing[id] = entry;
          addedCount++;
        }
      }
      await storage.local.set('counts', existing);

      resultEl.className = 'success-msg';
      resultEl.textContent = `Imported. New entries: ${addedCount}, merged: ${mergedCount}.`;
      resultEl.classList.remove('hidden');
    } catch (err) {
      resultEl.className = 'error-msg';
      resultEl.textContent = `Import failed: ${err.message}`;
      resultEl.classList.remove('hidden');
    }

    input.value = '';
  });
}

// ---------------------------------------------------------------------------
// Section 5d: Reset all counts
// ---------------------------------------------------------------------------

function initResetCounts() {
  const btnReset = document.getElementById('btn-reset-counts');
  const resetResult = document.getElementById('reset-result');

  const modal = document.getElementById('modal-reset');
  const modalMsg = document.getElementById('modal-reset-msg');
  const btnDownload = document.getElementById('modal-reset-download');
  const btnConfirm = document.getElementById('modal-reset-confirm');
  const btnCancel = document.getElementById('modal-reset-cancel');

  let downloadDone = false;

  function openModal() {
    downloadDone = false;
    btnConfirm.classList.add('hidden');
    btnConfirm.disabled = true;
    modalMsg.textContent =
      'To protect your data, you must download your click history first. ' +
      'Download now to enable the reset.';
    modal.classList.remove('hidden');
  }

  function closeModal() {
    modal.classList.add('hidden');
    downloadDone = false;
    btnConfirm.classList.add('hidden');
    btnConfirm.disabled = true;
  }

  btnReset.addEventListener('click', openModal);

  btnCancel.addEventListener('click', closeModal);

  btnDownload.addEventListener('click', async () => {
    await triggerCountsExport();
    downloadDone = true;
    modalMsg.textContent = 'Download started. This clears click history on this device. Continue?';
    btnConfirm.classList.remove('hidden');
    btnConfirm.disabled = false;
  });

  btnConfirm.addEventListener('click', async () => {
    if (!downloadDone) return;
    closeModal();
    clearMsg(resetResult);
    try {
      await storage.local.set('counts', {});
      resetResult.className = 'success-msg';
      resetResult.textContent = 'All click counts have been reset.';
      resetResult.classList.remove('hidden');
    } catch (err) {
      resetResult.className = 'error-msg';
      resetResult.textContent = `Reset failed: ${err.message}`;
      resetResult.classList.remove('hidden');
    }
  });
}

// ---------------------------------------------------------------------------
// Section 5e: Teardown
// ---------------------------------------------------------------------------

function initTeardown() {
  const btnTeardown = document.getElementById('btn-teardown');
  const teardownError = document.getElementById('teardown-error');
  const teardownSuccess = document.getElementById('teardown-success');

  const modal = document.getElementById('modal-teardown');
  const btnRun = document.getElementById('modal-teardown-run');
  const btnCancel = document.getElementById('modal-teardown-cancel');

  btnTeardown.addEventListener('click', () => {
    clearMsg(teardownError);
    clearMsg(teardownSuccess);
    modal.classList.remove('hidden');
  });

  btnCancel.addEventListener('click', () => {
    modal.classList.add('hidden');
  });

  btnRun.addEventListener('click', async () => {
    modal.classList.add('hidden');
    btnTeardown.disabled = true;
    clearMsg(teardownError);
    clearMsg(teardownSuccess);

    try {
      // 1. Snapshot first — CRITICAL INVARIANT
      const snapshotId = await takeSnapshot('Pre-teardown');
      if (!snapshotId) {
        showError(teardownError, 'Could not create safety snapshot. Teardown cancelled.');
        btnTeardown.disabled = false;
        return;
      }

      // 2. Set currentJob BEFORE any tree modification to prevent background feedback loops
      await storage.local.set('currentJob', { startedAt: Date.now(), kind: 'teardown' });

      try {
        const duplicates = (await storage.local.get('duplicates')) ?? {};
        for (const dupId of Object.keys(duplicates)) {
          try {
            await chrome.bookmarks.remove(dupId);
          } catch (e) {
            // Already removed — ignore
          }
        }
        await storage.local.set('duplicates', {});
        await storage.local.set('folderHashes', {});
        await storage.sync.set('mruEnabledGlobally', false);
      } finally {
        // 3. Always clear currentJob even on error
        await storage.local.set('currentJob', null);
      }

      teardownSuccess.textContent =
        'Teardown complete. All ★-prefixed shortcuts have been removed. ' +
        'You can safely uninstall the extension.';
      teardownSuccess.classList.remove('hidden');
    } catch (err) {
      showError(teardownError, `Teardown failed: ${err.message}`);
      btnTeardown.disabled = false;
    }
  });
}

// ---------------------------------------------------------------------------
// Hash routing: #teardown
// ---------------------------------------------------------------------------

function handleHashRouting() {
  if (window.location.hash === '#teardown') {
    const teardownSection = document.getElementById('teardown-section');
    if (teardownSection) {
      teardownSection.classList.add('teardown-highlight');
      teardownSection.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

async function initOptions() {
  try {
    // Run all section initialisers in parallel where possible
    await Promise.all([
      initSchedule(),
      initMru(),
      initSort(),
      initDevices(),
      initSnapshots(),
    ]);

    // These are synchronous/event-binding only
    initExportCounts();
    initImportCounts();
    initResetCounts();
    initTeardown();

    // Handle #teardown hash after DOM is fully ready
    handleHashRouting();
  } catch (err) {
    console.error('[options] initOptions error:', err);
  }
}

document.addEventListener('DOMContentLoaded', () => {
  initOptions();
});
