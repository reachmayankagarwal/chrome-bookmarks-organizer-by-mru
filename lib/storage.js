/**
 * lib/storage.js — Schema-versioned storage wrapper
 *
 * ALL chrome.storage access for the extension MUST go through this module.
 * No other module may call chrome.storage.local.* or chrome.storage.sync.*
 * directly.
 *
 * Supports both storage areas ('local' and 'sync') with:
 *   - Schema versioning via schemaVersion
 *   - Forward-only migration pipeline
 *   - Typed defaults for every key in both areas
 *   - get / set / remove API
 *
 * Public API
 * ----------
 *   storage.local.get(key)
 *   storage.local.set(key, value)
 *   storage.local.remove(key)
 *   storage.sync.get(key)
 *   storage.sync.set(key, value)
 *   storage.sync.remove(key)
 *   storage.getMigrations(area)   → [{ fromVersion, toVersion, migrate(data) }]
 */

// ---------------------------------------------------------------------------
// Schema version constants
// ---------------------------------------------------------------------------

const LOCAL_SCHEMA_VERSION = 1;
const SYNC_SCHEMA_VERSION  = 1;
export const SNAPSHOTS_MAX = 5;

// ---------------------------------------------------------------------------
// Default values for every key in each area
// ---------------------------------------------------------------------------

/** @returns {object} A fresh default local-area state (v1). */
function defaultLocalState() {
  return {
    schemaVersion:     LOCAL_SCHEMA_VERSION,
    installedAt:       null,    // epoch ms — set on first install
    nextRunAt:         null,    // epoch ms
    firstRunCompleted: false,
    deviceId:          null,    // uuid string
    deviceName:        null,    // user-named string
    currentJob:        null,    // { startedAt, kind } | null
    counts:            {},      // { [bookmarkId]: { count, lastUsed, url, titleAtLastClick } }
    duplicates:        {},      // { [duplicateId]: { originalId, parentFolderId, originalUrl, createdAt } }
    suppression:       [],      // [{ originalId, parentFolderId, until }]
    snapshots:         [],      // [{ takenAt, summary, tree: [{id,parentId,index,title,url}] }] — FIFO cap — callers must enforce SNAPSHOTS_MAX
    enabledFolders:    {},      // { [folderId]: { mruEnabled, sortEnabled, candidateScope, lastUserEditAt, path } }
    folderHashes:      {},      // { [folderId]: "..." }
  };
}

/** @returns {object} A fresh default sync-area state (v1). */
function defaultSyncState() {
  return {
    schemaVersion:         SYNC_SCHEMA_VERSION,
    scheduleDays:          1,          // 1 | 2 | 3 | 7 | "manual"
    mruEnabledGlobally:    true,
    mruItemsPerFolder:     5,
    mruMinSubtreeSize:     8,
    mruPrefix:             '★ ',
    defaultCandidateScope: 'subtree',  // "subtree" | "direct"
    duplicateCap:          500,
    sortBookmarksBar:      false,
    sortOtherBookmarks:    true,
    sortMobileBookmarks:   false,
    primaryDeviceId:       null,
    primaryDeviceName:     null,
    knownDevices:          {},         // { [deviceId]: { name, lastSeenAt } }
  };
}

// ---------------------------------------------------------------------------
// Migration registry
// ---------------------------------------------------------------------------

/**
 * Returns the ordered list of migrations for a given storage area.
 *
 * Each migration object:
 *   fromVersion {number}
 *   toVersion   {number}
 *   migrate     {function(data: object): object}  — must return the mutated data
 *
 * To add a migration (e.g. v1 → v2):
 *   Push { fromVersion: 1, toVersion: 2, migrate(data) { ... return data; } }
 *   into the appropriate array below, then bump LOCAL_SCHEMA_VERSION or
 *   SYNC_SCHEMA_VERSION to 2.
 *
 * @param {'local'|'sync'} area
 * @returns {Array<{fromVersion: number, toVersion: number, migrate: function}>}
 */
function getMigrations(area) {
  const localMigrations = [
    // Example — will be used by the v1→v2 test in test-storage.md:
    // {
    //   fromVersion: 1,
    //   toVersion:   2,
    //   migrate(data) {
    //     data.newFieldAddedInV2 = 'default';
    //     return data;
    //   },
    // },
  ];

  const syncMigrations = [
    // Sync-area migrations added here as the schema evolves.
  ];

  if (area === 'local') return localMigrations;
  if (area === 'sync')  return syncMigrations;
  throw new Error(`Unknown storage area: "${area}"`);
}

// ---------------------------------------------------------------------------
// Migration runner
// ---------------------------------------------------------------------------

/**
 * Runs all applicable forward migrations on `data` until data.schemaVersion
 * matches `targetVersion`.
 *
 * Migrations are applied in ascending fromVersion order.
 * Data loss is prevented because each migrate() call receives the full object
 * and must return it (modified in place or as a new object).
 *
 * @param {object}           data          - The stored data blob (mutated in place)
 * @param {number}           targetVersion - The current code schema version
 * @param {Array}            migrations    - Result of getMigrations(area)
 * @returns {object}                         The migrated data (same reference)
 */
function runMigrations(data, targetVersion, migrations) {
  // Sort ascending by fromVersion so migrations run in correct order
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

// ---------------------------------------------------------------------------
// Low-level chrome.storage helpers
// ---------------------------------------------------------------------------

/**
 * Reads the entire storage area as a single object, applies migrations,
 * and merges defaults for any missing keys.
 *
 * @param {'local'|'sync'} area
 * @returns {Promise<object>}
 */
async function readArea(area) {
  const rawResult = await chrome.storage[area].get(null);

  // If storage is empty (first run), seed with defaults
  const defaults  = area === 'local' ? defaultLocalState() : defaultSyncState();
  const target    = area === 'local' ? LOCAL_SCHEMA_VERSION : SYNC_SCHEMA_VERSION;
  const migrations = getMigrations(area);

  // Merge: defaults win for missing keys, stored values win for present keys
  let data = Object.assign({}, defaults, rawResult);

  // Run any pending migrations
  data = runMigrations(data, target, migrations);

  return data;
}

/**
 * Writes a partial patch object back to the storage area.
 * Only the supplied keys are written (chrome.storage.set is already a merge).
 *
 * @param {'local'|'sync'} area
 * @param {object}         patch  - Keys to write
 * @returns {Promise<void>}
 */
async function writeArea(area, patch) {
  await chrome.storage[area].set(patch);
}

/**
 * Removes one or more keys from the storage area.
 *
 * @param {'local'|'sync'}       area
 * @param {string|string[]}      keys
 * @returns {Promise<void>}
 */
async function removeFromArea(area, keys) {
  await chrome.storage[area].remove(keys);
}

// ---------------------------------------------------------------------------
// Public area-scoped API factories
// ---------------------------------------------------------------------------

/**
 * Builds the public { get, set, remove } API object for a given area.
 *
 * @param {'local'|'sync'} area
 */
function makeAreaAPI(area) {
  return {
    /**
     * Reads a single key from the storage area, after running migrations and
     * applying defaults.  Returns `undefined` when the key is not found even
     * in the defaults.
     *
     * @param {string} key
     * @returns {Promise<any>}
     */
    async get(key) {
      const data = await readArea(area);
      return data[key];
    },

    /**
     * Writes a single key-value pair to the storage area.
     * Does NOT run migrations (call get() first if you need a migrated read-
     * modify-write cycle).
     *
     * @param {string} key
     * @param {any}    value
     * @returns {Promise<void>}
     */
    async set(key, value) {
      await writeArea(area, { [key]: value });
    },

    /**
     * Removes a single key from the storage area.
     *
     * @param {string} key
     * @returns {Promise<void>}
     */
    async remove(key) {
      await removeFromArea(area, key);
    },
  };
}

// ---------------------------------------------------------------------------
// Exported surface
// ---------------------------------------------------------------------------

/**
 * @namespace storage
 * @property {object} local  - Area API for chrome.storage.local
 * @property {object} sync   - Area API for chrome.storage.sync
 * @property {function} getMigrations - Returns migration list for an area (access via storage.getMigrations)
 */
const storage = {
  local: makeAreaAPI('local'),
  sync:  makeAreaAPI('sync'),
  getMigrations,
};

export default storage;
