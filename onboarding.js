/**
 * onboarding.js — 4-screen first-run setup flow
 *
 * Screens:
 *   1. Welcome
 *   2. Device naming
 *   3. Primary device choice (Case A: first device / Case B: second+ device)
 *   4. What happens next (conditional — only shown when user ends up primary
 *      OR chose "Keep as secondary" on Case B)
 *
 * "Decide later" on Screen 3 skips Screen 4 entirely, marks firstRunCompleted
 * = false, and closes the tab.
 */

import storage from './lib/storage.js';
import { takeSnapshot } from './lib/undo.js';
import { planSortForFolder } from './lib/sorter.js';
import { getDeviceId, getOrCreateDeviceName, updateKnownDevices } from './lib/device.js';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/** Will be set once getOrCreateDeviceName resolves. */
let resolvedDeviceName = '';

/** true if this device will be / is primary after Screen 3 choice. */
let willBePrimary = false;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function showScreen(id) {
  document.querySelectorAll('.screen').forEach(el => el.classList.remove('active'));
  const target = document.getElementById(`screen-${id}`);
  if (target) target.classList.add('active');
}

function showError(msgEl, text) {
  msgEl.textContent = text;
  msgEl.classList.add('visible');
}

function hideError(msgEl) {
  msgEl.classList.remove('visible');
}

// ---------------------------------------------------------------------------
// Screen 1 — Welcome
// ---------------------------------------------------------------------------

function initScreen1() {
  showScreen(1);
  document.getElementById('s1-continue').addEventListener('click', () => {
    goToScreen2();
  });
}

// ---------------------------------------------------------------------------
// Screen 2 — Device naming
// ---------------------------------------------------------------------------

async function goToScreen2() {
  showScreen(2);

  const input = document.getElementById('device-name-input');
  input.value = 'Loading…';
  input.disabled = true;

  try {
    const platformInfo = await chrome.runtime.getPlatformInfo();
    resolvedDeviceName = await getOrCreateDeviceName(platformInfo);
    input.value = resolvedDeviceName;
    input.disabled = false;
    input.focus();
    input.select();
  } catch (err) {
    console.error('[onboarding] getOrCreateDeviceName failed', err);
    input.value = 'My Chrome';
    input.disabled = false;
  }

  document.getElementById('s2-continue').addEventListener('click', async () => {
    const newName = input.value.trim();
    if (!newName) {
      input.focus();
      return;
    }

    // Persist name if the user edited it
    if (newName !== resolvedDeviceName) {
      resolvedDeviceName = newName;
      await storage.local.set('deviceName', newName);
    }

    goToScreen3();
  });
}

// ---------------------------------------------------------------------------
// Screen 3 — Primary device choice
// ---------------------------------------------------------------------------

async function goToScreen3() {
  showScreen(3);

  const bodyEl   = document.getElementById('s3-body');
  const actionsEl = document.getElementById('s3-actions');

  // Clear previous content (in case of re-entry)
  bodyEl.innerHTML   = '';
  actionsEl.innerHTML = '';

  const primaryDeviceId   = await storage.sync.get('primaryDeviceId');
  const primaryDeviceName = await storage.sync.get('primaryDeviceName');
  const deviceId          = await getDeviceId();

  if (!primaryDeviceId) {
    // ── Case A: First device ──────────────────────────────────────────────
    const p = document.createElement('p');
    p.textContent =
      'Make this your primary device? Only the primary device reorganizes your bookmark tree. ' +
      'Other devices you install on later will track clicks but won’t modify bookmarks.';
    bodyEl.appendChild(p);

    const btnPrimary = document.createElement('button');
    btnPrimary.className = 'btn-primary';
    btnPrimary.textContent = 'Make this device primary';
    btnPrimary.addEventListener('click', async () => {
      await claimPrimary(deviceId, resolvedDeviceName);
      willBePrimary = true;
      goToScreen4Primary();
    });

    const btnLater = document.createElement('button');
    btnLater.className = 'btn-secondary';
    btnLater.textContent = 'Decide later';
    btnLater.addEventListener('click', async () => {
      await decideLater();
    });

    actionsEl.appendChild(btnPrimary);
    actionsEl.appendChild(btnLater);

  } else {
    // ── Case B: Second+ device ────────────────────────────────────────────
    const displayName = primaryDeviceName || 'another device';

    const p = document.createElement('p');
    p.innerHTML =
      `<strong>${escapeHtml(displayName)}</strong> is currently your primary device. ` +
      `This device will track clicks but won’t reorganize bookmarks.`;
    bodyEl.appendChild(p);

    const btnClaimInstead = document.createElement('button');
    btnClaimInstead.className = 'btn-primary';
    btnClaimInstead.textContent = 'Make this device primary instead';
    btnClaimInstead.addEventListener('click', async () => {
      await claimPrimary(deviceId, resolvedDeviceName);
      willBePrimary = true;
      goToScreen4Primary();
    });

    const btnKeep = document.createElement('button');
    btnKeep.className = 'btn-secondary';
    btnKeep.textContent = `Keep ${displayName} as primary`;
    btnKeep.addEventListener('click', async () => {
      willBePrimary = false;
      await updateKnownDevices();
      goToScreen4Secondary();
    });

    actionsEl.appendChild(btnClaimInstead);
    actionsEl.appendChild(btnKeep);
  }
}

// ---------------------------------------------------------------------------
// Screen 4 — What happens next (primary variant)
// ---------------------------------------------------------------------------

function goToScreen4Primary() {
  showScreen(4);

  const bodyEl    = document.getElementById('s4-body');
  const actionsEl = document.getElementById('s4-actions');
  const errorEl   = document.getElementById('s4-error');

  bodyEl.innerHTML    = '';
  actionsEl.innerHTML = '';
  hideError(errorEl);

  const p = document.createElement('p');
  p.textContent =
    'Your folders will be alphabetized in a moment. Starting tomorrow, your most-used ' +
    'bookmarks will appear at the top of your top-level folders and bookmarks bar with a ★ prefix. ' +
    'You can undo or change anything in options.';
  bodyEl.appendChild(p);

  const btnSort = document.createElement('button');
  btnSort.className = 'btn-primary';
  btnSort.textContent = 'Sort my bookmarks now';
  btnSort.addEventListener('click', async () => {
    btnSort.disabled  = true;
    btnSkip.disabled  = true;
    hideError(errorEl);

    const loadingP = document.createElement('p');
    loadingP.className = 'loading-text';
    loadingP.textContent = 'Sorting…';
    actionsEl.after(loadingP);

    try {
      await runFirstRunSort();
      loadingP.remove();
      finishOnboarding();
    } catch (err) {
      loadingP.remove();
      btnSort.disabled = false;
      btnSkip.disabled = false;
      showError(errorEl, String(err));
    }
  });

  const btnSkip = document.createElement('button');
  btnSkip.className = 'btn-secondary';
  btnSkip.textContent = 'Skip first sort';
  btnSkip.addEventListener('click', async () => {
    await storage.local.set('firstRunCompleted', true);
    const scheduleDays = (await storage.sync.get('scheduleDays')) ?? 1;
    await storage.local.set('nextRunAt', Date.now() + scheduleDays * 86_400_000);
    finishOnboarding();
  });

  actionsEl.appendChild(btnSort);
  actionsEl.appendChild(btnSkip);
}

// ---------------------------------------------------------------------------
// Screen 4 — What happens next (secondary / keep variant)
// ---------------------------------------------------------------------------

function goToScreen4Secondary() {
  showScreen(4);

  const bodyEl    = document.getElementById('s4-body');
  const actionsEl = document.getElementById('s4-actions');

  bodyEl.innerHTML    = '';
  actionsEl.innerHTML = '';

  const p = document.createElement('p');
  p.textContent =
    'Setup complete. This device will track clicks, contributing data to its own future MRU ' +
    'when promoted to primary. Click tracking is per-device — work and home learn independently.';
  bodyEl.appendChild(p);

  const btnDone = document.createElement('button');
  btnDone.className = 'btn-primary';
  btnDone.textContent = 'Done';
  btnDone.addEventListener('click', async () => {
    await storage.local.set('firstRunCompleted', true);
    finishOnboarding();
  });

  actionsEl.appendChild(btnDone);
}

// ---------------------------------------------------------------------------
// "Decide later" — skips Screen 4, closes tab
// ---------------------------------------------------------------------------

async function decideLater() {
  await storage.local.set('firstRunCompleted', false);
  // Leave firstRunCompleted = false so the popup badge can prompt the user.
  window.close();
}

// ---------------------------------------------------------------------------
// Claim primary
// ---------------------------------------------------------------------------

async function claimPrimary(deviceId, deviceName) {
  await storage.sync.set('primaryDeviceId',   deviceId);
  await storage.sync.set('primaryDeviceName', deviceName);
  await updateKnownDevices();
  console.log('[onboarding] claimed primary: deviceId=%s deviceName=%s', deviceId, deviceName);
}

// ---------------------------------------------------------------------------
// First-run sort
// ---------------------------------------------------------------------------

async function runFirstRunSort() {
  // CRITICAL: snapshot first — abort if snapshot fails
  const snapshotId = await takeSnapshot('Pre-first-run sort');
  if (!snapshotId) {
    throw new Error('Could not create safety snapshot. Sort cancelled.');
  }

  // Set currentJob so event handlers know we are running a managed job
  await storage.local.set('currentJob', { startedAt: Date.now(), kind: 'first-run-sort' });

  try {
    const enabledFolders = (await storage.local.get('enabledFolders')) ?? {};

    for (const [folderId, settings] of Object.entries(enabledFolders)) {
      if (!settings.sortEnabled) continue;

      // Alphabetical sort only — NO MRU on first run (mruCount: 0)
      const plan = await planSortForFolder(folderId, { mruCount: 0 });

      for (const op of plan) {
        await chrome.bookmarks.move(op.id, { parentId: op.parentId, index: op.index });
      }
    }
  } finally {
    await storage.local.set('currentJob', null);
  }

  await storage.local.set('firstRunCompleted', true);
  const scheduleDays = (await storage.sync.get('scheduleDays')) ?? 1;
  await storage.local.set('nextRunAt', Date.now() + scheduleDays * 86_400_000);
}

// ---------------------------------------------------------------------------
// Finish — close the tab
// ---------------------------------------------------------------------------

function finishOnboarding() {
  window.close();
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

initScreen1();
