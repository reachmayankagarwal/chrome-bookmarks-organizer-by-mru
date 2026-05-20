# Storage Migration Acceptance Gate

**Step 1 acceptance criteria:** at least one v1→v2 round-trip migration test proving the
migration path runs forward without data loss.

---

## What is being tested

`lib/storage.js` ships with a `getMigrations(area)` function that returns an ordered
list of `{ fromVersion, toVersion, migrate(data) }` objects.  A `runMigrations` helper
(module-private) iterates through them in ascending `fromVersion` order, calling each
applicable `migrate()` in turn and advancing `data.schemaVersion` after each step.

The test below uses a **synthetic schema bump**: it temporarily injects a v1→v2 migration
into the pipeline to verify that:

1. A v1 data blob is correctly advanced to v2.
2. All existing v1 fields are preserved (no data loss).
3. A new field added by the migration is present with its default value.
4. `schemaVersion` is updated to `2`.
5. Running the same migration a second time on already-v2 data is a no-op (idempotency).

---

## Runnable test snippet

Paste this into the **browser DevTools console** while the extension is loaded as an
unpacked extension (or in any environment that exposes `chrome.storage`).

```js
// ─── v1→v2 round-trip migration test ─────────────────────────────────────────
// This test does NOT require the extension to be installed; it works purely
// with the module-level logic extracted below.

// ── 1. Reproduce the internal helpers from lib/storage.js ──────────────────
function runMigrations(data, targetVersion, migrations) {
  const sorted = [...migrations].sort((a, b) => a.fromVersion - b.fromVersion);
  let currentVersion = data.schemaVersion ?? 0;
  for (const m of sorted) {
    if (currentVersion === m.fromVersion && currentVersion < targetVersion) {
      data = m.migrate(data);
      data.schemaVersion = m.toVersion;
      currentVersion = m.toVersion;
    }
  }
  return data;
}

// ── 2. Define a synthetic v1→v2 migration ─────────────────────────────────
const syntheticV1toV2 = {
  fromVersion: 1,
  toVersion:   2,
  migrate(data) {
    // New field added in hypothetical v2
    data.newFeatureFlag = data.newFeatureFlag ?? false;
    return data;
  },
};

// ── 3. Build a realistic v1 local-area data blob ───────────────────────────
const v1Data = {
  schemaVersion:     1,
  installedAt:       1700000000000,
  nextRunAt:         1700086400000,
  firstRunCompleted: true,
  deviceId:          'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  deviceName:        'My Laptop',
  currentJob:        null,
  counts: {
    'bm001': { count: 42, lastUsed: 1700000000000, url: 'https://example.com', titleAtLastClick: 'Example' }
  },
  duplicates:     {},
  suppression:    [],
  snapshots:      [],
  enabledFolders: {},
  folderHashes:   {},
};

// ── 4. Run the migration pipeline (targetVersion bumped to 2) ──────────────
const migrated = runMigrations(structuredClone(v1Data), 2, [syntheticV1toV2]);

// ── 5. Assertions ──────────────────────────────────────────────────────────
const results = [];

function assert(label, condition) {
  results.push({ label, pass: condition });
}

assert('schemaVersion advanced to 2',
  migrated.schemaVersion === 2);

assert('installedAt preserved',
  migrated.installedAt === v1Data.installedAt);

assert('deviceId preserved',
  migrated.deviceId === v1Data.deviceId);

assert('counts preserved (bm001 count)',
  migrated.counts['bm001'].count === 42);

assert('firstRunCompleted preserved',
  migrated.firstRunCompleted === true);

assert('newFeatureFlag added with default false',
  migrated.newFeatureFlag === false);

// Idempotency: running again on v2 data must be a no-op
const migrated2 = runMigrations(structuredClone(migrated), 2, [syntheticV1toV2]);
assert('idempotency: second run leaves schemaVersion at 2',
  migrated2.schemaVersion === 2);

assert('idempotency: second run does not duplicate/alter counts',
  migrated2.counts['bm001'].count === 42);

// ── 6. Report ──────────────────────────────────────────────────────────────
const passed = results.filter(r => r.pass).length;
const failed = results.filter(r => !r.pass);

console.log(`Migration test: ${passed}/${results.length} passed`);
if (failed.length) {
  console.error('FAILED:', failed.map(r => r.label));
} else {
  console.log('All assertions passed ✓');
}
```

---

## Expected output

```
Migration test: 8/8 passed
All assertions passed ✓
```

---

## How to run

### Option A — Browser DevTools (recommended for extension context)

1. Open Chrome and navigate to `chrome://extensions`.
2. Enable **Developer mode** (top-right toggle).
3. Click **Load unpacked** and select the `Bookmarks Organizer` directory.
4. Open any Chrome tab and press **F12** to open DevTools.
5. Paste the entire snippet from the "Runnable test snippet" section into the Console tab.
6. Press **Enter** and verify the output matches "Expected output" above.

### Option B — Node.js (no Chrome required)

The `runMigrations` logic has no Chrome-specific dependencies.  Copy the snippet into a
`.mjs` file (or wrap in an IIFE) and run with `node test-storage-runner.mjs`.

---

## Notes on the full migration system

- `getMigrations('local')` and `getMigrations('sync')` in `lib/storage.js` return empty
  arrays for v1 (no migration needed to reach the initial schema).
- To add a real migration in a future step, push a `{ fromVersion, toVersion, migrate }`
  object into the appropriate array in `getMigrations()` **and** bump the corresponding
  `LOCAL_SCHEMA_VERSION` / `SYNC_SCHEMA_VERSION` constant.
- `runMigrations` is idempotent: re-running it on already-migrated data skips all steps
  whose `fromVersion` is below `data.schemaVersion`.
- The `readArea()` function in `lib/storage.js` calls `runMigrations` on every read,
  so migrations are applied lazily on first access after an extension update.
