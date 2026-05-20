# Snapshot + Undo Acceptance Gate (`lib/undo.js`)

**Step 3 acceptance criteria:** all of T1–T8 below must pass before any
subsequent step that calls `chrome.bookmarks.move/update/create/remove` is
written.

---

## Setup (do once before each test)

1. Load the extension as an unpacked extension at `chrome://extensions`.
2. Open any tab, then DevTools (F12).
3. In the DevTools "Sources" or "Console" tab, switch the execution context
   to the extension's service worker (look for a worker labelled
   `background.js` — click "Inspect").
4. Inside the service-worker console, run:

```js
const undo = await import(chrome.runtime.getURL('lib/undo.js'));
const storage = (await import(chrome.runtime.getURL('lib/storage.js'))).default;
```

You can now call `undo.takeSnapshot(...)`, `undo.restoreSnapshot(...)`,
`undo.listSnapshots()`, etc.

If you want a fresh start between tests:
```js
await chrome.storage.local.set({ snapshots: [], currentJob: null, duplicates: {} });
```

---

## T1 — Restore a moved bookmark

**Goal:** prove that a manually-moved bookmark is returned to its original
parent + index after restore.

**Steps:**
1. Pick or create a bookmark "T1-bookmark" under **Other Bookmarks**, at a
   known index (e.g. index 0).
2. In the service-worker console:
   ```js
   const id = await undo.takeSnapshot('T1');
   ```
3. Open `chrome://bookmarks`, drag "T1-bookmark" into a **different** folder
   (e.g. **Bookmarks Bar**).
4. In the console:
   ```js
   await undo.restoreSnapshot(id);
   ```

**Expected result:**
- "T1-bookmark" is back under **Other Bookmarks** at its original index.
- Return value has `movedCount >= 1`, `errors: []`.
- Console shows `[undo] restoreSnapshot: starting restore to snapshot takenAt=…`
  and `[undo] restoreSnapshot: done. moved=… …`.

---

## T2 — Restore a deleted bookmark

**Goal:** prove that a deleted bookmark is recreated with correct parent,
index, title, and url.

**Steps:**
1. Create a bookmark "T2-bookmark" pointing at `https://example.com/t2`
   under **Other Bookmarks**.
2. `const id = await undo.takeSnapshot('T2');`
3. In `chrome://bookmarks`, delete "T2-bookmark".
4. `await undo.restoreSnapshot(id);`

**Expected result:**
- "T2-bookmark" reappears under **Other Bookmarks** at the original index
  with url `https://example.com/t2`.
- Return value has `createdCount >= 1`, `errors: []`.
- The recreated bookmark may have a new internal id (Chrome assigns new
  ids on create); that is expected.

---

## T3 — Restore a renamed folder

**Goal:** prove that a renamed folder is renamed back.

**Steps:**
1. Create a folder named "T3-folder" under **Other Bookmarks**.
2. `const id = await undo.takeSnapshot('T3');`
3. In `chrome://bookmarks`, rename "T3-folder" → "T3-folder-RENAMED".
4. `await undo.restoreSnapshot(id);`

**Expected result:**
- The folder's title is `T3-folder` again.
- Return value has `updatedCount >= 1`, `errors: []`.

---

## T4 — User-added bookmark survives restore

**Goal:** prove that the "user-added bookmarks survive restore" rule is
enforced — only extension-created duplicates may be removed.

**Steps:**
1. Note the contents of **Other Bookmarks**.
2. `const id = await undo.takeSnapshot('T4');`
3. In `chrome://bookmarks`, **manually create** a new bookmark
   "T4-userAdded" pointing at `https://example.com/t4-user` under
   **Other Bookmarks**.
4. Confirm that `chrome.storage.local` has no `duplicates` entry for
   the new bookmark:
   ```js
   const dupes = await storage.local.get('duplicates');
   console.log(dupes);   // should NOT contain the new id
   ```
5. `await undo.restoreSnapshot(id);`

**Expected result:**
- "T4-userAdded" is **still present** in **Other Bookmarks** after the
  restore (it was added by the user, not the extension).
- Return value has `removedCount === 0`, `errors: []`.

**Negative sub-test (extension duplicate IS removed):**
1. Take a fresh snapshot.
2. Create a bookmark "T4-extDup" manually, then add it to the duplicates
   map to simulate an extension-created duplicate:
   ```js
   const all = await chrome.bookmarks.search({ title: 'T4-extDup' });
   const dupId = all[0].id;
   const dupes = (await storage.local.get('duplicates')) ?? {};
   dupes[dupId] = { originalId: 'fake', parentFolderId: 'fake', originalUrl: '', createdAt: Date.now() };
   await storage.local.set('duplicates', dupes);
   ```
3. `await undo.restoreSnapshot(id_from_step_1);`

**Expected:** "T4-extDup" is removed (`removedCount >= 1`).

---

## T5 — FIFO cap at 5 snapshots

**Goal:** prove that taking a 6th snapshot evicts the oldest, capping the
array at `SNAPSHOTS_MAX = 5`.

**Steps:**
1. Reset: `await chrome.storage.local.set({ snapshots: [] });`
2. Take 6 snapshots in sequence, capturing the first id:
   ```js
   const first = await undo.takeSnapshot('T5-1');
   await undo.takeSnapshot('T5-2');
   await undo.takeSnapshot('T5-3');
   await undo.takeSnapshot('T5-4');
   await undo.takeSnapshot('T5-5');
   await undo.takeSnapshot('T5-6');
   const list = await undo.listSnapshots();
   console.log(list.length, list.map(s => s.summary));
   ```

**Expected result:**
- `list.length === 5`.
- Summaries (most recent first) are `["T5-6", "T5-5", "T5-4", "T5-3", "T5-2"]`.
- The oldest (`T5-1`, takenAt `=== first`) has been evicted.
- `list.some(s => s.id === first) === false`.

---

## T6 — Large-scale mixed changes

**Goal:** prove correctness on a realistic tree with many simultaneous
moves, renames, deletes, and user-additions.

**Steps:**
1. Build a tree of 100+ bookmarks across nested folders under
   **Other Bookmarks** (you can paste a generator into the console, e.g.:
   ```js
   const root = await chrome.bookmarks.create({ parentId: '2', title: 'T6-root' });
   for (let i = 0; i < 10; i++) {
     const sub = await chrome.bookmarks.create({ parentId: root.id, title: `T6-sub-${i}` });
     for (let j = 0; j < 12; j++) {
       await chrome.bookmarks.create({ parentId: sub.id, title: `bm-${i}-${j}`, url: `https://example.com/${i}/${j}` });
     }
   }
   ```
2. `const id = await undo.takeSnapshot('T6');`
3. Make 20 mixed changes by hand or via script:
   - Move 5 bookmarks across folders
   - Rename 5 folders or bookmarks
   - Delete 5 bookmarks
   - Create 5 brand-new user bookmarks (these MUST survive restore)
4. `const report = await undo.restoreSnapshot(id); console.log(report);`

**Expected result:**
- Every moved bookmark is back in its original parent + index.
- Every renamed item has its original title (folders too).
- Every deleted bookmark has been recreated with original title + url.
- All 5 user-added bookmarks remain (they are NOT in the snapshot and NOT
  in `storage.local.duplicates`).
- `errors: []` (or only inconsequential entries).
- Counts approximately: `movedCount >= 5`, `updatedCount >= 5`,
  `createdCount >= 5`, `removedCount === 0`.

---

## T7 — `currentJob` is set during restore and cleared after

**Goal:** prove that `currentJob` is set BEFORE any tree operation and
cleared in the `finally` block.

**Steps:**
1. Take a snapshot: `const id = await undo.takeSnapshot('T7');`
2. In one console tab, kick off restore and **immediately** observe
   storage from another inspection point. Easiest method: monkey-patch
   `chrome.bookmarks.getTree` to log `currentJob` mid-flight, e.g.:
   ```js
   const origGetTree = chrome.bookmarks.getTree.bind(chrome.bookmarks);
   chrome.bookmarks.getTree = async (...args) => {
     const job = await storage.local.get('currentJob');
     console.log('[T7] during restore, currentJob =', job);
     return origGetTree(...args);
   };
   await undo.restoreSnapshot(id);
   chrome.bookmarks.getTree = origGetTree;
   const after = await storage.local.get('currentJob');
   console.log('[T7] after restore, currentJob =', after);
   ```

**Expected result:**
- The mid-flight log shows `currentJob = { startedAt: <number>, kind: 'restore' }`.
- The post-restore log shows `currentJob = null`.

**Failure-path sub-test:**
1. Force an error inside restore by passing an unknown snapshot id:
   ```js
   try { await undo.restoreSnapshot(99999999); } catch (e) { console.warn(e); }
   const after = await storage.local.get('currentJob');
   console.log('[T7-err] after failed restore, currentJob =', after);
   ```
   - Even though the restore threw, `currentJob` must be `null` (cleared
     by the `finally` block).

---

## T8 — Restore is idempotent

**Goal:** prove that running restore twice in a row is a no-op the second
time (tree already matches snapshot).

**Steps:**
1. `const id = await undo.takeSnapshot('T8');`
2. Move/rename/delete a few items.
3. First restore: `const r1 = await undo.restoreSnapshot(id); console.log(r1);`
4. Second restore (immediately): `const r2 = await undo.restoreSnapshot(id); console.log(r2);`

**Expected result:**
- `r1` shows non-zero counts (depending on changes made).
- `r2.movedCount === 0`, `r2.updatedCount === 0`, `r2.createdCount === 0`,
  `r2.removedCount === 0`, `r2.errors.length === 0`.
- The console log `[undo] restoreSnapshot: creating 0, updating 0, moving 0, removing 0`
  is emitted for the second call.

---

## Pass / fail rubric

All eight tests above must produce the "Expected result" listed.  Any
deviation — especially an unexpected `removedCount > 0` in T4, an
uncleared `currentJob` in T7, or non-zero counts in T8's second restore —
is a blocking bug and must be fixed before continuing to Step 4.
