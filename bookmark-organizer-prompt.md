# Build "Bookmark Organizer" — a Chrome Extension (Manifest V3)

Build a Chrome extension that **(a) keeps bookmark folders alphabetized** and **(b) surfaces frequently-used bookmarks as a pinned flat region at the top of root and first-level folders**, including the bookmarks bar.

The extension is sync-aware: only one user-chosen "primary device" reorganizes the tree, while all devices track clicks locally.

---

## Design principles (non-negotiable)

1. **Layout invariant** (see §1) is enforced in code, not derived.
2. **Every tree modification is snapshotted** before it happens, and undoable for 24h.
3. **Click tracking is best-effort** with documented imperfection; popup clicks are accurate.
4. **Respond to user actions immediately** via `chrome.bookmarks.on*` events; scheduled rebuilds are the safety net.
5. **Only the primary device modifies the tree.** Secondary devices track clicks but do not rebuild.

---

## Tech requirements

- Manifest V3, vanilla JS/HTML/CSS, no build step, no frameworks, no dependencies.
- APIs used: `chrome.bookmarks`, `chrome.storage.local`, `chrome.storage.sync`, `chrome.alarms`, `chrome.webNavigation`, `chrome.idle`, `chrome.commands`, `chrome.runtime`.
- Target latest stable Chrome.

## Permissions

- `bookmarks`, `storage`, `alarms`, `idle` — required.
- `webNavigation` — required, for click tracking via `transitionType: "auto_bookmark"`. README explains prominently.

**Not used in v1:** `tabs`, `history`. Future versions may add `history` for cold-start seeding (v2).

---

## Project structure

```
bookmark-organizer/
├── manifest.json
├── background.js                        // service worker entry; events, alarms, idle
├── popup.html / popup.js / popup.css    // status, manual rebuild, undo, quick search, teardown link
├── options.html / options.js            // all settings, snapshot viewer, devices, teardown
├── onboarding.html / onboarding.js      // 4-screen first-run flow
├── lib/
│   ├── storage.js                       // schema-versioned wrapper, migrations
│   ├── locale.js                        // Intl.Collator wrapper
│   ├── tree.js                          // tree walkers, subtree caches, depth helpers
│   ├── tracker.js                       // webNavigation click attribution
│   ├── duplicates.js                    // duplicate↔original map, orphan handling
│   ├── mru.js                           // subtree-scoped candidate selection, scoring
│   ├── sorter.js                        // alphabetical sort within regions
│   ├── rebuild.js                       // per-folder rebuild, layout invariant
│   ├── undo.js                          // snapshots, restore
│   ├── suppression.js                   // 7-day suppression helpers
│   ├── device.js                        // primary/secondary device logic
│   └── bulk-import.js                   // bulk-import detection
├── _locales/en/messages.json
└── icons/  (real, not placeholder: 16/32/48/128)
```

---

## Storage schema

### `chrome.storage.local` (per-device)
```
{
  schemaVersion: 1,
  installedAt,
  nextRunAt,
  firstRunCompleted: false,
  deviceId,                    // uuid generated on install
  deviceName,                  // user-named during onboarding
  currentJob: { startedAt, kind } | null,
  counts: {
    [bookmarkId]: { count, lastUsed, url, titleAtLastClick }
  },
  duplicates: {
    [duplicateId]: { originalId, parentFolderId, originalUrl, createdAt }
  },
  suppression: [
    { originalId, parentFolderId, until }   // epoch ms
  ],
  snapshots: [
    { takenAt, summary, tree: [{id, parentId, index, title, url}...] }
  ],  // FIFO cap 5
  enabledFolders: {
    [folderId]: { mruEnabled, sortEnabled, candidateScope: "subtree"|"direct", lastUserEditAt, path: [...] }
  },
  folderHashes: { [folderId]: "..." }
}
```

### `chrome.storage.sync` (across devices)
```
{
  scheduleDays: 1 | 2 | 3 | 7 | "manual",   // default 1
  mruEnabledGlobally: true,
  mruItemsPerFolder: 5,                     // 3..10
  mruMinSubtreeSize: 8,
  mruPrefix: "★ ",                          // user-configurable, "" allowed
  defaultCandidateScope: "subtree",
  duplicateCap: 500,
  sortBookmarksBar: false,
  sortOtherBookmarks: true,
  sortMobileBookmarks: false,
  primaryDeviceId: null,                    // user picks during onboarding
  primaryDeviceName: null,
  knownDevices: { [deviceId]: { name, lastSeenAt } }
}
```

**Schema versioning:** `storage.js` checks `schemaVersion` on every read; runs migrations forward. All writes go through `storage.js`. No direct `chrome.storage` calls elsewhere.

---

## §1 — Folder layout invariant

For any folder F at depth ≤ 2 (the three root nodes — id `1` Bookmarks Bar, `2` Other Bookmarks, `3` Mobile Bookmarks — and their direct child folders), after rebuild, children are ordered:

```
[0 .. M-1]       MRU duplicates, score-desc       (M ∈ [0, mruItemsPerFolder])
[M .. M+S-1]     Subfolders, alphabetical
[M+S .. end]     Remaining bookmarks, alphabetical
```

Folders at depth > 2 get alphabetical sort only — no MRU region, no `M`.

The collator is `new Intl.Collator(undefined, { sensitivity: "base", numeric: true })`. MRU duplicates are identified by membership in the duplicates map (not by title prefix — prefix is cosmetic and user-configurable). The invariant is enforced by computing the desired full ordering and issuing minimal `chrome.bookmarks.move` calls.

---

## §2 — MRU candidate selection (subtree scope)

For each folder F at depth ≤ 2 with `mruEnabled === true`:

1. Walk F's subtree, collecting leaf bookmarks. Exclude any id present in the duplicates map (no duplicates-of-duplicates).
2. If leaf count < `mruMinSubtreeSize` (default 8), set M = 0 and skip MRU for F this rebuild.
3. Score each candidate: `score = count * Math.exp(-ageInDays / 30)` where `ageInDays = (Date.now() - lastUsed) / 86_400_000`. No clicks → score 0. Ties broken by `lastUsed` desc, then id asc for determinism.
4. Apply skip rules in order, promoting next candidate on each skip:
   - **Original-already-here:** if the candidate's original is a direct child of F, skip.
   - **Suppressed:** if `(originalId, F.id)` is in suppression list with `until > now`, skip.
   - **Cap reached:** if creating a new duplicate would push total duplicates above `duplicateCap` AND this candidate doesn't already have a duplicate in F, skip. Existing duplicates are never proactively removed by cap.
5. Take top `mruItemsPerFolder` (default 5) of survivors. This is M.

Determinism: same inputs → same ordering. Critical for the change-hash in §8.

---

## §3 — Duplicate lifecycle

- **Create:** `chrome.bookmarks.create({ parentId: F.id, index: i, title: prefix + original.title, url: original.url })`. Store in `duplicates` map. **Double-prefix is allowed verbatim** — if original title already starts with prefix, duplicate becomes `★ ★ Title`. Documented in code comment.
- **Refresh on rebuild:** for surviving duplicates, if `original.title` or `original.url` changed, update via `chrome.bookmarks.update`.
- **Remove:** `chrome.bookmarks.remove(duplicateId)` and drop from map.
- **Reorder:** `chrome.bookmarks.move` to correct index within MRU region.

---

## §4 — Click tracking

- Register `chrome.webNavigation.onCommitted` with URL filter `{ url: [{ schemes: ["http", "https"] }] }`. In handler, check `details.transitionType === "auto_bookmark"`. (Event filter API doesn't accept `transitionTypes` directly; filter in code.)
- On match, `chrome.bookmarks.search({ url: details.url })`:
  - For each hit: if id is in duplicates map, attribute click to `duplicates[id].originalId`. Otherwise attribute to id directly.
  - If multiple unrelated originals share the URL (user duplicates outside our system), increment all — cannot disambiguate.
  - Update `counts[targetId]`: increment `count`, set `lastUsed = Date.now()`, set `url` and `titleAtLastClick` for diagnostics.
- Popup click handlers call into the tracker directly (precise attribution).
- Click tracking runs on **all devices**, primary and secondary. Counts stay in `storage.local` per-device. Primary device uses only its own counts when rebuilding. README explains: "Click data is per-device. Your work and home devices learn independently."
- Document in README: `auto_bookmark` is heuristic; some real bookmark clicks miss it, some non-bookmark navigations may match. Counts are directional, not exact. URL normalization deferred to v2.

---

## §5 — Event-driven cleanup

All event handlers are **no-ops while `currentJob` is set**, preventing feedback loops during the extension's own modifications.

- **`onRemoved(id, removeInfo)`:** `removeInfo.node` contains the removed subtree. Walk it recursively to enumerate every removed id.
  - For each removed id that is an **original** in any duplicates entry: delete all duplicates where `originalId === id` via `chrome.bookmarks.remove`, prune from duplicates map and counts map.
  - For each removed id that is a **duplicate**: drop from duplicates map; add `(originalId, parentFolderId, until: now + 7d)` to suppression.
  - For each removed id that is an **enabled folder** (depth ≤ 2): drop from `enabledFolders` and `folderHashes`.
- **`onChanged(id, changeInfo)`:** if id is an original, propagate title/URL changes to all its duplicates immediately via `chrome.bookmarks.update` (with `prefix + newTitle`). Also stamp `lastUserEditAt` on the bookmark's parent folder (and ancestors up to depth ≤ 2).
- **`onMoved(id, moveInfo)`:** 
  - If id is a duplicate moved out of its `parentFolderId`: drop from duplicates map, **strip prefix from title** via update, add 7-day suppression for `(originalId, oldParentFolderId)`. The bookmark becomes a regular bookmark.
  - If id is a folder: recompute depth.
    - Depth was >2, now ≤2: add to `enabledFolders` with defaults `{mruEnabled: true, sortEnabled: true, candidateScope: "subtree"}`.
    - Depth was ≤2, now >2: remove from `enabledFolders`. On next rebuild, orphan-conversion strips `★ ` from any duplicates that lived there (they become regular bookmarks).
  - Stamp `lastUserEditAt` on affected parent folders at depth ≤ 2.
- **`onCreated(id, bookmark)`:** invalidate subtree caches for parent and ancestors. If new node is a folder at depth ≤ 2, **add to `enabledFolders` with defaults** (per Point 7 final decision: new folders are auto-enabled). Stamp `lastUserEditAt`.

---

## §6 — Orphan handling (rebuild-time safety net)

During every rebuild, before processing F's MRU:
- For each duplicate with `parentFolderId === F.id`: verify the original exists via `chrome.bookmarks.get(originalId)`. If it throws or returns nothing:
  - **Convert, don't delete.** Strip the prefix from the title via `chrome.bookmarks.update`, remove from duplicates map. The bookmark becomes a regular bookmark and joins the alphabetical region. Its future clicks attribute by URL.

Orphan-conversion also runs when a folder is reclassified from depth ≤ 2 to depth > 2 (per §5 `onMoved`).

---

## §7 — Alphabetical sort

- Two regions sorted independently with the collator: subfolders region [M .. M+S-1] and bookmarks region [M+S .. end].
- Applies at all depths (not just ≤2) when the folder's `sortEnabled === true`.
- Exclusions:
  - Hidden super-root `0`.
  - The three top-level roots `1`, `2`, `3` themselves are sorted per `sortBookmarksBar` / `sortOtherBookmarks` / `sortMobileBookmarks` settings (defaults: off / on / off).
  - Folders where `lastUserEditAt > max(now - 7 days, lastRebuildCompletedAt)` — i.e., edited in last 7 days OR since last rebuild, whichever is shorter.
  - User-excluded folders (tree picker in options).

---

## §8 — Scheduled rebuilds (primary device only)

- `chrome.alarms.create("rebuild", { periodInMinutes: 60 })`. On each alarm tick, check if `now >= nextRunAt`.
- **Primary check first:** if `sync.primaryDeviceId !== local.deviceId`, return immediately. Secondary devices never rebuild.
- When due on primary:
  1. `chrome.idle.queryState(60)`. If `"active"`, set `nextRunAt = now + 15min` and return.
  2. Snapshot the tree via `lib/undo.js` (FIFO cap 5). Compute one-line summary.
  3. Set `currentJob = { startedAt: now, kind: "scheduled" }`.
  4. For each folder F at depth ≤ 2 (bottom-up by depth so subtree caches stabilize): compute `desiredHash` = hash of (ordered list of children ids + their titles + MRU candidate ids). If `folderHashes[F.id] === desiredHash`, skip. Else rebuild per §1–§3, update hash.
  5. Also sort all folders at depth > 2 where `sortEnabled === true` (alphabetical only; no MRU). Use same change-hash optimization.
  6. Set `nextRunAt = now + scheduleDays * 86_400_000`. Clear `currentJob`. Record `lastRebuildCompletedAt`.
- **Manual "Rebuild now":** same flow but ignores `nextRunAt`. Still primary-only; secondary devices show a disabled button with "Rebuilds run on [primaryDeviceName]."
- **Stale `currentJob` on startup:** if `currentJob` exists and is older than 10 minutes, show popup badge "Rebuild interrupted — restore snapshot?" with one-click restore.

---

## §8.5 — Primary device gating

- On install, generate `deviceId` (uuid) and store in `local.deviceId`. Onboarding (§9) determines primary status.
- All rebuild flows check `sync.primaryDeviceId !== local.deviceId` and return early.
- Secondary devices:
  - Still register `webNavigation` listener and track clicks locally.
  - Popup shows banner: "Secondary device. Rebuilds run on **[primaryDeviceName]**. Click tracking active here."
  - "Rebuild now" button is disabled with tooltip explaining why.
  - Options page exposes "Make this device primary" button that overwrites `sync.primaryDeviceId`.
- If no primary chosen (user clicked "Decide later"):
  - Extension is inert (no rebuilds anywhere). Click tracking still runs.
  - Popup badge: "Pick a primary device to start organizing." Click opens options to the Devices section.
  - After 30 days inert, auto-claim primary on next popup open by *this* device, with a notification: "[deviceName] is now your primary device."
- `knownDevices` in sync is updated on every popup open: `knownDevices[deviceId] = { name: deviceName, lastSeenAt: now }`.

---

## §9 — First-run onboarding (4 screens)

Triggered by `chrome.runtime.onInstalled` with `reason === "install"`. Opens `onboarding.html` in a new tab (popup is too small for 4 screens).

**Screen 1 — Welcome.**
> "Bookmark Organizer keeps your folders alphabetized and shows your most-used bookmarks at the top of your top-level folders and bookmarks bar. Let's set it up." [Continue]

**Screen 2 — Device naming.**
> "What should we call this device?"
> [Text input, prefilled with `"Chrome on <platform> (installed <Mon DD>)"`]
> [Continue]

Platform from `chrome.runtime.getPlatformInfo()` (e.g., "Mac", "Windows", "Linux"). Stored in `local.deviceName` and copied to `sync.knownDevices`.

**Screen 3 — Primary device choice.**

Read `sync.primaryDeviceId`. Two cases:

*Case A — first device (no primary set):*
> "Make this your primary device? Only the primary device reorganizes your bookmark tree. Other devices you install on later will track clicks but won't modify bookmarks." [Make this device primary] [Decide later]

*Case B — second+ device (primary already set):*
> "**[primaryDeviceName]** is currently your primary device. This device will track clicks here but won't reorganize bookmarks." [Make this device primary instead] [Keep [primaryDeviceName] as primary]

**Screen 4 — What happens next** (only if user is on primary, or chose "Keep as secondary" on Case B).

For primary:
> "Your folders will be alphabetized in a moment. Starting tomorrow, your most-used bookmarks will appear at the top of your top-level folders and bookmarks bar with a `★ ` prefix. You can undo or change anything in options." [Sort my bookmarks now] [Skip first sort]

For secondary:
> "Setup complete. This device will track clicks, contributing data to its own future MRU when promoted to primary. Click tracking is per-device — work and home learn independently." [Done]

If user clicked **"Sort my bookmarks now"** on primary, run **first-run rebuild**:
1. Snapshot tree.
2. Apply alphabetical sort only to all eligible folders (per `sortBookmarksBar`/`sortOtherBookmarks`/`sortMobileBookmarks`).
3. **Do NOT create any MRU duplicates on first run**, regardless of `mruEnabledGlobally`.
4. Set `firstRunCompleted = true`.
5. Set `nextRunAt = Date.now() + scheduleDays * 86_400_000` (so MRU first appears on the next scheduled tick — tomorrow with default daily schedule).
6. Show popup badge "First sort complete — undo available for 24h."

If user clicked **"Skip first sort"**: set `firstRunCompleted = true` but do nothing to the tree. Next scheduled rebuild does both sort and MRU.

If user clicked **"Decide later"** on screen 3: `firstRunCompleted = false` until they pick a primary. Badge "Pick a primary device to continue."

**On update (`reason === "update"`):** run schema migrations only. No onboarding, no rebuild.

**Population of `enabledFolders` on install:** walk the tree, add every folder at depth ≤ 2 with defaults `{ mruEnabled: true, sortEnabled: true, candidateScope: "subtree" }`. Folders not meeting `mruMinSubtreeSize` are still "enabled" — they just get M=0 at rebuild time. New folders created later are auto-enabled (per §5 `onCreated`).

---

## §10 — Bulk import detection

On `onRemoved` of a node whose subtree contains > 50 leaf bookmarks, do NOT immediately clean duplicates. Instead:
1. Record pending cleanup with timestamp.
2. Wait 30 seconds, watching for `onCreated` events.
3. If > 20 `onCreated` events fire in that window: classify as bulk import.
   - Wait for 5 seconds of `onCreated` silence (import settled).
   - Snapshot current state.
   - Run full rebuild: clear duplicates for missing originals, recompute MRU on every depth-≤2 folder.
   - Popup badge: "Detected a bookmark import. Reorganized N bookmarks. Undo available 24h."
4. Otherwise (no burst): proceed with normal `onRemoved` cleanup.

---

## §11 — Snapshots and undo

- Snapshot format: flat array `[{ id, parentId, index, title, url }, ...]` for the entire bookmark tree. Cheap; well under quota even for 10k+ bookmarks.
- FIFO cap of 5 snapshots in `storage.local.snapshots`.
- **"Undo last rebuild"** in popup: enabled for 24h after most recent rebuild. Restores by computing diff vs. current tree and issuing minimal `move`/`update`/`create`/`remove` calls. Sets `currentJob` during restore to block event handlers.
- Options page snapshot viewer: list of last 5 with timestamps and summaries; restore any.

---

## §12 — Popup UI

Components, top to bottom:

1. **Device status banner** (only if not primary):
   - "Secondary device — rebuilds run on **[primaryDeviceName]**. Click tracking active here."
   - Or if no primary yet: "Pick a primary device to start organizing. [Go to settings]"

2. **Status line** (primary device only):
   - "Last rebuild: 4h ago · Next: in 20h"
   - Or "Manual only" if `scheduleDays === "manual"`
   - If `firstRunCompleted` but no MRU yet: append "MRU regions appear after next rebuild."

3. **Footprint line:** "Maintaining N duplicates across M folders."

4. **Buttons:**
   - **Rebuild now** (disabled on secondary, tooltip explains)
   - **Undo last rebuild** (disabled if no snapshot or >24h old, tooltip explains)

5. **Quick search:** live filter input across all bookmarks by title/URL. Clicks open and count accurately via popup-tracker. (Kept for v1 per Point 13.)

6. **Top 5 most-used bookmarks overall** (orientation): a small list, click to open + count.

7. **Footer links** in this order:
   - "Cleanly Remove Extension" — opens options scrolled to teardown section with button highlighted
   - "Options"

---

## §13 — Options page

Sections:

**Schedule**
- Frequency: Manual / 1 / 2 / 3 / 7 days. Default 1.

**MRU region**
- Globally enable/disable (default on).
- Items per folder (3–10, default 5).
- Minimum subtree size to populate MRU (default 8).
- Title prefix (free text, default `★ `, empty allowed; live preview shows "[prefix]GitHub").
- Default candidate scope: subtree (default) / direct children only.
- Global duplicate cap (default 500).
- Per-folder enable + scope override (tree picker showing only depth-≤2 folders).

**Alphabetical sort**
- Enable per root (bar / other / mobile). Defaults off / on / off.
- Per-folder exclusions (tree picker, identity stored as `{id, path}`).

**Devices**
- Current device: shows `deviceName` and role (primary / secondary).
- Known devices list: name, role, last seen.
- "Make this device primary" button (writes to `sync.primaryDeviceId`).
- Per-device rename input.

**Data**
- Snapshot viewer with restore from any of last 5.
- Export counts as JSON download.
- Import counts from JSON.
- Reset all counts (forces export first; modal confirmation).
- **"Cleanly Remove Extension" (teardown):** prominent, scroll-target. Removes every duplicate in the map from the tree, clears duplicates map, sets `mruEnabledGlobally = false`. Leaves alphabetical sort settings alone. Modal: "This will remove all `★ `-prefixed shortcuts the extension created. Your original bookmarks are not affected. Continue?" [Run teardown] [Cancel]

**Privacy panel**
- What's stored locally vs. synced.
- What `webNavigation` does and doesn't see.
- Duplicates sync via Chrome Sync if enabled.
- Click data is per-device.

---

## §14 — README

Must cover:

1. **What it does** — alphabetization + MRU at top-level folders + bookmarks bar.
2. **Layout diagram** — show before/after of a folder.
3. **Why only top-level folders get MRU** — explain subtree-bubbling: deep-folder MRU would duplicate items already shown at ancestor level. May come in a future version.
4. **The `★ ` prefix** — what it means, that it's configurable, that it appears in address-bar autocomplete (accepted tradeoff).
5. **`webNavigation` permission** — why it's needed (Chrome has no bookmark-click event), what it sees (URLs of navigations classified as `auto_bookmark`), what it doesn't (page contents, form data, anything outside bookmark-click navigations). README leads with this for transparency.
6. **Click-tracking accuracy** — `auto_bookmark` is heuristic; some misses, some false matches. Counts are directional. Clicks via the popup are always accurate.
7. **Devices** — primary/secondary model. Click data is per-device. How to change primary.
8. **Chrome Sync implications** — duplicates and settings sync; counts don't. Pick one device as primary to avoid thrash.
9. **Undo** — 24h window. Snapshot viewer in options goes back 5 rebuilds.
10. **Clean uninstall** — **lead this section with the teardown button.** Uninstalling Chrome extensions doesn't fire a cleanup hook; skipping teardown leaves `★ ` duplicates behind. Step-by-step: popup → "Cleanly Remove Extension" → confirm → then uninstall from `chrome://extensions`.
11. **Known limitations / v2 ideas** — URL normalization, deep-folder MRU, history seeding, telemetry.

---

## §15 — Edge cases (handle explicitly with code comments)

- Folder deleted with bookmarks inside: `onRemoved.node` walked recursively, all ids cleaned.
- Bookmark restored via Ctrl+Z after our cleanup: new id, fresh state. Next rebuild recreates duplicates if it ranks. Documented as expected.
- User edits a duplicate's title directly: overwritten on next rebuild (re-sync from original).
- User deletes a duplicate manually: 7-day suppression prevents immediate recreation.
- User moves a duplicate out of its MRU folder: converted to regular bookmark, prefix stripped, 7-day suppression.
- Original is direct child of a folder whose MRU would include it: skipped per §2 rule.
- Subtree-scope duplicates one popular bookmark into multiple ancestor folders' MRUs at depth ≤ 2: allowed (it's the chosen design), capped by `duplicateCap`.
- Same URL across multiple unrelated originals: increment all on click.
- Bulk import: §10 handling.
- Folder moved from depth >2 to ≤2 or vice versa: §5 `onMoved` handling.
- 10,000+ bookmarks: subtree caches in `lib/tree.js`, invalidated on tree events; change-hash skip on rebuild.
- Service worker killed mid-rebuild: stale `currentJob` → restore prompt on startup.
- User concurrently editing bookmark manager during rebuild: not detected (would require `tabs`); accept rare clobbering, document.
- `auto_bookmark` transitionType misses: documented; popup is the precise-tracking alternative.
- Double prefix (`★ ★ Title`) when original starts with prefix: allowed verbatim.
- Onboarding closed mid-flow: `firstRunCompleted = false`, popup badge prompts resume.
- Secondary device clicks "Rebuild now": button disabled, never reachable.
- Two devices race to claim primary: `sync.primaryDeviceId` last-write-wins (Chrome Sync handles); document as known limitation.

---

## Build order

**Critical:** do not deviate from this order. Do not combine, reorder, defer, or stub out any step. In particular, **step 3 (`lib/undo.js`) is non-negotiable and must ship complete and tested before any subsequent step writes code that calls `chrome.bookmarks.move`, `chrome.bookmarks.update`, `chrome.bookmarks.create`, or `chrome.bookmarks.remove` outside of `lib/undo.js` itself.** If the temptation arises to "wire up the rebuild logic first and add snapshots later," resist it: the entire purpose of the build order is to ensure that the user can always recover from a bug in any later step. A bug in step 10 (`rebuild.js`) without step 3 in place means a user's bookmark tree is permanently corrupted with no recovery path. This has happened before in similar tools; do not let it happen here.

1. `manifest.json`, skeleton, real icons, `lib/storage.js` with schema versioning.
2. `lib/locale.js`, `lib/tree.js` (depth helpers, subtree walks), `lib/sorter.js` — alphabetical sort logic only, **not yet wired to any trigger**. Unit-testable pure functions where possible. Sorter at this step returns a *plan* (an array of intended `move`/`update` operations); it does not execute them. Execution of sort plans only begins at step 5, after `lib/undo.js` exists.

3. **`lib/undo.js` — snapshots + restore. NON-NEGOTIABLE STEP. Build this fully before step 4.**

   This module is the safety net for every subsequent tree-modifying step. It must be production-complete here, not a stub.

   **Required API (do not reduce):**
   - `async function takeSnapshot(summary: string): Promise<SnapshotId>` — walks the entire bookmark tree via `chrome.bookmarks.getTree`, flattens to `[{id, parentId, index, title, url}, ...]`, prepends to `storage.local.snapshots` array, evicts oldest beyond cap of 5, returns the new snapshot's `takenAt` timestamp as its id. Records `summary` alongside the tree data.
   - `async function listSnapshots(): Promise<SnapshotMeta[]>` — returns `[{id, takenAt, summary, treeSizeNodes}, ...]` for UI display, without loading full tree data.
   - `async function restoreSnapshot(snapshotId): Promise<RestoreReport>` — restores the bookmark tree to the state captured in that snapshot. Must:
     - Set `currentJob = { startedAt: now, kind: "restore" }` BEFORE issuing any tree calls, so event handlers in step 11 will no-op when they exist. (At step 3 the event handlers don't exist yet; the flag is set anyway to make the contract explicit.)
     - Compute a diff between current tree and snapshot tree.
     - Issue `chrome.bookmarks.create` for nodes in snapshot but not in current tree (parent-first ordering required — never create a child before its parent exists).
     - Issue `chrome.bookmarks.update` for nodes where title or url differs.
     - Issue `chrome.bookmarks.move` for nodes whose `parentId` or `index` differs (deepest-first ordering to avoid index shifts invalidating moves earlier in the batch).
     - Issue `chrome.bookmarks.remove` for nodes in current tree but not in snapshot (deepest-first, since removing a folder cascades).
     - Clear `currentJob` on success or failure.
     - Return `{movedCount, updatedCount, createdCount, removedCount, errors}`.
   - `async function getLastSnapshotAge(): Promise<number | null>` — returns ms since most recent snapshot's `takenAt`, or null if none.
   - `function isUndoAvailable(): Promise<boolean>` — true iff most recent snapshot is within 24h.

   **Required behaviors (each must be implemented, not deferred):**
   - Snapshots store the **full tree**, not a diff. Restoration must work even if intermediate state is arbitrarily corrupted.
   - Snapshot capture is atomic from the caller's perspective: `takeSnapshot` completes before the caller proceeds. No fire-and-forget.
   - FIFO cap of 5 is strict; never grow beyond 5 stored snapshots.
   - Storage writes go through `lib/storage.js` (which handles schema versioning); do not bypass.
   - Restore must handle the case where bookmark ids in the snapshot no longer exist (Chrome may have re-issued ids if user did manual bulk operations). Match by `{parentId-path, title, url}` as fallback identity.
   - Restore must handle the case where the user has *added* bookmarks since the snapshot was taken. Default behavior: leave them in place (do not delete user-added bookmarks during restore). Document this in a code comment so a future maintainer doesn't "fix" it.
   - All operations logged to console under `[undo]` prefix with enough detail to diagnose a failed restore.

   **Required tests (acceptance gate — do not proceed to step 4 until all pass):**
   Create `test-undo.md` documenting manual verification of each:
   - T1: Take snapshot. Manually move a bookmark in Chrome's bookmark manager. Restore. Verify bookmark is back in original location.
   - T2: Take snapshot. Manually delete a bookmark. Restore. Verify bookmark is recreated with correct parent, index, title, url.
   - T3: Take snapshot. Manually rename a folder. Restore. Verify folder name is restored.
   - T4: Take snapshot. Manually create a new bookmark. Restore. Verify the new bookmark is preserved (not deleted), per the documented "additive changes survive restore" rule.
   - T5: Take 6 snapshots in sequence. Verify only 5 are retained and oldest was evicted.
   - T6: Take snapshot of a tree with 100+ bookmarks across nested folders. Make 20 mixed changes (moves, renames, deletes, creates). Restore. Verify every change is correctly reverted or preserved per the rules.
   - T7: Confirm `currentJob` is set during restore and cleared after, by inspecting `storage.local` mid-restore (set a breakpoint or add a sleep).
   - T8: Run restore twice in a row. Second restore must be a no-op (tree already matches snapshot).

   **Do not proceed to step 4 until `test-undo.md` is written and every test is checked off as passing.** If you find yourself wanting to skip T6 or T7 because they're tedious, that is exactly the moment they're most necessary. The whole rest of the extension's safety guarantees rest on this module behaving correctly under adversarial conditions.

   **What is explicitly out of scope for step 3** (do not add):
   - UI for browsing snapshots (that's step 15, options page).
   - Automatic snapshot-on-event (snapshots are taken explicitly by callers in later steps).
   - Compression or deduplication of snapshot storage (premature; 5 snapshots × small flat array is well under quota).
   - Cloud backup of snapshots (out of scope entirely; never sync snapshots).

4. `lib/device.js` — device id generation, primary/secondary helpers, `knownDevices` updates.
5. `onboarding.html` + flow — 4-screen onboarding, including the first-run alphabetical-only sort. **This is the first step in the build order that actually executes `chrome.bookmarks.move` against the user's tree.** Before doing so, the first-run sort handler MUST call `undo.takeSnapshot("Pre-first-run sort")` and only proceed if the snapshot succeeds. If snapshot fails for any reason (quota, permission, unexpected error), abort the sort and show the user an error in the onboarding UI explaining that the sort cannot proceed without a recovery point. Same rule applies to every later step that modifies the tree: snapshot first, then modify. No exceptions.
6. `lib/tracker.js` — `webNavigation` listener, count storage. Tracks clicks on originals only at this stage.
7. `lib/duplicates.js` — map and attribution. Click resolution now routes duplicate → original correctly.
8. `lib/mru.js` — candidate selection with subtree walks, scoring, skip rules.
9. `lib/suppression.js` — 7-day suppression list helpers.
10. `lib/rebuild.js` — per-folder rebuild enforcing layout invariant; integrates sort + MRU + orphan conversion.
11. Event handlers in `background.js` for `onRemoved` / `onChanged` / `onMoved` / `onCreated` with `currentJob` guard.
12. `lib/bulk-import.js` — bulk-import detection and handling.
13. Scheduled rebuilds: alarm, idle gate, primary-device gate, change-hash skip, `currentJob` lifecycle, stale-job recovery on startup.
14. Popup UI.
15. Options page (all sections, snapshot viewer, devices, teardown).
16. README, `_locales/en/messages.json`, polish, manual end-to-end test checklist.

---

## Manual test checklist (deliverable alongside code)

A markdown file with steps for verifying:

- First install on a clean profile: onboarding fires, alphabetical sort runs, no MRU appears.
- Second install (sync to another profile): onboarding shows existing primary, user can keep secondary.
- Click tracking: open a bookmark via Chrome's native UI, verify count increments in `storage.local`.
- MRU appearance: set `scheduleDays: "manual"`, click "Rebuild now," verify `★ ` items appear at top of depth-≤2 folders only.
- Duplicate cleanup: delete an original, verify its duplicates vanish.
- Suppression: delete a duplicate manually, run rebuild, verify it doesn't immediately reappear.
- Orphan conversion: simulate orphan (corrupt duplicates map), run rebuild, verify prefix stripped and bookmark survives.
- Undo: rebuild, then click "Undo last rebuild," verify tree restored.
- Teardown: run teardown, verify all duplicates removed and `mruEnabledGlobally = false`.
- Secondary device behavior: set primary elsewhere, verify rebuild button disabled and click tracking still works.
- Bulk import: import a large bookmarks HTML file, verify import-detection path fires and tree gets rebuilt cleanly.
- Folder moved from depth 3 → depth 2: verify it gains MRU on next rebuild.

---

## Confirmation requested before step 1

Before writing any code, confirm:
1. The layout invariant in §1 (MRU before subfolders, breaking strict folders-first ordering for depth-≤2 folders) is understood and intentional.
2. The `webNavigation` permission's "Read your browsing history" install warning is acceptable.
3. The build order's snapshot-before-modification ordering will be respected without skipping ahead.

Then begin with step 1.
