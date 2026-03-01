const fs = require('fs');
const path = require('path');
const { runPendingMigrations } = require('./migrations.infra');

function ensureParentDir(filePath) {
  const target = String(filePath || '').trim();
  if (!target) return;
  const dir = path.dirname(target);
  if (!dir) return;
  fs.mkdirSync(dir, { recursive: true });
}

function initDbBootstrapInfra(options = {}) {
  const resolvedMainDbPath = String(options.dbPath || '').trim();
  const defaultOsmDbPath = resolvedMainDbPath
    ? path.join(path.dirname(resolvedMainDbPath), 'osm.db')
    : path.join(__dirname, '..', 'data', 'osm.db');
  const {
    Database,
    dbPath,
    osmDbPath = defaultOsmDbPath,
    localEditsDbPath,
    userEditsDbPath,
    userAuthDbPath,
    buildingsPmtilesPath,
    ensureAuthSchema,
    rtreeRebuildBatchSize = 4000,
    rtreeRebuildPauseMs = 8,
    migrationsDir = path.join(__dirname, '..', 'db', 'migrations'),
    isSyncInProgress = () => false,
    logger = console
  } = options;

  ensureParentDir(dbPath);
  ensureParentDir(osmDbPath);
  ensureParentDir(localEditsDbPath);
  ensureParentDir(userEditsDbPath);
  ensureParentDir(userAuthDbPath);
  ensureParentDir(buildingsPmtilesPath);

  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');

  db.prepare('ATTACH DATABASE ? AS osm').run(osmDbPath);
  db.prepare('ATTACH DATABASE ? AS local').run(localEditsDbPath);
  db.prepare('ATTACH DATABASE ? AS user_edits').run(userEditsDbPath);
  db.prepare('ATTACH DATABASE ? AS auth').run(userAuthDbPath);
  db.exec('PRAGMA osm.journal_mode = WAL;');
  db.exec('PRAGMA osm.synchronous = NORMAL;');
  db.exec('PRAGMA local.journal_mode = WAL;');
  db.exec('PRAGMA local.synchronous = NORMAL;');
  db.exec('PRAGMA user_edits.journal_mode = WAL;');
  db.exec('PRAGMA user_edits.synchronous = NORMAL;');
  db.exec('PRAGMA auth.journal_mode = WAL;');
  db.exec('PRAGMA auth.synchronous = NORMAL;');

  db.exec(`
CREATE TABLE IF NOT EXISTS osm.building_contours (
  osm_type TEXT NOT NULL,
  osm_id INTEGER NOT NULL,
  tags_json TEXT,
  geometry_json TEXT NOT NULL,
  min_lon REAL NOT NULL,
  min_lat REAL NOT NULL,
  max_lon REAL NOT NULL,
  max_lat REAL NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (osm_type, osm_id)
);

CREATE INDEX IF NOT EXISTS osm.idx_building_contours_bbox
ON building_contours (min_lon, max_lon, min_lat, max_lat);

CREATE TABLE IF NOT EXISTS building_search_source (
  osm_key TEXT PRIMARY KEY,
  osm_type TEXT NOT NULL,
  osm_id INTEGER NOT NULL,
  name TEXT,
  address TEXT,
  style TEXT,
  architect TEXT,
  local_priority INTEGER NOT NULL DEFAULT 0,
  center_lon REAL NOT NULL,
  center_lat REAL NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_building_search_source_osm
ON building_search_source (osm_type, osm_id);

CREATE TABLE IF NOT EXISTS filter_tag_keys_cache (
  tag_key TEXT PRIMARY KEY,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS app_smtp_settings (
  id INTEGER PRIMARY KEY CHECK(id = 1),
  smtp_url TEXT,
  smtp_host TEXT,
  smtp_port INTEGER NOT NULL DEFAULT 587,
  smtp_secure INTEGER NOT NULL DEFAULT 0,
  smtp_user TEXT,
  smtp_pass_enc TEXT,
  email_from TEXT,
  updated_by TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS app_general_settings (
  id INTEGER PRIMARY KEY CHECK(id = 1),
  app_display_name TEXT NOT NULL DEFAULT 'Archimap',
  app_base_url TEXT,
  registration_enabled INTEGER NOT NULL DEFAULT 1,
  user_edit_requires_permission INTEGER NOT NULL DEFAULT 1,
  updated_by TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

  function migrateLegacyOsmDataIfNeeded() {
    const hasLegacyContoursTable = Boolean(
      db.prepare(`
        SELECT 1
        FROM main.sqlite_master
        WHERE type = 'table' AND name = 'building_contours'
        LIMIT 1
      `).get()
    );
    if (!hasLegacyContoursTable) return;

    const osmContoursCount = Number(db.prepare('SELECT COUNT(*) AS total FROM osm.building_contours').get()?.total || 0);
    if (osmContoursCount > 0) return;

    db.exec(`
      INSERT OR REPLACE INTO osm.building_contours (
        osm_type, osm_id, tags_json, geometry_json, min_lon, min_lat, max_lon, max_lat, updated_at
      )
      SELECT
        osm_type, osm_id, tags_json, geometry_json, min_lon, min_lat, max_lon, max_lat, updated_at
      FROM main.building_contours
    `);
    logger.log('[db] migrated legacy building_contours from archimap.db to osm.db');
  }

  migrateLegacyOsmDataIfNeeded();

  const rtreeState = {
    supported: false,
    ready: false,
    rebuilding: false
  };

  function ensureBuildingContoursRtreeSchema() {
    const compileOptions = db.prepare('PRAGMA compile_options').all();
    const hasRtreeSupport = compileOptions.some((row) => String(row?.compile_options || '').includes('ENABLE_RTREE'));
    if (!hasRtreeSupport) {
      logger.warn('[db] SQLite R*Tree is not available (ENABLE_RTREE missing), bbox endpoint will use fallback query');
      rtreeState.supported = false;
      rtreeState.ready = false;
      return;
    }

    db.exec(`
CREATE VIRTUAL TABLE IF NOT EXISTS osm.building_contours_rtree
USING rtree(
  contour_rowid,
  min_lon, max_lon,
  min_lat, max_lat
);

CREATE TRIGGER IF NOT EXISTS osm.trg_building_contours_rtree_insert
AFTER INSERT ON building_contours
BEGIN
  INSERT OR REPLACE INTO building_contours_rtree (contour_rowid, min_lon, max_lon, min_lat, max_lat)
  VALUES (new.rowid, new.min_lon, new.max_lon, new.min_lat, new.max_lat);
END;

CREATE TRIGGER IF NOT EXISTS osm.trg_building_contours_rtree_update
AFTER UPDATE OF min_lon, max_lon, min_lat, max_lat ON building_contours
BEGIN
  DELETE FROM building_contours_rtree WHERE contour_rowid = old.rowid;
  INSERT INTO building_contours_rtree (contour_rowid, min_lon, max_lon, min_lat, max_lat)
  VALUES (new.rowid, new.min_lon, new.max_lon, new.min_lat, new.max_lat);
END;

CREATE TRIGGER IF NOT EXISTS osm.trg_building_contours_rtree_delete
AFTER DELETE ON building_contours
BEGIN
  DELETE FROM building_contours_rtree WHERE contour_rowid = old.rowid;
END;
`);
    rtreeState.supported = true;
  }

  function needsBuildingContoursRtreeRebuild() {
    if (!rtreeState.supported) return false;
    const contourCount = Number(db.prepare('SELECT COUNT(*) AS total FROM osm.building_contours').get()?.total || 0);
    const rtreeCount = Number(db.prepare('SELECT COUNT(*) AS total FROM osm.building_contours_rtree').get()?.total || 0);
    return contourCount !== rtreeCount;
  }

  async function rebuildBuildingContoursRtreeInBackground(reason = 'startup') {
    if (!rtreeState.supported || rtreeState.rebuilding) return;
    rtreeState.rebuilding = true;
    rtreeState.ready = false;

    const total = Number(db.prepare('SELECT COUNT(*) AS total FROM osm.building_contours').get()?.total || 0);
    logger.log(`[db] R*Tree rebuild started (${reason}), total contours: ${total}`);

    const batchSize = Math.max(500, Math.min(20000, Number(rtreeRebuildBatchSize) || 4000));
    const pauseMs = Math.max(0, Math.min(200, Number(rtreeRebuildPauseMs) || 8));
    const readBatch = db.prepare(`
      SELECT rowid, min_lon, max_lon, min_lat, max_lat
      FROM osm.building_contours
      WHERE rowid > ?
      ORDER BY rowid
      LIMIT ?
    `);
    const insertRow = db.prepare(`
      INSERT OR REPLACE INTO osm.building_contours_rtree (contour_rowid, min_lon, max_lon, min_lat, max_lat)
      VALUES (?, ?, ?, ?, ?)
    `);
    const insertBatch = db.transaction((rows) => {
      for (const row of rows) {
        insertRow.run(row.rowid, row.min_lon, row.max_lon, row.min_lat, row.max_lat);
      }
    });

    try {
      db.exec('DELETE FROM osm.building_contours_rtree;');
      if (total === 0) {
        rtreeState.ready = true;
        logger.log('[db] R*Tree rebuild finished: no contours to index');
        return;
      }

      let cursor = 0;
      let inserted = 0;
      let lastLoggedAt = 0;
      while (true) {
        const rows = readBatch.all(cursor, batchSize);
        if (rows.length === 0) break;
        insertBatch(rows);
        inserted += rows.length;
        cursor = Number(rows[rows.length - 1].rowid);

        const now = Date.now();
        if (inserted === total || (now - lastLoggedAt) >= 1000) {
          const percent = Math.min(100, (inserted / Math.max(1, total)) * 100);
          logger.log(`[db] R*Tree rebuild progress: ${inserted}/${total} (${percent.toFixed(1)}%)`);
          lastLoggedAt = now;
        }

        if (pauseMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, pauseMs));
        } else {
          await new Promise((resolve) => setImmediate(resolve));
        }
      }

      const contourCount = Number(db.prepare('SELECT COUNT(*) AS total FROM osm.building_contours').get()?.total || 0);
      const rtreeCount = Number(db.prepare('SELECT COUNT(*) AS total FROM osm.building_contours_rtree').get()?.total || 0);
      if (contourCount !== rtreeCount) {
        logger.warn('[db] R*Tree rebuild finished with drift, scheduling retry');
        setTimeout(() => scheduleBuildingContoursRtreeRebuild('retry'), 1000);
        return;
      }

      rtreeState.ready = true;
      logger.log(`[db] R*Tree rebuild completed: ${inserted} rows indexed`);
    } catch (error) {
      rtreeState.ready = false;
      throw error;
    } finally {
      rtreeState.rebuilding = false;
    }
  }

  function scheduleBuildingContoursRtreeRebuild(reason = 'startup') {
    if (!rtreeState.supported || rtreeState.ready || rtreeState.rebuilding) return;

    const waitForIdle = () => {
      if (isSyncInProgress()) {
        logger.log('[db] R*Tree rebuild postponed: sync is running');
        setTimeout(waitForIdle, 5000);
        return;
      }
      rebuildBuildingContoursRtreeInBackground(reason).catch((error) => {
        logger.error(`[db] R*Tree rebuild failed: ${String(error.message || error)}`);
      });
    };

    setTimeout(waitForIdle, 0);
  }

  ensureBuildingContoursRtreeSchema();
  rtreeState.ready = rtreeState.supported && !needsBuildingContoursRtreeRebuild();
  if (rtreeState.supported) {
    const contourCount = Number(db.prepare('SELECT COUNT(*) AS total FROM osm.building_contours').get()?.total || 0);
    const rtreeCount = Number(db.prepare('SELECT COUNT(*) AS total FROM osm.building_contours_rtree').get()?.total || 0);
    logger.log(`[db] R*Tree status at startup: ready=${rtreeState.ready}, contours=${contourCount}, rtree=${rtreeCount}`);
    if (!rtreeState.ready) {
      logger.log('[db] R*Tree requires rebuild, bbox endpoint will use fallback query until ready');
    }
  }

  db.exec(`
CREATE TABLE IF NOT EXISTS local.architectural_info (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  osm_type TEXT NOT NULL,
  osm_id INTEGER NOT NULL,
  name TEXT,
  style TEXT,
  levels INTEGER,
  year_built INTEGER,
  architect TEXT,
  address TEXT,
  description TEXT,
  archimap_description TEXT,
  updated_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(osm_type, osm_id)
);

CREATE INDEX IF NOT EXISTS local.idx_architectural_info_osm
ON architectural_info (osm_type, osm_id);

CREATE TABLE IF NOT EXISTS user_edits.building_user_edits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  osm_type TEXT NOT NULL,
  osm_id INTEGER NOT NULL,
  created_by TEXT NOT NULL,
  name TEXT,
  style TEXT,
  levels INTEGER,
  year_built INTEGER,
  architect TEXT,
  address TEXT,
  archimap_description TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  admin_comment TEXT,
  reviewed_by TEXT,
  reviewed_at TEXT,
  merged_by TEXT,
  merged_at TEXT,
  merged_fields_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS user_edits.idx_user_building_edits_lookup
ON building_user_edits (osm_type, osm_id, created_by, status, updated_at DESC);

CREATE INDEX IF NOT EXISTS user_edits.idx_user_building_edits_author
ON building_user_edits (created_by, updated_at DESC);

CREATE INDEX IF NOT EXISTS user_edits.idx_user_building_edits_status
ON building_user_edits (status, updated_at DESC);

`);

  db.exec(`
CREATE VIRTUAL TABLE IF NOT EXISTS building_search_fts
USING fts5(
  osm_key UNINDEXED,
  name,
  address,
  style,
  architect,
  tokenize = 'unicode61 remove_diacritics 2'
);
`);

  ensureAuthSchema(db);
  runPendingMigrations({ db, migrationsDir, logger });

  return {
    db,
    rtreeState,
    scheduleBuildingContoursRtreeRebuild
  };
}

module.exports = {
  initDbBootstrapInfra
};
