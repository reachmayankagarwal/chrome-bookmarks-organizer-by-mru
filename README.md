# Most Recently Used (MRU) Bookmarks Organizer

A Chrome extension that alphabetizes your bookmark folders and surfaces your most-used bookmarks as pinned shortcuts.

---

## 1. What it does

Bookmark Organizer alphabetizes bookmark folders and surfaces frequently-used bookmarks as pinned shortcuts at the top of your top-level folders (Bookmarks Bar, Other Bookmarks, Mobile Bookmarks) and their direct child folders. Shortcuts are prefixed with `★ ` (configurable). Only the user-designated "primary device" reorganizes the tree; all devices track clicks locally.

---

## 2. Layout

Each reorganized folder is divided into three regions:

1. **MRU shortcuts** — `★ `-prefixed copies of your most-visited bookmarks
2. **Subfolders** — alphabetically sorted
3. **Bookmarks** — alphabetically sorted

**Example:**

```
Before (unsorted):
  GitHub
  Amazon
  Work Docs
  AWS Console
  Figma (visited 12×)
  Google Maps (visited 9×)

After rebuild (assuming Figma and Google Maps are in the MRU top-2):
  ★ Figma
  ★ Google Maps
  Amazon
  AWS Console
  Figma
  GitHub
  Google Maps
  Work Docs
```

The three regions are always ordered: [MRU shortcuts] [Subfolders alphabetically] [Bookmarks alphabetically].

---

## 3. Why only top-level folders get MRU shortcuts

Deep-folder MRU would duplicate items already shown at their ancestor folder level. Adding `★ GitHub` inside a nested "Dev" folder would mean it also appears at the Bookmarks Bar level — the same item would be pinned multiple places. Only depth-1 and depth-2 folders (i.e., the three root folders and their direct children) get MRU regions. Deeper folders are alphabetized only.

---

## 4. The ★ prefix

- The `★ ` prefix is cosmetic; it is how the extension identifies shortcuts vs. your real bookmarks.
- It appears in address-bar autocomplete. This is an accepted tradeoff — the shortcuts exist to surface frequently-used bookmarks faster.
- The prefix is configurable (or can be set to empty) in Options → MRU Region.
- If your own bookmark titles already start with `★ `, they will appear as `★ ★ Your title` in shortcuts. This is intentional; the duplicate is a copy, not your original.

---

## 5. webNavigation permission — "Read browsing history" warning

Chrome shows this warning because the extension registers a `webNavigation.onCommitted` listener.

**What it sees:** only navigations with `transitionType === "auto_bookmark"` — navigations caused by clicking a bookmark.

**What it does NOT see:** page contents, form data, your browsing history, or navigations not triggered by a bookmark click.

This permission is the only way Chrome extensions can detect bookmark clicks; there is no dedicated "bookmark-click" event. The count data stays on your device and is never uploaded anywhere.

---

## 6. Click-tracking accuracy

The `auto_bookmark` transition type is heuristic — Chrome labels some bookmark-triggered navigations with other transition types, and occasionally labels non-bookmark navigations as `auto_bookmark`. Counts are directional, not exact. Clicking bookmarks via the extension's popup is always precisely attributed. URL normalization (e.g. stripping query strings) is deferred to a future version.

---

## 7. Devices (primary / secondary)

- **Primary device:** the one device that reorganizes your bookmark tree. Set during onboarding.
- **Secondary devices:** track clicks locally but do not modify bookmarks.
- Click data is per-device. Your work and home devices learn independently.
- To change primary: Options → Devices → "Make this device primary."
- If no primary is set for 30 days, the extension auto-claims primary on the next popup open.

---

## 8. Chrome Sync

Settings (schedule, MRU config, sort config, device registry) sync across all your Chrome profiles via Chrome Sync if enabled. Click counts and safety snapshots stay local — they are never synced.

---

## 9. Undo

The extension takes a safety snapshot before every rebuild. In the popup, "Undo last rebuild" restores the previous tree state (available for 24 hours). The Options → Data page shows the last 5 snapshots with individual restore buttons.

---

## 10. Clean uninstall

**Do this before uninstalling.** Uninstalling a Chrome extension does not trigger cleanup code — if you skip this step, the `★ ` shortcut bookmarks will remain in your tree permanently.

**Steps:**

1. Click the extension icon → "Cleanly Remove Extension" (at the bottom of the popup) — or go to Options → Data → Cleanly Remove Extension.
2. Confirm the modal.
3. Wait for "Teardown complete" confirmation.
4. Then uninstall from `chrome://extensions`.

Your original bookmarks are never removed — only the `★ `-prefixed shortcuts.

---

## 11. Known limitations & v2 ideas

### Known limitations

- **Deep-folder MRU (depth > 2) is not supported in v1.** Only the three root folders and their direct children receive MRU shortcut regions.
- **URL normalization is not implemented.** Two URLs that are the same page but differ in query string are counted separately.
- **Concurrent edit race condition.** If you edit your bookmarks in Chrome's bookmark manager at the same time as a rebuild is running, rare clobbering can occur (undetectable without the `tabs` permission).
- **Primary device race.** Two devices racing to claim primary will resolve as last-write-wins (Chrome Sync handles conflict resolution).

### v2 ideas

- Deep-folder MRU with a per-folder override for the depth limit.
- URL normalization for more accurate click attribution.
- History-based seeding for cold-start MRU (new devices start with good recommendations).
- Keyboard shortcut to open the popup.
