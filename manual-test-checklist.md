# Manual Test Checklist

End-to-end test scenarios for Bookmark Organizer. Run through all tests on each significant release.

---

## Test 1: First install (clean profile)

- [ ] Install extension on a clean Chrome profile
- [ ] Onboarding opens in a new tab (4 screens)
- [ ] Complete onboarding: name the device, make it primary, click "Sort my bookmarks now"
- [ ] Verify: bookmarks are alphabetized; no `★ ` items appear (MRU requires a rebuild after click data accumulates)
- [ ] Verify: `firstRunCompleted = true` in storage.local

---

## Test 2: Second install (sync to another profile)

- [ ] Install extension on a second Chrome profile (same Chrome Sync account)
- [ ] Onboarding shows: "[deviceName] is currently your primary device" (Case B)
- [ ] Choose "Keep [name] as primary"
- [ ] Verify: popup shows "Secondary device — rebuilds run on [primaryDeviceName]"
- [ ] Verify: "Rebuild now" button is disabled with tooltip

---

## Test 3: Click tracking

- [ ] On primary device, click a bookmark via Chrome's native UI (bookmark bar or bookmark manager)
- [ ] Open extension devtools (service worker console): run `chrome.storage.local.get('counts', console.log)`
- [ ] Verify: the bookmark's ID appears in counts with `count >= 1`

---

## Test 4: MRU appearance

- [ ] Go to Options → Schedule → set "Manual only"
- [ ] Click "Rebuild now" in popup
- [ ] Verify: `★ `-prefixed shortcuts appear at the top of at least one depth-≤2 folder (requires at least `mruMinSubtreeSize` bookmarks and some click history)
- [ ] Verify: shortcuts appear before subfolders, and subfolders appear before regular bookmarks

---

## Test 5: Duplicate cleanup

- [ ] Find an original bookmark that has a `★ ` duplicate
- [ ] Delete the original bookmark in Chrome's bookmark manager
- [ ] Verify: its `★ ` duplicate is also removed (within a few seconds, via the `onRemoved` event handler)

---

## Test 6: Suppression

- [ ] Find a `★ ` duplicate and manually delete it (not the original)
- [ ] Click "Rebuild now"
- [ ] Verify: the duplicate does NOT reappear immediately (7-day suppression active)
- [ ] Verify: `storage.local.suppression` contains an entry for that bookmark

---

## Test 7: Orphan conversion

- [ ] In DevTools console: read duplicates map, pick a duplicateId
- [ ] Manually delete the original bookmark (not the duplicate)
- [ ] Trigger a rebuild
- [ ] Verify: the former duplicate loses its `★ ` prefix and moves to the alphabetical region

---

## Test 8: Undo

- [ ] Note the current order of a bookmark folder
- [ ] Click "Rebuild now" in popup
- [ ] Verify order changed (bookmarks sorted / MRU at top)
- [ ] Click "Undo last rebuild"
- [ ] Verify: folder order is restored to what it was before

---

## Test 9: Teardown

- [ ] In popup: click "Cleanly Remove Extension" (or Options → Data → Cleanly Remove Extension)
- [ ] Confirm the modal
- [ ] Verify: "Teardown complete" message appears
- [ ] Verify: all `★ `-prefixed bookmarks are gone from the tree
- [ ] Verify: `storage.sync.mruEnabledGlobally = false`
- [ ] Verify: original bookmarks are untouched

---

## Test 10: Secondary device

- [ ] Set primary on Device A; open popup on Device B (secondary)
- [ ] Verify: popup shows "Secondary device — rebuilds run on [name]"
- [ ] Verify: "Rebuild now" button is disabled on Device B
- [ ] Click a bookmark on Device B via Chrome UI
- [ ] Verify: `storage.local.counts` on Device B has the click recorded

---

## Test 11: Bulk import

- [ ] Export a large bookmarks HTML file from another browser (or create one manually with 60+ bookmark entries)
- [ ] Import it into Chrome via Bookmarks Manager → Import
- [ ] Verify: extension detects the import (check service worker console for `[bulk-import]` log lines)
- [ ] Verify: after 5 seconds of silence, a rebuild is triggered automatically

---

## Test 12: Folder moved from depth 3 → depth 2

- [ ] Create a bookmark folder inside an existing depth-2 folder (making it depth-3)
- [ ] Move that folder up one level so it becomes depth-2
- [ ] Trigger a rebuild
- [ ] Verify: the folder now appears in Options → MRU per-folder table
- [ ] Verify: after the rebuild, `★ ` shortcuts appear in it (if it has enough click history)
