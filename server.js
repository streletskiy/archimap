require('dotenv').config();

const fs = require('fs');
const path = require('path');
const express = require('express');
const session = require('express-session');
const { RedisStore } = require('connect-redis');
const { createClient } = require('redis');
const Database = require('better-sqlite3');
const { spawn } = require('child_process');

const app = express();

const PORT = Number(process.env.PORT || 3252);
const HOST = process.env.HOST || '0.0.0.0';
const NODE_ENV = process.env.NODE_ENV || 'development';
const SESSION_SECRET = process.env.SESSION_SECRET || 'dev-secret-change-me';
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const AUTO_SYNC_ENABLED = String(process.env.AUTO_SYNC_ENABLED ?? 'true').toLowerCase() === 'true';
const AUTO_SYNC_ON_START = String(process.env.AUTO_SYNC_ON_START ?? 'true').toLowerCase() === 'true';
const AUTO_SYNC_INTERVAL_HOURS = Number(process.env.AUTO_SYNC_INTERVAL_HOURS || 168);
const REDIS_URL = process.env.REDIS_URL || 'redis://redis:6379';
const MAP_DEFAULT_LON = Number(process.env.MAP_DEFAULT_LON ?? 44.0059);
const MAP_DEFAULT_LAT = Number(process.env.MAP_DEFAULT_LAT ?? 56.3269);
const MAP_DEFAULT_ZOOM = Number(process.env.MAP_DEFAULT_ZOOM ?? 15);
const BUILDINGS_PMTILES_FILE = path.basename(String(process.env.BUILDINGS_PMTILES_FILE || 'buildings.pmtiles').trim() || 'buildings.pmtiles');
const BUILDINGS_PMTILES_SOURCE_LAYER = String(process.env.BUILDINGS_PMTILES_SOURCE_LAYER || 'buildings').trim() || 'buildings';

const dataDir = path.join(__dirname, 'data');
const dbPath = path.join(dataDir, 'archimap.db');
const buildingsPmtilesPath = path.join(dataDir, BUILDINGS_PMTILES_FILE);
const localEditsDbPath = process.env.LOCAL_EDITS_DB_PATH || path.join(dataDir, 'local-edits.db');
const db = new Database(dbPath);
const syncScriptPath = path.join(__dirname, 'scripts', 'sync-osm-buildings.js');
const searchRebuildScriptPath = path.join(__dirname, 'scripts', 'rebuild-search-index.js');
const filterTagKeysRebuildScriptPath = path.join(__dirname, 'scripts', 'rebuild-filter-tag-keys-cache.js');
let sessionMiddleware = null;

let syncInProgress = false;
let currentSyncChild = null;
let currentPmtilesBuildChild = null;
let currentSearchRebuildChild = null;
let currentFilterTagKeysRebuildChild = null;
let httpServer = null;
let shuttingDown = false;
let scheduledSkipLogged = false;
let nextSyncTimer = null;
let searchIndexRebuildInProgress = false;
let queuedSearchIndexRebuildReason = null;
const pendingSearchIndexRefreshes = new Set();
let filterTagKeysCache = { keys: null, loadedAt: 0 };
let filterTagKeysRebuildInProgress = false;
let queuedFilterTagKeysRebuildReason = null;

const MAX_NODE_TIMER_MS = 2_147_483_647;
const SEARCH_INDEX_BATCH_SIZE = Math.max(200, Math.min(20000, Number(process.env.SEARCH_INDEX_BATCH_SIZE || 2500)));

function normalizeMapConfig() {
  const lon = Number.isFinite(MAP_DEFAULT_LON) ? Math.min(180, Math.max(-180, MAP_DEFAULT_LON)) : 44.0059;
  const lat = Number.isFinite(MAP_DEFAULT_LAT) ? Math.min(90, Math.max(-90, MAP_DEFAULT_LAT)) : 56.3269;
  const zoom = Number.isFinite(MAP_DEFAULT_ZOOM) ? Math.min(22, Math.max(0, MAP_DEFAULT_ZOOM)) : 15;
  return { lon, lat, zoom };
}

function validateSecurityConfig() {
  const isProduction = NODE_ENV === 'production';
  const weakSessionSecret = SESSION_SECRET === 'dev-secret-change-me';
  const weakAdminPassword = ADMIN_PASSWORD === 'admin123';

  if (!isProduction) {
    if (weakSessionSecret) {
      console.warn('[security] SESSION_SECRET uses default value (allowed in non-production, unsafe for production)');
    }
    if (weakAdminPassword) {
      console.warn('[security] ADMIN_PASSWORD uses default value (allowed in non-production, unsafe for production)');
    }
    return;
  }

  if (weakSessionSecret || weakAdminPassword) {
    const issues = [];
    if (weakSessionSecret) issues.push('SESSION_SECRET is default');
    if (weakAdminPassword) issues.push('ADMIN_PASSWORD is default');
    throw new Error(`[security] Refusing to start in production: ${issues.join('; ')}`);
  }
}

function createSimpleRateLimiter({ windowMs, maxRequests, message }) {
  const buckets = new Map();

  const cleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [key, value] of buckets.entries()) {
      if (value.resetAt <= now) buckets.delete(key);
    }
  }, Math.max(1000, Math.floor(windowMs / 2)));
  if (typeof cleanupTimer.unref === 'function') {
    cleanupTimer.unref();
  }

  return (req, res, next) => {
    const key = `${req.ip || 'unknown'}:${req.path}`;
    const now = Date.now();
    let bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + windowMs };
      buckets.set(key, bucket);
    }

    bucket.count += 1;
    if (bucket.count > maxRequests) {
      const retryAfterSec = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
      res.setHeader('Retry-After', String(retryAfterSec));
      return res.status(429).json({ error: message || 'Слишком много запросов, попробуйте позже' });
    }

    return next();
  };
}

const loginRateLimiter = createSimpleRateLimiter({
  windowMs: 10 * 60 * 1000,
  maxRequests: 20,
  message: 'Слишком много попыток входа, попробуйте позже'
});

const searchRateLimiter = createSimpleRateLimiter({
  windowMs: 60 * 1000,
  maxRequests: 60,
  message: 'Слишком много поисковых запросов, попробуйте позже'
});

db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 5000');

db.prepare(`ATTACH DATABASE ? AS local`).run(localEditsDbPath);
db.exec(`PRAGMA local.journal_mode = WAL;`);
db.exec(`PRAGMA local.synchronous = NORMAL;`);

db.exec(`
CREATE TABLE IF NOT EXISTS architectural_info (
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
  updated_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(osm_type, osm_id)
);

CREATE TABLE IF NOT EXISTS building_contours (
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

CREATE INDEX IF NOT EXISTS idx_building_contours_bbox
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
`);

const rtreeState = {
  supported: false,
  ready: false,
  rebuilding: false
};
const RTREE_REBUILD_BATCH_SIZE = Math.max(500, Math.min(20000, Number(process.env.RTREE_REBUILD_BATCH_SIZE || 4000)));
const RTREE_REBUILD_PAUSE_MS = Math.max(0, Math.min(200, Number(process.env.RTREE_REBUILD_PAUSE_MS || 8)));

function ensureBuildingContoursRtreeSchema() {
  const compileOptions = db.prepare('PRAGMA compile_options').all();
  const hasRtreeSupport = compileOptions.some((row) => String(row?.compile_options || '').includes('ENABLE_RTREE'));
  if (!hasRtreeSupport) {
    console.warn('[db] SQLite R*Tree is not available (ENABLE_RTREE missing), bbox endpoint will use fallback query');
    rtreeState.supported = false;
    rtreeState.ready = false;
    return;
  }

  db.exec(`
CREATE VIRTUAL TABLE IF NOT EXISTS building_contours_rtree
USING rtree(
  contour_rowid,
  min_lon, max_lon,
  min_lat, max_lat
);

CREATE TRIGGER IF NOT EXISTS trg_building_contours_rtree_insert
AFTER INSERT ON building_contours
BEGIN
  INSERT OR REPLACE INTO building_contours_rtree (contour_rowid, min_lon, max_lon, min_lat, max_lat)
  VALUES (new.rowid, new.min_lon, new.max_lon, new.min_lat, new.max_lat);
END;

CREATE TRIGGER IF NOT EXISTS trg_building_contours_rtree_update
AFTER UPDATE OF min_lon, max_lon, min_lat, max_lat ON building_contours
BEGIN
  DELETE FROM building_contours_rtree WHERE contour_rowid = old.rowid;
  INSERT INTO building_contours_rtree (contour_rowid, min_lon, max_lon, min_lat, max_lat)
  VALUES (new.rowid, new.min_lon, new.max_lon, new.min_lat, new.max_lat);
END;

CREATE TRIGGER IF NOT EXISTS trg_building_contours_rtree_delete
AFTER DELETE ON building_contours
BEGIN
  DELETE FROM building_contours_rtree WHERE contour_rowid = old.rowid;
END;
`);
  rtreeState.supported = true;
}

function needsBuildingContoursRtreeRebuild() {
  if (!rtreeState.supported) return false;
  const contourCount = Number(db.prepare('SELECT COUNT(*) AS total FROM building_contours').get()?.total || 0);
  const rtreeCount = Number(db.prepare('SELECT COUNT(*) AS total FROM building_contours_rtree').get()?.total || 0);
  return contourCount !== rtreeCount;
}

function scheduleBuildingContoursRtreeRebuild(reason = 'startup') {
  if (!rtreeState.supported || rtreeState.ready || rtreeState.rebuilding) return;

  const waitForIdle = () => {
    if (syncInProgress) {
      console.log('[db] R*Tree rebuild postponed: sync is running');
      setTimeout(waitForIdle, 5000);
      return;
    }
    rebuildBuildingContoursRtreeInBackground(reason).catch((error) => {
      console.error(`[db] R*Tree rebuild failed: ${String(error.message || error)}`);
    });
  };

  setTimeout(waitForIdle, 0);
}

async function rebuildBuildingContoursRtreeInBackground(reason = 'startup') {
  if (!rtreeState.supported || rtreeState.rebuilding) return;
  rtreeState.rebuilding = true;
  rtreeState.ready = false;

  const total = Number(db.prepare('SELECT COUNT(*) AS total FROM building_contours').get()?.total || 0);
  console.log(`[db] R*Tree rebuild started (${reason}), total contours: ${total}`);

  const batchSize = RTREE_REBUILD_BATCH_SIZE;
  const readBatch = db.prepare(`
    SELECT rowid, min_lon, max_lon, min_lat, max_lat
    FROM building_contours
    WHERE rowid > ?
    ORDER BY rowid
    LIMIT ?
  `);
  const insertRow = db.prepare(`
    INSERT OR REPLACE INTO building_contours_rtree (contour_rowid, min_lon, max_lon, min_lat, max_lat)
    VALUES (?, ?, ?, ?, ?)
  `);
  const insertBatch = db.transaction((rows) => {
    for (const row of rows) {
      insertRow.run(row.rowid, row.min_lon, row.max_lon, row.min_lat, row.max_lat);
    }
  });

  try {
    db.exec('DELETE FROM building_contours_rtree;');
    if (total === 0) {
      rtreeState.ready = true;
      console.log('[db] R*Tree rebuild finished: no contours to index');
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
        console.log(`[db] R*Tree rebuild progress: ${inserted}/${total} (${percent.toFixed(1)}%)`);
        lastLoggedAt = now;
      }

      if (RTREE_REBUILD_PAUSE_MS > 0) {
        await new Promise((resolve) => setTimeout(resolve, RTREE_REBUILD_PAUSE_MS));
      } else {
        await new Promise((resolve) => setImmediate(resolve));
      }
    }

    const contourCount = Number(db.prepare('SELECT COUNT(*) AS total FROM building_contours').get()?.total || 0);
    const rtreeCount = Number(db.prepare('SELECT COUNT(*) AS total FROM building_contours_rtree').get()?.total || 0);
    if (contourCount !== rtreeCount) {
      console.warn('[db] R*Tree rebuild finished with drift, scheduling retry');
      setTimeout(() => scheduleBuildingContoursRtreeRebuild('retry'), 1000);
      return;
    }

    rtreeState.ready = true;
    console.log(`[db] R*Tree rebuild completed: ${inserted} rows indexed`);
  } catch (error) {
    rtreeState.ready = false;
    throw error;
  } finally {
    rtreeState.rebuilding = false;
  }
}

ensureBuildingContoursRtreeSchema();
rtreeState.ready = rtreeState.supported && !needsBuildingContoursRtreeRebuild();
if (rtreeState.supported) {
  const contourCount = Number(db.prepare('SELECT COUNT(*) AS total FROM building_contours').get()?.total || 0);
  const rtreeCount = Number(db.prepare('SELECT COUNT(*) AS total FROM building_contours_rtree').get()?.total || 0);
  console.log(`[db] R*Tree status at startup: ready=${rtreeState.ready}, contours=${contourCount}, rtree=${rtreeCount}`);
  if (!rtreeState.ready) {
    console.log('[db] R*Tree requires rebuild, bbox endpoint will use fallback query until ready');
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

`);

const legacyInfoStats = db.prepare(`
  SELECT
    (SELECT COUNT(*) FROM main.architectural_info) AS main_count,
    (SELECT COUNT(*) FROM local.architectural_info) AS local_count
`).get();
if (Number(legacyInfoStats?.local_count || 0) === 0 && Number(legacyInfoStats?.main_count || 0) > 0) {
  const inserted = db.prepare(`
    INSERT INTO local.architectural_info (osm_type, osm_id, name, style, levels, year_built, architect, address, description, archimap_description, updated_by, created_at, updated_at)
    SELECT
      ai.osm_type,
      ai.osm_id,
      ai.name,
      ai.style,
      ai.levels,
      ai.year_built,
      ai.architect,
      ai.address,
      ai.description,
      ai.description,
      ai.updated_by,
      coalesce(ai.created_at, datetime('now')),
      coalesce(ai.updated_at, datetime('now'))
    FROM main.architectural_info ai
  `).run();
  console.log(`[db] migrated ${Number(inserted?.changes || 0)} local edits to local-edits.db`);
}

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

const archiColumns = db.prepare(`PRAGMA local.table_info(architectural_info)`).all();
const archiColumnNames = new Set(archiColumns.map((c) => c.name));
if (!archiColumnNames.has('name')) {
  db.exec(`ALTER TABLE local.architectural_info ADD COLUMN name TEXT;`);
}
if (!archiColumnNames.has('levels')) {
  db.exec(`ALTER TABLE local.architectural_info ADD COLUMN levels INTEGER;`);
}
if (!archiColumnNames.has('updated_by')) {
  db.exec(`ALTER TABLE local.architectural_info ADD COLUMN updated_by TEXT;`);
}
if (!archiColumnNames.has('archimap_description')) {
  db.exec(`ALTER TABLE local.architectural_info ADD COLUMN archimap_description TEXT;`);
}
db.exec(`
UPDATE local.architectural_info
SET archimap_description = description
WHERE (archimap_description IS NULL OR trim(archimap_description) = '')
  AND description IS NOT NULL
  AND trim(description) <> '';
`);

const searchSourceColumns = db.prepare(`PRAGMA table_info(building_search_source)`).all();
const searchSourceColumnNames = new Set(searchSourceColumns.map((c) => c.name));
if (!searchSourceColumnNames.has('local_priority')) {
  db.exec(`ALTER TABLE building_search_source ADD COLUMN local_priority INTEGER NOT NULL DEFAULT 0;`);
}

app.use(express.json());

app.get('/app-config.js', (req, res) => {
  const mapDefault = normalizeMapConfig();
  const buildingsPmtiles = {
    url: '/api/buildings.pmtiles',
    sourceLayer: BUILDINGS_PMTILES_SOURCE_LAYER
  };
  res.type('application/javascript').send(
    `window.__ARCHIMAP_CONFIG = ${JSON.stringify({ mapDefault, buildingsPmtiles })};`
  );
});

app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/buildings.pmtiles', (req, res) => {
  res.setHeader('Cache-Control', 'public, max-age=300');
  return res.sendFile(buildingsPmtilesPath, (error) => {
    if (!error) return;
    if (error.code === 'ENOENT') {
      if (!res.headersSent) {
        res.status(404).json({ error: 'Файл PMTiles не найден. Выполните sync для генерации tileset.' });
      }
      return;
    }
    if (!res.headersSent) {
      res.status(500).json({ error: 'Не удалось отдать PMTiles файл' });
    }
  });
});

const selectFilterTagKeysFromCache = db.prepare(`
  SELECT tag_key
  FROM filter_tag_keys_cache
  ORDER BY tag_key COLLATE NOCASE
`);

function scheduleFilterTagKeysCacheRebuild(reason = 'manual') {
  if (filterTagKeysRebuildInProgress) {
    queuedFilterTagKeysRebuildReason = reason;
    return;
  }

  filterTagKeysRebuildInProgress = true;
  console.log(`[filter-tags] cache rebuild worker started (${reason})`);
  const child = spawn(process.execPath, [filterTagKeysRebuildScriptPath], {
    cwd: __dirname,
    env: {
      ...process.env,
      ARCHIMAP_DB_PATH: dbPath,
      FILTER_TAG_KEYS_REBUILD_REASON: reason
    },
    stdio: 'inherit'
  });
  currentFilterTagKeysRebuildChild = child;

  child.on('error', (error) => {
    currentFilterTagKeysRebuildChild = null;
    filterTagKeysRebuildInProgress = false;
    console.error(`[filter-tags] rebuild worker failed to start: ${String(error.message || error)}`);
    if (queuedFilterTagKeysRebuildReason) {
      const nextReason = queuedFilterTagKeysRebuildReason;
      queuedFilterTagKeysRebuildReason = null;
      scheduleFilterTagKeysCacheRebuild(nextReason);
    }
  });

  child.on('close', (code, signal) => {
    currentFilterTagKeysRebuildChild = null;
    filterTagKeysRebuildInProgress = false;
    if (shuttingDown && (signal === 'SIGTERM' || signal === 'SIGINT')) {
      console.log('[filter-tags] rebuild worker stopped due to shutdown');
      return;
    }
    if (code === 0) {
      filterTagKeysCache = { keys: null, loadedAt: 0 };
      console.log('[filter-tags] cache rebuild worker finished successfully');
    } else {
      console.error(`[filter-tags] rebuild worker failed with code ${code}`);
    }
    if (queuedFilterTagKeysRebuildReason) {
      const nextReason = queuedFilterTagKeysRebuildReason;
      queuedFilterTagKeysRebuildReason = null;
      scheduleFilterTagKeysCacheRebuild(nextReason);
    }
  });
}

function getFilterTagKeysCached() {
  const now = Date.now();
  const ttlMs = 5 * 60 * 1000;
  if (Array.isArray(filterTagKeysCache.keys) && (now - filterTagKeysCache.loadedAt) < ttlMs) {
    return filterTagKeysCache.keys;
  }
  const cachedKeys = selectFilterTagKeysFromCache
    .all()
    .map((row) => String(row?.tag_key || '').trim())
    .filter(Boolean);

  if (cachedKeys.length > 0) {
    filterTagKeysCache = { keys: cachedKeys, loadedAt: now };
    return cachedKeys;
  }

  if (!filterTagKeysRebuildInProgress) {
    scheduleFilterTagKeysCacheRebuild('cold-start');
  }
  filterTagKeysCache = { keys: [], loadedAt: now };
  return [];
}

app.get('/api/filter-tag-keys', (req, res) => {
  try {
    const keys = getFilterTagKeysCached();
    res.json({
      keys,
      warmingUp: filterTagKeysRebuildInProgress || keys.length === 0
    });
  } catch (error) {
    res.status(500).json({ error: 'Не удалось получить список ключей OSM тегов' });
  }
});

app.use((req, res, next) => {
  if (!sessionMiddleware) {
    return res.status(503).json({ error: 'Сервис инициализируется, попробуйте ещё раз' });
  }
  return sessionMiddleware(req, res, next);
});

function rowToFeature(row) {
  let ring = [];
  let geometry = null;
  let tags = {};
  try {
    const parsed = JSON.parse(row.geometry_json);
    if (parsed && typeof parsed === 'object' && parsed.type && Array.isArray(parsed.coordinates)) {
      geometry = parsed;
    } else if (Array.isArray(parsed)) {
      ring = parsed;
      geometry = { type: 'Polygon', coordinates: [ring] };
    }
  } catch {
    ring = [];
    geometry = { type: 'Polygon', coordinates: [ring] };
  }
  try {
    tags = row.tags_json ? JSON.parse(row.tags_json) : {};
  } catch {
    tags = {};
  }

  return {
    type: 'Feature',
    id: `${row.osm_type}/${row.osm_id}`,
    properties: { ...tags, source_tags: tags },
    geometry: geometry || { type: 'Polygon', coordinates: [ring] }
  };
}

function attachInfoToFeatures(features) {
  const keys = features
    .map((f) => String(f.id || ''))
    .filter((id) => /^(way|relation)\/\d+$/.test(id));

  if (keys.length === 0) return features;

  const infoByKey = new Map();
  const CHUNK_SIZE = 300;
  for (let i = 0; i < keys.length; i += CHUNK_SIZE) {
    const chunk = keys.slice(i, i + CHUNK_SIZE);
    const clauses = chunk.map(() => '(osm_type = ? AND osm_id = ?)').join(' OR ');
    const params = [];
    for (const key of chunk) {
      const [type, id] = key.split('/');
      params.push(type, Number(id));
    }
    const rows = db.prepare(`
      SELECT osm_type, osm_id, name, style, levels, year_built, architect, address, description, archimap_description, updated_by, updated_at
      FROM local.architectural_info
      WHERE ${clauses}
    `).all(...params);
    for (const row of rows) {
      infoByKey.set(`${row.osm_type}/${row.osm_id}`, row);
    }
  }

  for (const feature of features) {
    const key = String(feature.id || '');
    feature.properties = feature.properties || {};
    if (!feature.properties.source_tags || typeof feature.properties.source_tags !== 'object') {
      const clone = { ...feature.properties };
      delete clone.osm_key;
      delete clone.archiInfo;
      delete clone.hasExtraInfo;
      feature.properties.source_tags = clone;
    }
    feature.properties.osm_key = key;
    feature.properties.archiInfo = infoByKey.get(key) || null;
    feature.properties.hasExtraInfo = infoByKey.has(key);
  }

  return features;
}

function parseOsmKey(value) {
  const text = String(value || '').trim();
  const match = text.match(/^(way|relation)\/(\d+)$/);
  if (!match) return null;
  const osmId = Number(match[2]);
  if (!Number.isInteger(osmId)) return null;
  return { osmType: match[1], osmId };
}

function mapFilterDataRow(row) {
  const osmKey = `${row.osm_type}/${row.osm_id}`;
  let sourceTags = {};
  try {
    sourceTags = row.tags_json ? JSON.parse(row.tags_json) : {};
  } catch {
    sourceTags = {};
  }
  const hasExtraInfo = row.info_osm_id != null;
  return {
    osmKey,
    sourceTags,
    archiInfo: hasExtraInfo
      ? {
        osm_type: row.osm_type,
        osm_id: row.osm_id,
        name: row.name,
        style: row.style,
        levels: row.levels,
        year_built: row.year_built,
        architect: row.architect,
        address: row.address,
        description: row.description,
        archimap_description: row.archimap_description || row.description || null,
        updated_by: row.updated_by,
        updated_at: row.updated_at
      }
      : null,
    hasExtraInfo
  };
}

const FILTER_DATA_SELECT_FIELDS_SQL = `
  SELECT
    bc.osm_type,
    bc.osm_id,
    bc.tags_json,
    ai.osm_id AS info_osm_id,
    ai.name,
    ai.style,
    ai.levels,
    ai.year_built,
    ai.architect,
    ai.address,
    ai.description,
    ai.archimap_description,
    ai.updated_by,
    ai.updated_at
  FROM building_contours bc
  LEFT JOIN local.architectural_info ai
    ON ai.osm_type = bc.osm_type AND ai.osm_id = bc.osm_id
`;

app.post('/api/buildings/filter-data', (req, res) => {
  const rawKeys = Array.isArray(req.body?.keys) ? req.body.keys : [];
  if (!Array.isArray(rawKeys)) {
    return res.status(400).json({ error: 'Ожидается массив keys' });
  }

  const unique = [];
  const seen = new Set();
  for (const raw of rawKeys) {
    const parsed = parseOsmKey(raw);
    if (!parsed) continue;
    const key = `${parsed.osmType}/${parsed.osmId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(parsed);
    if (unique.length >= 5000) break;
  }

  if (unique.length === 0) {
    return res.json({ items: [] });
  }

  const outByKey = new Map();
  const CHUNK_SIZE = 300;
  for (let i = 0; i < unique.length; i += CHUNK_SIZE) {
    const chunk = unique.slice(i, i + CHUNK_SIZE);
    const clauses = chunk.map(() => '(bc.osm_type = ? AND bc.osm_id = ?)').join(' OR ');
    const params = [];
    for (const item of chunk) {
      params.push(item.osmType, item.osmId);
    }
    const rows = db.prepare(`
      ${FILTER_DATA_SELECT_FIELDS_SQL}
      WHERE ${clauses}
    `).all(...params);

    for (const row of rows) {
      const item = mapFilterDataRow(row);
      outByKey.set(item.osmKey, item);
    }
  }

  return res.json({ items: [...outByKey.values()] });
});

app.get('/api/buildings/filter-data-bbox', (req, res) => {
  const minLon = Number(req.query.minLon);
  const minLat = Number(req.query.minLat);
  const maxLon = Number(req.query.maxLon);
  const maxLat = Number(req.query.maxLat);
  const limit = Math.max(1, Math.min(50000, Number(req.query.limit) || 12000));
  if (![minLon, minLat, maxLon, maxLat].every(Number.isFinite)) {
    return res.status(400).json({ error: 'Некорректные координаты bbox' });
  }
  if (minLon > maxLon || minLat > maxLat) {
    return res.status(400).json({ error: 'Некорректные границы bbox' });
  }

  const rows = rtreeState.ready
    ? db.prepare(`
      SELECT
        bc.osm_type,
        bc.osm_id,
        bc.tags_json,
        ai.osm_id AS info_osm_id,
        ai.name,
        ai.style,
        ai.levels,
        ai.year_built,
        ai.architect,
        ai.address,
        ai.description,
        ai.archimap_description,
        ai.updated_by,
        ai.updated_at
      FROM building_contours_rtree br
      JOIN building_contours bc
        ON bc.rowid = br.contour_rowid
      LEFT JOIN local.architectural_info ai
        ON ai.osm_type = bc.osm_type AND ai.osm_id = bc.osm_id
      WHERE br.max_lon >= ?
        AND br.min_lon <= ?
        AND br.max_lat >= ?
        AND br.min_lat <= ?
      LIMIT ?
    `).all(minLon, maxLon, minLat, maxLat, limit)
    : db.prepare(`
      ${FILTER_DATA_SELECT_FIELDS_SQL}
      WHERE bc.max_lon >= ?
        AND bc.min_lon <= ?
        AND bc.max_lat >= ?
        AND bc.min_lat <= ?
      LIMIT ?
    `).all(minLon, maxLon, minLat, maxLat, limit);

  const items = rows.map(mapFilterDataRow);
  res.setHeader('Cache-Control', 'public, max-age=60');
  return res.json({ items, truncated: rows.length >= limit });
});

function requireAuth(req, res, next) {
  if (!req.session || !req.session.user) {
    return res.status(401).json({ error: 'Требуется авторизация' });
  }
  next();
}

function isAdminRequest(req) {
  const username = String(req.session?.user?.username || '');
  return Boolean(username) && username === ADMIN_USERNAME;
}

function requireAdmin(req, res, next) {
  if (!isAdminRequest(req)) {
    return res.status(403).json({ error: 'Требуются права администратора' });
  }
  next();
}

function normalizeTagValue(value) {
  if (value == null) return null;
  if (typeof value === 'string') {
    const text = value.trim();
    return text ? text : null;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function osmAddressFromTags(tags) {
  if (!tags || typeof tags !== 'object') return null;
  if (tags['addr:full']) return normalizeTagValue(tags['addr:full']);
  const parts = [
    tags['addr:postcode'] || tags.addr_postcode,
    tags['addr:city'] || tags.addr_city,
    tags['addr:street'] || tags.addr_street || tags.addr_stree,
    tags['addr:housenumber'] || tags.addr_housenumber || tags.addr_hous
  ]
    .map(normalizeTagValue)
    .filter(Boolean);
  return parts.length > 0 ? parts.join(', ') : null;
}

function parseIntegerMaybe(value) {
  if (value == null) return null;
  const text = String(value).trim();
  if (!text) return null;
  const parsed = Number(text);
  if (!Number.isFinite(parsed)) return null;
  const intValue = Math.trunc(parsed);
  return Number.isInteger(intValue) ? intValue : null;
}

function getOsmBaselineFromTags(tags) {
  return {
    name: normalizeTagValue(tags?.name || tags?.['name:ru'] || tags?.official_name || null),
    style: normalizeTagValue(tags?.['building:architecture'] || tags?.architecture || tags?.style || null),
    levels: parseIntegerMaybe(tags?.['building:levels'] || tags?.levels || null),
    year_built: parseIntegerMaybe(tags?.['building:year'] || tags?.start_date || tags?.construction_date || tags?.year_built || null),
    architect: normalizeTagValue(tags?.architect || tags?.architect_name || null),
    address: osmAddressFromTags(tags),
    description: normalizeTagValue(tags?.['description:ru'] || tags?.description || null),
    archimap_description: null
  };
}

function normalizeInfoForDiff(value) {
  if (value == null) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const text = String(value).trim();
  return text ? text : null;
}

function buildChangesFromRows(localRow, tags) {
  const baseline = getOsmBaselineFromTags(tags || {});
  const fields = [
    { key: 'name', label: 'Название', osmTag: 'name | name:ru | official_name' },
    { key: 'address', label: 'Адрес', osmTag: 'addr:full | addr:* (city/street/housenumber/postcode)' },
    { key: 'levels', label: 'Этажей', osmTag: 'building:levels | levels' },
    { key: 'year_built', label: 'Год постройки', osmTag: 'building:year | start_date | construction_date | year_built' },
    { key: 'architect', label: 'Архитектор', osmTag: 'architect | architect_name' },
    { key: 'style', label: 'Архитектурный стиль', osmTag: 'building:architecture | architecture | style' },
    { key: 'archimap_description', label: 'Доп. информация', osmTag: null }
  ];

  const changes = [];
  for (const field of fields) {
    const osmValue = normalizeInfoForDiff(baseline[field.key]);
    const localValue = normalizeInfoForDiff(localRow[field.key]);
    if (localValue == null) continue;
    if (osmValue === localValue) continue;
    changes.push({
      field: field.key,
      label: field.label,
      osmTag: field.osmTag,
      isLocalTag: !field.osmTag,
      osmValue,
      localValue
    });
  }
  return changes;
}

function normalizeSearchTokens(queryText) {
  return [...new Set(
    String(queryText || '')
      .trim()
      .split(/\s+/)
      .map((t) => t.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ''))
      .filter(Boolean)
  )].slice(0, 8);
}

function buildFtsMatchQuery(tokens) {
  return tokens
    .map((t) => {
      const safe = t.replace(/"/g, '""');
      return `"${safe}"*`;
    })
    .join(' AND ');
}

function getSearchIndexCountsSnapshot() {
  return db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM building_contours) AS contours_count,
      (SELECT COUNT(*) FROM building_search_source) AS search_source_count,
      (SELECT COUNT(*) FROM building_search_fts) AS search_fts_count
  `).get();
}

function getSearchRebuildDecision() {
  const countsSnapshot = getSearchIndexCountsSnapshot();
  const expectedSourceRows = Number(countsSnapshot?.contours_count || 0);
  const actualSourceRows = Number(countsSnapshot?.search_source_count || 0);
  const actualFtsRows = Number(countsSnapshot?.search_fts_count || 0);

  const sourceMismatch = actualSourceRows !== expectedSourceRows;
  const ftsMismatch = actualFtsRows !== actualSourceRows;

  if (sourceMismatch || ftsMismatch) {
    const reasons = [];
    if (sourceMismatch) reasons.push(`source ${actualSourceRows}/${expectedSourceRows}`);
    if (ftsMismatch) reasons.push(`fts ${actualFtsRows}/${actualSourceRows}`);
    return {
      shouldRebuild: true,
      reason: reasons.join(', ')
    };
  }

  return {
    shouldRebuild: false,
    reason: 'search index row counts are consistent'
  };
}

function flushDeferredSearchRefreshes() {
  if (pendingSearchIndexRefreshes.size === 0) return;
  const pending = Array.from(pendingSearchIndexRefreshes);
  pendingSearchIndexRefreshes.clear();
  console.log(`[search] applying deferred building refreshes: ${pending.length}`);
  for (const key of pending) {
    const [osmType, osmIdRaw] = String(key).split('/');
    const osmId = Number(osmIdRaw);
    if (['way', 'relation'].includes(osmType) && Number.isInteger(osmId)) {
      refreshSearchIndexForBuilding(osmType, osmId, { force: true });
    }
  }
}

function maybeRunQueuedSearchRebuild() {
  if (!queuedSearchIndexRebuildReason) return;
  const nextReason = queuedSearchIndexRebuildReason;
  queuedSearchIndexRebuildReason = null;
  rebuildSearchIndex(nextReason);
}

function enqueueSearchIndexRefresh(osmType, osmId) {
  setImmediate(() => {
    try {
      refreshSearchIndexForBuilding(osmType, osmId);
    } catch (error) {
      console.error(`[search] incremental refresh failed for ${osmType}/${osmId}: ${String(error.message || error)}`);
    }
  });
}

function rebuildSearchIndex(reason = 'manual', options = {}) {
  const force = Boolean(options.force);
  if (searchIndexRebuildInProgress) {
    queuedSearchIndexRebuildReason = reason;
    console.log(`[search] rebuild already running; queued next rebuild (${reason})`);
    return;
  }

  if (!force) {
    const decision = getSearchRebuildDecision();
    if (!decision.shouldRebuild) {
      console.log(`[search] rebuild skipped (${reason}): ${decision.reason}`);
      return;
    }
    console.log(`[search] rebuild required (${reason}): ${decision.reason}`);
  }

  const startedAt = Date.now();
  searchIndexRebuildInProgress = true;
  console.log(`[search] rebuild worker started (${reason}), batch size: ${SEARCH_INDEX_BATCH_SIZE}`);

  const child = spawn(process.execPath, [searchRebuildScriptPath], {
    cwd: __dirname,
    env: {
      ...process.env,
      SEARCH_REBUILD_REASON: reason,
      SEARCH_INDEX_BATCH_SIZE: String(SEARCH_INDEX_BATCH_SIZE),
      LOCAL_EDITS_DB_PATH: localEditsDbPath
    },
    stdio: 'inherit'
  });
  currentSearchRebuildChild = child;

  child.on('error', (error) => {
    currentSearchRebuildChild = null;
    searchIndexRebuildInProgress = false;
    console.error(`[search] rebuild worker failed to start: ${String(error.message || error)}`);
    flushDeferredSearchRefreshes();
    maybeRunQueuedSearchRebuild();
  });

  child.on('close', (code, signal) => {
    currentSearchRebuildChild = null;
    searchIndexRebuildInProgress = false;

    if (shuttingDown && (signal === 'SIGTERM' || signal === 'SIGINT')) {
      console.log('[search] rebuild worker stopped due to shutdown');
      return;
    }
    if (code === 0) {
      console.log(`[search] index rebuilt in worker in ${Date.now() - startedAt}ms`);
    } else {
      console.error(`[search] rebuild worker failed with code ${code}`);
    }

    flushDeferredSearchRefreshes();
    maybeRunQueuedSearchRebuild();
  });
}

function refreshSearchIndexForBuilding(osmType, osmId, options = {}) {
  const force = Boolean(options.force);
  if (!force && searchIndexRebuildInProgress) {
    pendingSearchIndexRefreshes.add(`${osmType}/${osmId}`);
    return;
  }
  const row = db.prepare(`
    SELECT
      bc.osm_type || '/' || bc.osm_id AS osm_key,
      bc.osm_type AS osm_type,
      bc.osm_id AS osm_id,
      NULLIF(trim(coalesce(ai.name,
        json_extract(CASE WHEN json_valid(bc.tags_json) THEN bc.tags_json ELSE '{}' END, '$.name'),
        json_extract(CASE WHEN json_valid(bc.tags_json) THEN bc.tags_json ELSE '{}' END, '$."name:ru"'),
        json_extract(CASE WHEN json_valid(bc.tags_json) THEN bc.tags_json ELSE '{}' END, '$.official_name'),
        ''
      )), '') AS name,
      NULLIF(trim(replace(replace(replace(coalesce(ai.address,
        json_extract(CASE WHEN json_valid(bc.tags_json) THEN bc.tags_json ELSE '{}' END, '$."addr:full"'),
        trim(
          coalesce(json_extract(CASE WHEN json_valid(bc.tags_json) THEN bc.tags_json ELSE '{}' END, '$."addr:postcode"') || ', ', '') ||
          coalesce(json_extract(CASE WHEN json_valid(bc.tags_json) THEN bc.tags_json ELSE '{}' END, '$."addr:city"') || ', ', '') ||
          coalesce(json_extract(CASE WHEN json_valid(bc.tags_json) THEN bc.tags_json ELSE '{}' END, '$."addr:place"') || ', ', '') ||
          coalesce(json_extract(CASE WHEN json_valid(bc.tags_json) THEN bc.tags_json ELSE '{}' END, '$."addr:street"'), '') ||
          CASE
            WHEN json_extract(CASE WHEN json_valid(bc.tags_json) THEN bc.tags_json ELSE '{}' END, '$."addr:housenumber"') IS NOT NULL
              AND trim(json_extract(CASE WHEN json_valid(bc.tags_json) THEN bc.tags_json ELSE '{}' END, '$."addr:housenumber"')) <> ''
            THEN ', ' || json_extract(CASE WHEN json_valid(bc.tags_json) THEN bc.tags_json ELSE '{}' END, '$."addr:housenumber"')
            ELSE ''
          END
        )
      ), ', ,', ','), ',,', ','), '  ', ' ')), '') AS address,
      NULLIF(trim(coalesce(ai.style,
        json_extract(CASE WHEN json_valid(bc.tags_json) THEN bc.tags_json ELSE '{}' END, '$."building:architecture"'),
        json_extract(CASE WHEN json_valid(bc.tags_json) THEN bc.tags_json ELSE '{}' END, '$.architecture'),
        json_extract(CASE WHEN json_valid(bc.tags_json) THEN bc.tags_json ELSE '{}' END, '$.style'),
        ''
      )), '') AS style,
      NULLIF(trim(coalesce(ai.architect,
        json_extract(CASE WHEN json_valid(bc.tags_json) THEN bc.tags_json ELSE '{}' END, '$.architect'),
        json_extract(CASE WHEN json_valid(bc.tags_json) THEN bc.tags_json ELSE '{}' END, '$.architect_name'),
        ''
      )), '') AS architect,
      CASE WHEN ai.osm_id IS NOT NULL THEN 1 ELSE 0 END AS local_priority,
      (bc.min_lon + bc.max_lon) / 2.0 AS center_lon,
      (bc.min_lat + bc.max_lat) / 2.0 AS center_lat
    FROM building_contours bc
    LEFT JOIN local.architectural_info ai
      ON ai.osm_type = bc.osm_type AND ai.osm_id = bc.osm_id
    WHERE bc.osm_type = ? AND bc.osm_id = ?
  `).get(osmType, osmId);

  const osmKey = `${osmType}/${osmId}`;
  if (!row) {
    db.prepare(`DELETE FROM building_search_source WHERE osm_key = ?`).run(osmKey);
    db.prepare(`DELETE FROM building_search_fts WHERE osm_key = ?`).run(osmKey);
    return;
  }

  db.prepare(`
    INSERT INTO building_search_source (osm_key, osm_type, osm_id, name, address, style, architect, local_priority, center_lon, center_lat, updated_at)
    VALUES (@osm_key, @osm_type, @osm_id, @name, @address, @style, @architect, @local_priority, @center_lon, @center_lat, datetime('now'))
    ON CONFLICT(osm_key) DO UPDATE SET
      name = excluded.name,
      address = excluded.address,
      style = excluded.style,
      architect = excluded.architect,
      local_priority = excluded.local_priority,
      center_lon = excluded.center_lon,
      center_lat = excluded.center_lat,
      updated_at = datetime('now')
  `).run(row);

  db.prepare(`DELETE FROM building_search_fts WHERE osm_key = ?`).run(row.osm_key);
  db.prepare(`
    INSERT INTO building_search_fts (osm_key, name, address, style, architect)
    VALUES (?, ?, ?, ?, ?)
  `).run(row.osm_key, row.name || '', row.address || '', row.style || '', row.architect || '');
}

function getBuildingSearchResults(queryText, centerLon, centerLat, limit = 30, cursor = 0) {
  const tokens = normalizeSearchTokens(queryText);
  if (tokens.length === 0) {
    return { items: [], nextCursor: null, hasMore: false };
  }

  if (searchIndexRebuildInProgress) {
    return getLocalEditsSearchResults(tokens, centerLon, centerLat, limit, cursor);
  }

  const matchQuery = buildFtsMatchQuery(tokens);
  const cappedLimit = Math.max(1, Math.min(60, Number(limit) || 30));
  const offset = Math.max(0, Math.min(10000, Number(cursor) || 0));
  const lon = Number.isFinite(centerLon) ? centerLon : 44.0059;
  const lat = Number.isFinite(centerLat) ? centerLat : 56.3269;

  const rows = db.prepare(`
    WITH matched AS (
      SELECT osm_key, bm25(building_search_fts) AS rank
      FROM building_search_fts
      WHERE building_search_fts MATCH ?
    )
    SELECT
      s.osm_type,
      s.osm_id,
      s.name,
      s.address,
      s.style,
      s.architect,
      s.center_lon,
      s.center_lat,
      s.local_priority,
      m.rank,
      ((s.center_lon - ?) * (s.center_lon - ?) + (s.center_lat - ?) * (s.center_lat - ?)) AS distance2
    FROM matched m
    JOIN building_search_source s ON s.osm_key = m.osm_key
    ORDER BY s.local_priority DESC, m.rank ASC, distance2 ASC, s.osm_type ASC, s.osm_id ASC
    LIMIT ? OFFSET ?
  `).all(matchQuery, lon, lon, lat, lat, cappedLimit + 1, offset);

  const hasMore = rows.length > cappedLimit;
  const sliced = hasMore ? rows.slice(0, cappedLimit) : rows;
  const nextCursor = hasMore ? offset + cappedLimit : null;

  return {
    items: sliced.map((row) => ({
      osmType: row.osm_type,
      osmId: row.osm_id,
      name: row.name || null,
      address: row.address || null,
      style: row.style || null,
      architect: row.architect || null,
      lon: Number.isFinite(Number(row.center_lon)) ? Number(row.center_lon) : null,
      lat: Number.isFinite(Number(row.center_lat)) ? Number(row.center_lat) : null,
      score: Number(row.rank || 0)
    })),
    nextCursor,
    hasMore
  };
}

function getLocalEditsSearchResults(tokens, centerLon, centerLat, limit = 30, cursor = 0) {
  const cappedLimit = Math.max(1, Math.min(60, Number(limit) || 30));
  const offset = Math.max(0, Math.min(10000, Number(cursor) || 0));
  const lon = Number.isFinite(centerLon) ? centerLon : 44.0059;
  const lat = Number.isFinite(centerLat) ? centerLat : 56.3269;

  const whereTokenClauses = [];
  const whereParams = [];
  for (const token of tokens) {
    const pattern = `%${token}%`;
    whereTokenClauses.push(`(
      coalesce(ai.name, '') LIKE ? OR
      coalesce(ai.address, '') LIKE ? OR
      coalesce(ai.style, '') LIKE ? OR
      coalesce(ai.architect, '') LIKE ?
    )`);
    whereParams.push(pattern, pattern, pattern, pattern);
  }

  const whereSql = whereTokenClauses.length > 0 ? whereTokenClauses.join(' AND ') : '1=1';
  const rows = db.prepare(`
    WITH src AS (
      SELECT
        ai.osm_type,
        ai.osm_id,
        ai.name,
        ai.address,
        ai.style,
        ai.architect,
        ai.updated_at,
        ((bc.min_lon + bc.max_lon) / 2.0) AS center_lon,
        ((bc.min_lat + bc.max_lat) / 2.0) AS center_lat
      FROM local.architectural_info ai
      LEFT JOIN building_contours bc
        ON bc.osm_type = ai.osm_type AND bc.osm_id = ai.osm_id
      WHERE bc.osm_id IS NOT NULL AND (${whereSql})
    )
    SELECT
      osm_type,
      osm_id,
      name,
      address,
      style,
      architect,
      center_lon,
      center_lat,
      ((center_lon - ?) * (center_lon - ?) + (center_lat - ?) * (center_lat - ?)) AS distance2
    FROM src
    ORDER BY distance2 ASC, updated_at DESC
    LIMIT ? OFFSET ?
  `).all(...whereParams, lon, lon, lat, lat, cappedLimit + 1, offset);

  const hasMore = rows.length > cappedLimit;
  const sliced = hasMore ? rows.slice(0, cappedLimit) : rows;
  const nextCursor = hasMore ? offset + cappedLimit : null;
  return {
    items: sliced.map((row) => ({
      osmType: row.osm_type,
      osmId: row.osm_id,
      name: row.name || null,
      address: row.address || null,
      style: row.style || null,
      architect: row.architect || null,
      lon: Number.isFinite(Number(row.center_lon)) ? Number(row.center_lon) : null,
      lat: Number.isFinite(Number(row.center_lat)) ? Number(row.center_lat) : null,
      score: 0
    })),
    nextCursor,
    hasMore
  };
}

app.get('/api/me', (req, res) => {
  const authenticated = Boolean(req.session && req.session.user);
  const user = authenticated
    ? {
      ...req.session.user,
      isAdmin: isAdminRequest(req)
    }
    : null;
  res.json({ authenticated, user });
});

app.post('/api/login', loginRateLimiter, (req, res) => {
  const { username, password } = req.body || {};
  if (username === ADMIN_USERNAME && password === ADMIN_PASSWORD) {
    req.session.user = { username, isAdmin: true };
    return res.json({ ok: true, user: req.session.user });
  }
  return res.status(401).json({ error: 'Неверный логин или пароль' });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => {
    res.json({ ok: true });
  });
});

app.get('/api/building-info/:osmType/:osmId', (req, res) => {
  const osmType = req.params.osmType;
  const osmId = Number(req.params.osmId);
  if (!['way', 'relation'].includes(osmType) || !Number.isInteger(osmId)) {
    return res.status(400).json({ error: 'Некорректный идентификатор здания' });
  }

  const row = db.prepare(`
    SELECT osm_type, osm_id, name, style, levels, year_built, architect, address, description, archimap_description, updated_by, updated_at
    FROM local.architectural_info
    WHERE osm_type = ? AND osm_id = ?
  `).get(osmType, osmId);

  if (!row) {
    return res.status(404).json({ error: 'Информация не найдена' });
  }

  return res.json(row);
});

app.post('/api/building-info', requireAuth, (req, res) => {
  const body = req.body || {};
  const osmType = body.osmType;
  const osmId = Number(body.osmId);

  if (!['way', 'relation'].includes(osmType) || !Number.isInteger(osmId)) {
    return res.status(400).json({ error: 'Некорректный идентификатор здания' });
  }

  const cleanText = (value, maxLen = 500) => {
    if (value == null) return null;
    const text = String(value).trim();
    if (!text) return null;
    return text.slice(0, maxLen);
  };

  const yearRaw = body.yearBuilt;
  let yearBuilt = null;
  if (yearRaw !== null && yearRaw !== undefined && String(yearRaw).trim() !== '') {
    const parsed = Number(yearRaw);
    if (!Number.isInteger(parsed) || parsed < 1000 || parsed > 2100) {
      return res.status(400).json({ error: 'Год постройки должен быть целым числом от 1000 до 2100' });
    }
    yearBuilt = parsed;
  }

  const levelsRaw = body.levels;
  let levels = null;
  if (levelsRaw !== null && levelsRaw !== undefined && String(levelsRaw).trim() !== '') {
    const parsed = Number(levelsRaw);
    if (!Number.isInteger(parsed) || parsed < 0 || parsed > 300) {
      return res.status(400).json({ error: 'Этажность должна быть целым числом от 0 до 300' });
    }
    levels = parsed;
  }

  const upsert = db.prepare(`
    INSERT INTO local.architectural_info (osm_type, osm_id, name, style, levels, year_built, architect, address, archimap_description, updated_by, updated_at)
    VALUES (@osm_type, @osm_id, @name, @style, @levels, @year_built, @architect, @address, @archimap_description, @updated_by, datetime('now'))
    ON CONFLICT(osm_type, osm_id) DO UPDATE SET
      name = excluded.name,
      style = excluded.style,
      levels = excluded.levels,
      year_built = excluded.year_built,
      architect = excluded.architect,
      address = excluded.address,
      archimap_description = excluded.archimap_description,
      updated_by = excluded.updated_by,
      updated_at = datetime('now');
  `);

  upsert.run({
    osm_type: osmType,
    osm_id: osmId,
    name: cleanText(body.name, 250),
    style: cleanText(body.style, 200),
    levels,
    year_built: yearBuilt,
    architect: cleanText(body.architect, 200),
    address: cleanText(body.address, 300),
    archimap_description: cleanText(body.archimapDescription ?? body.description, 1000),
    updated_by: String(req.session?.user?.username || '')
  });
  enqueueSearchIndexRefresh(osmType, osmId);

  return res.json({ ok: true });
});

app.get('/api/building/:osmType/:osmId', (req, res) => {
  const osmType = req.params.osmType;
  const osmId = Number(req.params.osmId);
  if (!['way', 'relation'].includes(osmType) || !Number.isInteger(osmId)) {
    return res.status(400).json({ error: 'Некорректный идентификатор здания' });
  }

  const row = db.prepare(`
    SELECT osm_type, osm_id, tags_json, geometry_json
    FROM building_contours
    WHERE osm_type = ? AND osm_id = ?
  `).get(osmType, osmId);

  if (!row) {
    return res.status(404).json({ error: 'Здание не найдено в локальной базе контуров' });
  }

  const feature = rowToFeature(row);
  attachInfoToFeatures([feature]);
  return res.json(feature);
});

app.get('/api/search-buildings', searchRateLimiter, (req, res) => {
  const q = String(req.query.q || '').trim();
  if (q.length < 2) {
    return res.status(400).json({ error: 'Минимальная длина запроса: 2 символа' });
  }
  if (q.length > 120) {
    return res.status(400).json({ error: 'Максимальная длина запроса: 120 символов' });
  }

  const lon = Number(req.query.lon);
  const lat = Number(req.query.lat);
  const limit = Number(req.query.limit || 30);
  const cursor = Number(req.query.cursor || 0);
  if (!Number.isFinite(cursor) || cursor < 0) {
    return res.status(400).json({ error: 'Некорректный cursor' });
  }

  const result = getBuildingSearchResults(q, lon, lat, limit, cursor);
  return res.json({
    items: result.items,
    hasMore: result.hasMore,
    nextCursor: result.nextCursor
  });
});

app.get('/api/admin/building-edits', requireAuth, requireAdmin, (req, res) => {
  const rows = db.prepare(`
    SELECT
      ai.osm_type,
      ai.osm_id,
      ai.name,
      ai.style,
      ai.levels,
      ai.year_built,
      ai.architect,
      ai.address,
      ai.archimap_description,
      ai.updated_by,
      ai.updated_at,
      bc.tags_json
    FROM local.architectural_info ai
    LEFT JOIN building_contours bc
      ON bc.osm_type = ai.osm_type AND bc.osm_id = ai.osm_id
    ORDER BY ai.updated_at DESC
    LIMIT 2000
  `).all();

  const out = [];
  for (const row of rows) {
    let tags = {};
    try {
      tags = row.tags_json ? JSON.parse(row.tags_json) : {};
    } catch {
      tags = {};
    }

    const changes = buildChangesFromRows(row, tags);
    if (changes.length === 0) continue;

    out.push({
      osmType: row.osm_type,
      osmId: row.osm_id,
      orphaned: !row.tags_json,
      updatedBy: row.updated_by || null,
      updatedAt: row.updated_at || null,
      changes
    });
  }

  return res.json({
    total: out.length,
    items: out
  });
});

app.post('/api/admin/building-edits/delete', requireAuth, requireAdmin, (req, res) => {
  const osmType = String(req.body?.osmType || '').trim();
  const osmId = Number(req.body?.osmId);
  if (!['way', 'relation'].includes(osmType) || !Number.isInteger(osmId)) {
    return res.status(400).json({ error: 'Некорректный идентификатор здания' });
  }

  const deleted = db.prepare(`
    DELETE FROM local.architectural_info
    WHERE osm_type = ? AND osm_id = ?
  `).run(osmType, osmId);

  enqueueSearchIndexRefresh(osmType, osmId);
  return res.json({
    ok: true,
    deleted: Number(deleted?.changes || 0)
  });
});

app.post('/api/admin/building-edits/reassign', requireAuth, requireAdmin, (req, res) => {
  const fromOsmType = String(req.body?.fromOsmType || '').trim();
  const fromOsmId = Number(req.body?.fromOsmId);
  const toOsmType = String(req.body?.toOsmType || '').trim();
  const toOsmId = Number(req.body?.toOsmId);

  if (!['way', 'relation'].includes(fromOsmType) || !Number.isInteger(fromOsmId)) {
    return res.status(400).json({ error: 'Некорректный исходный идентификатор здания' });
  }
  if (!['way', 'relation'].includes(toOsmType) || !Number.isInteger(toOsmId)) {
    return res.status(400).json({ error: 'Некорректный целевой идентификатор здания' });
  }
  if (fromOsmType === toOsmType && fromOsmId === toOsmId) {
    return res.status(400).json({ error: 'Исходный и целевой идентификаторы совпадают' });
  }

  const fromRow = db.prepare(`
    SELECT osm_type, osm_id, name, style, levels, year_built, architect, address, archimap_description, updated_by
    FROM local.architectural_info
    WHERE osm_type = ? AND osm_id = ?
  `).get(fromOsmType, fromOsmId);
  if (!fromRow) {
    return res.status(404).json({ error: 'Исходная локальная правка не найдена' });
  }

  const targetContour = db.prepare(`
    SELECT 1
    FROM building_contours
    WHERE osm_type = ? AND osm_id = ?
    LIMIT 1
  `).get(toOsmType, toOsmId);
  if (!targetContour) {
    return res.status(404).json({ error: 'Целевое здание не найдено в локальной базе контуров' });
  }

  const targetLocal = db.prepare(`
    SELECT 1
    FROM local.architectural_info
    WHERE osm_type = ? AND osm_id = ?
    LIMIT 1
  `).get(toOsmType, toOsmId);
  if (targetLocal) {
    return res.status(409).json({ error: 'Для целевого здания уже есть локальные правки' });
  }

  const tx = db.transaction(() => {
    db.prepare(`
      INSERT INTO local.architectural_info (osm_type, osm_id, name, style, levels, year_built, architect, address, archimap_description, updated_by, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `).run(
      toOsmType,
      toOsmId,
      fromRow.name ?? null,
      fromRow.style ?? null,
      fromRow.levels ?? null,
      fromRow.year_built ?? null,
      fromRow.architect ?? null,
      fromRow.address ?? null,
      fromRow.archimap_description ?? null,
      String(req.session?.user?.username || fromRow.updated_by || '')
    );

    db.prepare(`
      DELETE FROM local.architectural_info
      WHERE osm_type = ? AND osm_id = ?
    `).run(fromOsmType, fromOsmId);
  });

  tx();
  enqueueSearchIndexRefresh(fromOsmType, fromOsmId);
  enqueueSearchIndexRefresh(toOsmType, toOsmId);

  return res.json({
    ok: true,
    from: `${fromOsmType}/${fromOsmId}`,
    to: `${toOsmType}/${toOsmId}`
  });
});

app.get('/api/contours-status', (req, res) => {
  const summary = db.prepare(`
    SELECT COUNT(*) AS total, MAX(updated_at) AS last_updated
    FROM building_contours
  `).get();

  res.json({
    total: Number(summary.total || 0),
    lastUpdated: summary.last_updated || null
  });
});

function runCitySync(reason = 'interval') {
  if (syncInProgress) {
    if (reason !== 'scheduled' || !scheduledSkipLogged) {
      console.log(`[auto-sync] skipped (${reason}): previous sync still running`);
      if (reason === 'scheduled') scheduledSkipLogged = true;
    }
    return;
  }

  scheduledSkipLogged = false;
  syncInProgress = true;
  console.log(`[auto-sync] started (${reason})`);

  const child = spawn(process.execPath, [syncScriptPath], {
    cwd: __dirname,
    env: process.env,
    stdio: 'inherit'
  });
  currentSyncChild = child;

  child.on('error', (error) => {
    syncInProgress = false;
    scheduledSkipLogged = false;
    currentSyncChild = null;
    console.error(`[auto-sync] failed to start: ${String(error.message || error)}`);
  });

  child.on('close', (code, signal) => {
    syncInProgress = false;
    scheduledSkipLogged = false;
    currentSyncChild = null;
    if (shuttingDown && (signal === 'SIGTERM' || signal === 'SIGINT')) {
      console.log('[auto-sync] stopped due to shutdown');
      return;
    }
    if (code === 0) {
      console.log('[auto-sync] finished successfully');
      rebuildSearchIndex('auto-sync');
      filterTagKeysCache = { keys: null, loadedAt: 0 };
      scheduleFilterTagKeysCacheRebuild('auto-sync');
    } else {
      console.error(`[auto-sync] failed with code ${code}`);
    }
  });
}

function runPmtilesBuild(reason = 'startup-missing') {
  if (currentPmtilesBuildChild) {
    console.log(`[pmtiles] skipped (${reason}): generation already running`);
    return;
  }
  if (syncInProgress) {
    console.log(`[pmtiles] skipped (${reason}): full sync is running`);
    return;
  }

  console.log(`[pmtiles] generation started (${reason})`);
  const child = spawn(process.execPath, [syncScriptPath, '--pmtiles-only'], {
    cwd: __dirname,
    env: process.env,
    stdio: 'inherit'
  });
  currentPmtilesBuildChild = child;

  child.on('error', (error) => {
    currentPmtilesBuildChild = null;
    console.error(`[pmtiles] failed to start: ${String(error.message || error)}`);
  });

  child.on('close', (code, signal) => {
    currentPmtilesBuildChild = null;
    if (shuttingDown && (signal === 'SIGTERM' || signal === 'SIGINT')) {
      console.log('[pmtiles] generation stopped due to shutdown');
      return;
    }
    if (code === 0) {
      console.log('[pmtiles] generation finished successfully');
    } else {
      console.error(`[pmtiles] generation failed with code ${code}`);
    }
  });
}

function shouldRunStartupSync() {
  const hasPmtiles = fs.existsSync(buildingsPmtilesPath);
  const contoursTotal = Number(db.prepare('SELECT COUNT(*) AS total FROM building_contours').get()?.total || 0);
  const hasContours = contoursTotal > 0;
  if (hasContours && hasPmtiles) {
    console.log('[auto-sync] startup skipped: contours and PMTiles already exist');
    return false;
  }
  return true;
}

function maybeGeneratePmtilesOnStartup() {
  if (AUTO_SYNC_ENABLED && AUTO_SYNC_ON_START) return;

  const hasPmtiles = fs.existsSync(buildingsPmtilesPath);
  if (hasPmtiles) return;

  const contoursTotal = Number(db.prepare('SELECT COUNT(*) AS total FROM building_contours').get()?.total || 0);
  if (contoursTotal <= 0) {
    console.log('[pmtiles] startup generation skipped: building_contours is empty');
    return;
  }

  runPmtilesBuild('startup-missing');
}

function initAutoSync() {
  if (!AUTO_SYNC_ENABLED) {
    console.log('[auto-sync] disabled by AUTO_SYNC_ENABLED=false');
    maybeGeneratePmtilesOnStartup();
    return;
  }

  if (AUTO_SYNC_ON_START) {
    if (shouldRunStartupSync()) {
      runCitySync('startup');
    }
  } else {
    maybeGeneratePmtilesOnStartup();
  }

  if (Number.isFinite(AUTO_SYNC_INTERVAL_HOURS) && AUTO_SYNC_INTERVAL_HOURS > 0) {
    const intervalMs = Math.max(60_000, Math.round(AUTO_SYNC_INTERVAL_HOURS * 60 * 60 * 1000));
    const scheduleNext = (targetTs) => {
      const now = Date.now();
      const remaining = Math.max(0, targetTs - now);
      const delay = Math.min(remaining, MAX_NODE_TIMER_MS);

      nextSyncTimer = setTimeout(() => {
        if (Date.now() >= targetTs) {
          runCitySync('scheduled');
          scheduleNext(Date.now() + intervalMs);
          return;
        }
        scheduleNext(targetTs);
      }, delay);

      if (typeof nextSyncTimer.unref === 'function') {
        nextSyncTimer.unref();
      }
    };

    scheduleNext(Date.now() + intervalMs);
    console.log(`[auto-sync] scheduled every ${AUTO_SYNC_INTERVAL_HOURS}h`);
  } else {
    console.log('[auto-sync] periodic updates disabled (AUTO_SYNC_INTERVAL_HOURS <= 0)');
  }
}

async function initSessionStore() {
  const sessionConfig = {
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      maxAge: 1000 * 60 * 60 * 8
    }
  };

  let redisClient = null;
  try {
    redisClient = createClient({
      url: REDIS_URL,
      socket: {
        connectTimeout: 1500,
        reconnectStrategy: () => false
      }
    });
    redisClient.on('error', (error) => {
      console.error(`[session] Redis error: ${String(error.message || error)}`);
    });
    await redisClient.connect();
    sessionMiddleware = session({
      ...sessionConfig,
      store: new RedisStore({
        client: redisClient,
        prefix: 'archimap:sess:'
      })
    });
    console.log(`[session] Redis store connected: ${REDIS_URL}`);
  } catch (error) {
    console.error(`[session] Redis unavailable, fallback to MemoryStore: ${String(error.message || error)}`);
    try {
      await redisClient?.quit?.();
    } catch {
      // ignore
    }
    sessionMiddleware = session(sessionConfig);
  }
}

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[server] received ${signal}, shutting down...`);

  if (currentSyncChild && !currentSyncChild.killed) {
    try {
      currentSyncChild.kill('SIGTERM');
    } catch {
      // ignore
    }
  }
  if (currentPmtilesBuildChild && !currentPmtilesBuildChild.killed) {
    try {
      currentPmtilesBuildChild.kill('SIGTERM');
    } catch {
      // ignore
    }
  }
  if (currentSearchRebuildChild && !currentSearchRebuildChild.killed) {
    try {
      currentSearchRebuildChild.kill('SIGTERM');
    } catch {
      // ignore
    }
  }
  if (currentFilterTagKeysRebuildChild && !currentFilterTagKeysRebuildChild.killed) {
    try {
      currentFilterTagKeysRebuildChild.kill('SIGTERM');
    } catch {
      // ignore
    }
  }

  if (nextSyncTimer) {
    clearTimeout(nextSyncTimer);
    nextSyncTimer = null;
  }

  if (httpServer) {
    httpServer.close(() => {
      console.log('[server] shutdown complete');
      process.exit(0);
    });
  } else {
    process.exit(0);
  }

  setTimeout(() => {
    console.error('[server] forced shutdown timeout');
    process.exit(1);
  }, 10000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

initSessionStore()
  .then(() => {
    validateSecurityConfig();
    httpServer = app.listen(PORT, HOST, () => {
      console.log('[server] ArchiMap started successfully');
      console.log(`[server] Local:   http://localhost:${PORT}`);
      console.log(`[server] Network: http://${HOST}:${PORT}`);
      rebuildSearchIndex('startup');
      scheduleFilterTagKeysCacheRebuild('startup');
      initAutoSync();
      if (!rtreeState.ready) {
        scheduleBuildingContoursRtreeRebuild('startup');
      }
    });
  })
  .catch((error) => {
    console.error(`[server] Failed to initialize session store: ${String(error.message || error)}`);
    process.exit(1);
  });
