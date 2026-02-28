require('dotenv').config();

const fs = require('fs');
const path = require('path');
const express = require('express');
const session = require('express-session');
const { RedisStore } = require('connect-redis');
const { createClient } = require('redis');
const Database = require('better-sqlite3');
const { ensureAuthSchema, registerAuthRoutes } = require('./auth');
const {
  registrationCodeHtmlTemplate,
  registrationCodeTextTemplate,
  passwordResetHtmlTemplate,
  passwordResetTextTemplate
} = require('./email-templates');
const { spawn, execSync } = require('child_process');

const app = express();
app.disable('x-powered-by');

const PORT = Number(process.env.PORT || 3252);
const HOST = process.env.HOST || '0.0.0.0';
const NODE_ENV = process.env.NODE_ENV || 'development';
const TRUST_PROXY = String(process.env.TRUST_PROXY ?? 'false').toLowerCase() === 'true';
if (TRUST_PROXY) {
  app.set('trust proxy', 1);
}
const SESSION_SECRET = process.env.SESSION_SECRET || 'dev-secret-change-me';
const SESSION_ALLOW_MEMORY_FALLBACK = String(process.env.SESSION_ALLOW_MEMORY_FALLBACK ?? (NODE_ENV === 'production' ? 'false' : 'true')).toLowerCase() === 'true';
const AUTO_SYNC_ENABLED = String(process.env.AUTO_SYNC_ENABLED ?? 'true').toLowerCase() === 'true';
const AUTO_SYNC_ON_START = String(process.env.AUTO_SYNC_ON_START ?? 'true').toLowerCase() === 'true';
const AUTO_SYNC_INTERVAL_HOURS = Number(process.env.AUTO_SYNC_INTERVAL_HOURS || 168);
const REDIS_URL = process.env.REDIS_URL || 'redis://redis:6379';
const MAP_DEFAULT_LON = Number(process.env.MAP_DEFAULT_LON ?? 44.0059);
const MAP_DEFAULT_LAT = Number(process.env.MAP_DEFAULT_LAT ?? 56.3269);
const MAP_DEFAULT_ZOOM = Number(process.env.MAP_DEFAULT_ZOOM ?? 15);
const BUILDINGS_PMTILES_FILE = path.basename(String(process.env.BUILDINGS_PMTILES_FILE || 'buildings.pmtiles').trim() || 'buildings.pmtiles');
const BUILDINGS_PMTILES_SOURCE_LAYER = String(process.env.BUILDINGS_PMTILES_SOURCE_LAYER || 'buildings').trim() || 'buildings';
const BUILD_SHA = String(process.env.BUILD_SHA || '').trim();
const BUILD_VERSION = String(process.env.BUILD_VERSION || '').trim();
const SMTP_URL = String(process.env.SMTP_URL || '').trim();
const SMTP_HOST = String(process.env.SMTP_HOST || '').trim();
const SMTP_PORT = Number(process.env.SMTP_PORT || 587);
const SMTP_SECURE = String(process.env.SMTP_SECURE || 'false').toLowerCase() === 'true';
const SMTP_USER = String(process.env.SMTP_USER || '').trim();
const SMTP_PASS = String(process.env.SMTP_PASS || '').trim();
const EMAIL_FROM = String(process.env.EMAIL_FROM || SMTP_USER || '').trim();
const APP_BASE_URL = String(process.env.APP_BASE_URL || '').trim();
const USER_EDIT_REQUIRES_PERMISSION = String(process.env.USER_EDIT_REQUIRES_PERMISSION ?? 'true').toLowerCase() === 'true';
const REGISTRATION_ENABLED = String(process.env.REGISTRATION_ENABLED ?? 'true').toLowerCase() === 'true';
const REGISTRATION_CODE_TTL_MINUTES = Math.max(2, Math.min(60, Number(process.env.REGISTRATION_CODE_TTL_MINUTES || 15)));
const REGISTRATION_CODE_RESEND_COOLDOWN_SEC = Math.max(10, Math.min(600, Number(process.env.REGISTRATION_CODE_RESEND_COOLDOWN_SEC || 60)));
const REGISTRATION_CODE_MAX_ATTEMPTS = Math.max(3, Math.min(12, Number(process.env.REGISTRATION_CODE_MAX_ATTEMPTS || 6)));
const REGISTRATION_MIN_PASSWORD_LENGTH = Math.max(8, Math.min(72, Number(process.env.REGISTRATION_MIN_PASSWORD_LENGTH || 8)));
const PASSWORD_RESET_TTL_MINUTES = Math.max(5, Math.min(180, Number(process.env.PASSWORD_RESET_TTL_MINUTES || 60)));
const APP_DISPLAY_NAME = String(process.env.APP_DISPLAY_NAME || 'Archimap').trim() || 'Archimap';
const REPO_URL = 'https://github.com/streletskiy/archimap';
const BUILD_INFO_PATH = path.join(__dirname, 'build-info.json');

const dataDir = path.join(__dirname, 'data');
const dbPath = path.join(dataDir, 'archimap.db');
const buildingsPmtilesPath = path.join(dataDir, BUILDINGS_PMTILES_FILE);
const localEditsDbPath = process.env.LOCAL_EDITS_DB_PATH || path.join(dataDir, 'local-edits.db');
const userEditsDbPath = process.env.USER_EDITS_DB_PATH || path.join(dataDir, 'user-edits.db');
const userAuthDbPath = path.join(dataDir, 'users.db');

function ensureParentDir(filePath) {
  const target = String(filePath || '').trim();
  if (!target) return;
  const dir = path.dirname(target);
  if (!dir) return;
  fs.mkdirSync(dir, { recursive: true });
}

ensureParentDir(dbPath);
ensureParentDir(localEditsDbPath);
ensureParentDir(userEditsDbPath);
ensureParentDir(userAuthDbPath);
ensureParentDir(buildingsPmtilesPath);

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

function readGitValue(command) {
  try {
    return String(execSync(command, {
      cwd: __dirname,
      stdio: ['ignore', 'pipe', 'ignore']
    }) || '').trim();
  } catch {
    return '';
  }
}

function readBuildInfoFromFile() {
  try {
    const raw = fs.readFileSync(BUILD_INFO_PATH, 'utf8');
    const parsed = JSON.parse(String(raw || '{}'));
    const shortSha = String(parsed?.shortSha || '').trim();
    const version = String(parsed?.version || '').trim();
    return {
      shortSha: shortSha || '',
      version: version || ''
    };
  } catch {
    return { shortSha: '', version: '' };
  }
}

function getBuildInfo() {
  const fileInfo = readBuildInfoFromFile();
  const shortSha = fileInfo.shortSha || BUILD_SHA || readGitValue('git rev-parse --short HEAD') || 'unknown';
  const exactTag = fileInfo.version || BUILD_VERSION || readGitValue('git describe --tags --exact-match HEAD');
  return {
    shortSha,
    version: exactTag || 'dev',
    repoUrl: REPO_URL
  };
}

function validateSecurityConfig() {
  const isProduction = NODE_ENV === 'production';
  const weakSessionSecret = SESSION_SECRET === 'dev-secret-change-me';
  const hasAppBaseUrl = APP_BASE_URL.length > 0;
  const allowMemoryStoreFallback = SESSION_ALLOW_MEMORY_FALLBACK;

  if (!isProduction) {
    if (weakSessionSecret) {
      console.warn('[security] SESSION_SECRET uses default value (allowed in non-production, unsafe for production)');
    }
    if (!hasAppBaseUrl) {
      console.warn('[security] APP_BASE_URL is empty, password reset links will be unavailable');
    }
    if (allowMemoryStoreFallback) {
      console.warn('[security] SESSION_ALLOW_MEMORY_FALLBACK=true (development mode)');
    }
    return;
  }

  if (weakSessionSecret || !hasAppBaseUrl || allowMemoryStoreFallback) {
    const issues = [];
    if (weakSessionSecret) issues.push('SESSION_SECRET is default');
    if (!hasAppBaseUrl) issues.push('APP_BASE_URL is required');
    if (allowMemoryStoreFallback) issues.push('SESSION_ALLOW_MEMORY_FALLBACK must be false in production');
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

const searchRateLimiter = createSimpleRateLimiter({
  windowMs: 60 * 1000,
  maxRequests: 60,
  message: 'Слишком много поисковых запросов, попробуйте позже'
});
const filterDataRateLimiter = createSimpleRateLimiter({
  windowMs: 60 * 1000,
  maxRequests: 90,
  message: 'Слишком много запросов данных по зданиям, попробуйте позже'
});
const filterDataBboxRateLimiter = createSimpleRateLimiter({
  windowMs: 60 * 1000,
  maxRequests: 60,
  message: 'Слишком много запросов bbox, попробуйте позже'
});

db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 5000');

db.prepare(`ATTACH DATABASE ? AS local`).run(localEditsDbPath);
db.prepare(`ATTACH DATABASE ? AS user_edits`).run(userEditsDbPath);
db.prepare(`ATTACH DATABASE ? AS auth`).run(userAuthDbPath);
db.exec(`PRAGMA local.journal_mode = WAL;`);
db.exec(`PRAGMA local.synchronous = NORMAL;`);
db.exec(`PRAGMA user_edits.journal_mode = WAL;`);
db.exec(`PRAGMA user_edits.synchronous = NORMAL;`);
db.exec(`PRAGMA auth.journal_mode = WAL;`);
db.exec(`PRAGMA auth.synchronous = NORMAL;`);

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

app.use(express.json());

app.get('/app-config.js', (req, res) => {
  const mapDefault = normalizeMapConfig();
  const buildingsPmtiles = {
    url: '/api/buildings.pmtiles',
    sourceLayer: BUILDINGS_PMTILES_SOURCE_LAYER
  };
  const buildInfo = getBuildInfo();
  const bootstrapFirstAdminAvailable = Number(db.prepare('SELECT COUNT(*) AS total FROM auth.users').get()?.total || 0) === 0;
  const auth = {
    registrationEnabled: REGISTRATION_ENABLED,
    bootstrapFirstAdminAvailable
  };
  res.type('application/javascript').send(
    `window.__ARCHIMAP_CONFIG = ${JSON.stringify({ mapDefault, buildingsPmtiles, buildInfo, auth })};`
  );
});

const publicStatic = express.static(path.join(__dirname, 'public'));

app.get(['/account', '/account/'], (req, res) => {
  return res.sendFile(path.join(__dirname, 'public', 'account.html'));
});

app.get(['/admin', '/admin/'], (req, res) => {
  return res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

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
  } catch {
    res.status(500).json({ error: 'Не удалось получить список ключей OSM тегов' });
  }
});

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  const cspDirectives = [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' https://cdn.tailwindcss.com https://unpkg.com https://cdnjs.cloudflare.com",
    "style-src 'self' 'unsafe-inline' https://unpkg.com",
    "img-src 'self' data: blob: https:",
    "font-src 'self' data: https:",
    "connect-src 'self'",
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "frame-ancestors 'none'"
  ];
  res.setHeader('Content-Security-Policy', cspDirectives.join('; '));
  if (NODE_ENV === 'production' && req.secure) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
});

app.use((req, res, next) => {
  if (!sessionMiddleware) {
    return res.status(503).json({ error: 'Сервис инициализируется, попробуйте ещё раз' });
  }
  return sessionMiddleware(req, res, next);
});

app.get('/api/ui/email-previews', requireAuth, requireAdmin, (req, res) => {
  const appDisplayName = APP_DISPLAY_NAME;
  const sample = {
    registration: {
      code: '583401',
      expiresInMinutes: REGISTRATION_CODE_TTL_MINUTES,
      confirmUrl: `${APP_BASE_URL || 'https://archimap.local'}/account/?registerToken=sample-token-ui-preview`
    },
    passwordReset: {
      expiresInMinutes: PASSWORD_RESET_TTL_MINUTES,
      resetUrl: `${APP_BASE_URL || 'https://archimap.local'}/?auth=1&reset=sample-reset-token`
    }
  };

  const registration = {
    subject: `${appDisplayName}: код подтверждения регистрации`,
    html: registrationCodeHtmlTemplate({
      code: sample.registration.code,
      expiresInMinutes: sample.registration.expiresInMinutes,
      appDisplayName,
      confirmUrl: sample.registration.confirmUrl
    }),
    text: registrationCodeTextTemplate({
      code: sample.registration.code,
      expiresInMinutes: sample.registration.expiresInMinutes,
      appDisplayName,
      confirmUrl: sample.registration.confirmUrl
    })
  };

  const passwordReset = {
    subject: `${appDisplayName}: сброс пароля`,
    html: passwordResetHtmlTemplate({
      resetUrl: sample.passwordReset.resetUrl,
      expiresInMinutes: sample.passwordReset.expiresInMinutes,
      appDisplayName
    }),
    text: passwordResetTextTemplate({
      resetUrl: sample.passwordReset.resetUrl,
      expiresInMinutes: sample.passwordReset.expiresInMinutes,
      appDisplayName
    })
  };

  return res.json({
    appDisplayName,
    generatedAt: new Date().toISOString(),
    templates: {
      registration,
      passwordReset
    }
  });
});

app.get(/^\/ui(?:\/.*)?$/, requireAuth, requireAdmin, (req, res) => {
  return res.redirect('/admin/?tab=uikit');
});
app.use(publicStatic);

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

function attachInfoToFeatures(features, options = {}) {
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

  const actorKey = String(options.actorKey || '').trim().toLowerCase();
  if (actorKey) {
    mergePersonalEditsIntoFeatureInfo(features, actorKey);
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

app.post('/api/buildings/filter-data', filterDataRateLimiter, (req, res) => {
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

  const actorKey = getSessionEditActorKey(req);
  const items = applyPersonalEditsToFilterItems([...outByKey.values()], actorKey);
  return res.json({ items });
});

app.get('/api/buildings/filter-data-bbox', filterDataBboxRateLimiter, (req, res) => {
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

  const actorKey = getSessionEditActorKey(req);
  const items = applyPersonalEditsToFilterItems(rows.map(mapFilterDataRow), actorKey);
  res.setHeader('Cache-Control', 'public, max-age=60');
  return res.json({ items, truncated: rows.length >= limit });
});

function requireAuth(req, res, next) {
  if (!req.session || !req.session.user) {
    return res.status(401).json({ error: 'Требуется авторизация' });
  }
  const email = String(req.session.user.email || '').trim().toLowerCase();
  if (!email) {
    return res.status(401).json({ error: 'Требуется авторизация' });
  }
  const row = db.prepare('SELECT email, can_edit, is_admin, is_master_admin, first_name, last_name FROM auth.users WHERE email = ?').get(email);
  if (!row) {
    return res.status(401).json({ error: 'Требуется авторизация' });
  }
  const isMasterAdmin = Number(row.is_master_admin || 0) > 0;
  const isAdmin = isMasterAdmin || Number(row.is_admin || 0) > 0;
  const canEdit = Number(row.can_edit || 0) > 0;
  req.session.user = {
    ...req.session.user,
    username: String(row.email || req.session.user.username || ''),
    email: String(row.email || req.session.user.email || ''),
    isAdmin,
    isMasterAdmin,
    canEdit,
    canEditBuildings: isAdmin ? true : (USER_EDIT_REQUIRES_PERMISSION ? canEdit : true),
    firstName: row.first_name == null ? null : String(row.first_name),
    lastName: row.last_name == null ? null : String(row.last_name)
  };
  next();
}

function isAdminRequest(req) {
  return Boolean(req.session?.user?.isAdmin);
}

function requireAdmin(req, res, next) {
  if (!req?.session?.user) {
    return res.status(401).json({ error: 'Требуется авторизация' });
  }
  if (!isAdminRequest(req)) {
    return res.status(403).json({ error: 'Требуются права администратора' });
  }
  return next();
}

function requireCsrfSession(req, res, next) {
  if (!req?.session?.user) return next();
  const expected = String(req.session.csrfToken || '');
  const provided = String(req.get('x-csrf-token') || '');
  if (!expected || !provided || expected !== provided) {
    return res.status(403).json({ error: 'CSRF token missing or invalid' });
  }
  return next();
}

function requireBuildingEditPermission(req, res, next) {
  if (!req.session?.user) {
    return res.status(401).json({ error: 'Требуется авторизация' });
  }

  if (isAdminRequest(req)) return next();
  if (!USER_EDIT_REQUIRES_PERMISSION) return next();

  const email = String(req.session.user.email || '').trim().toLowerCase();
  if (!email) {
    return res.status(403).json({ error: 'Редактирование недоступно для этой учетной записи' });
  }

  const row = db.prepare('SELECT can_edit, is_admin FROM auth.users WHERE email = ?').get(email);
  if (!row) {
    return res.status(403).json({ error: 'Редактирование недоступно для этой учетной записи' });
  }
  if (Number(row.is_admin || 0) > 0) return next();
  if (Number(row.can_edit || 0) <= 0) {
    return res.status(403).json({ error: 'Редактирование запрещено. Обратитесь к администратору за доступом.' });
  }

  return next();
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

function applyPersonalEditsToFilterItems(items, actorKey) {
  const actor = String(actorKey || '').trim().toLowerCase();
  if (!actor || !Array.isArray(items) || items.length === 0) return items;
  const keys = items.map((item) => String(item?.osmKey || '')).filter((key) => /^(way|relation)\/\d+$/.test(key));
  if (keys.length === 0) return items;
  const personalByKey = getUserPersonalEditsByKeys(actor, keys, ['pending', 'rejected']);
  if (personalByKey.size === 0) return items;

  for (const item of items) {
    const key = String(item?.osmKey || '');
    const row = personalByKey.get(key);
    if (!row) continue;
    item.archiInfo = {
      osm_type: row.osm_type,
      osm_id: row.osm_id,
      name: row.name ?? null,
      style: row.style ?? null,
      levels: row.levels ?? null,
      year_built: row.year_built ?? null,
      architect: row.architect ?? null,
      address: row.address ?? null,
      description: null,
      archimap_description: row.archimap_description ?? null,
      updated_by: row.created_by ?? null,
      updated_at: row.updated_at ?? null,
      review_status: normalizeUserEditStatus(row.status),
      admin_comment: row.admin_comment ?? null,
      user_edit_id: Number(row.id || 0)
    };
    item.hasExtraInfo = true;
  }
  return items;
}

function normalizeInfoForDiff(value) {
  if (value == null) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const text = String(value).trim();
  return text ? text : null;
}

const ARCHI_EDIT_FIELDS = Object.freeze([
  { key: 'name', label: 'Название', osmTag: 'name | name:ru | official_name' },
  { key: 'address', label: 'Адрес', osmTag: 'addr:full | addr:* (city/street/housenumber/postcode)' },
  { key: 'levels', label: 'Этажей', osmTag: 'building:levels | levels' },
  { key: 'year_built', label: 'Год постройки', osmTag: 'building:year | start_date | construction_date | year_built' },
  { key: 'architect', label: 'Архитектор', osmTag: 'architect | architect_name' },
  { key: 'style', label: 'Архитектурный стиль', osmTag: 'building:architecture | architecture | style' },
  { key: 'archimap_description', label: 'Доп. информация', osmTag: null }
]);

const ARCHI_FIELD_SET = new Set(ARCHI_EDIT_FIELDS.map((f) => f.key));

const USER_EDIT_STATUS_VALUES = new Set(['pending', 'accepted', 'rejected', 'partially_accepted', 'superseded']);

function normalizeUserEditStatus(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (USER_EDIT_STATUS_VALUES.has(normalized)) return normalized;
  return 'pending';
}

function sanitizeFieldText(value, maxLen = 500) {
  if (value == null) return null;
  const text = String(value).trim();
  if (!text) return null;
  return text.slice(0, maxLen);
}

function sanitizeYearBuilt(value) {
  if (value === null || value === undefined || String(value).trim() === '') return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1000 || parsed > 2100) return null;
  return parsed;
}

function sanitizeLevels(value) {
  if (value === null || value === undefined || String(value).trim() === '') return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 300) return null;
  return parsed;
}

function sanitizeArchiPayload(body) {
  const yearRaw = body?.yearBuilt ?? body?.year_built;
  const levelsRaw = body?.levels;
  const yearBuilt = sanitizeYearBuilt(yearRaw);
  const levels = sanitizeLevels(levelsRaw);
  if ((yearRaw !== null && yearRaw !== undefined && String(yearRaw).trim() !== '') && yearBuilt == null) {
    return { error: 'Год постройки должен быть целым числом от 1000 до 2100' };
  }
  if ((levelsRaw !== null && levelsRaw !== undefined && String(levelsRaw).trim() !== '') && levels == null) {
    return { error: 'Этажность должна быть целым числом от 0 до 300' };
  }
  return {
    value: {
      name: sanitizeFieldText(body?.name, 250),
      style: sanitizeFieldText(body?.style, 200),
      levels,
      year_built: yearBuilt,
      architect: sanitizeFieldText(body?.architect, 200),
      address: sanitizeFieldText(body?.address, 300),
      archimap_description: sanitizeFieldText(body?.archimapDescription ?? body?.archimap_description ?? body?.description, 1000)
    }
  };
}

function rowToArchiInfo(row) {
  if (!row) return null;
  return {
    name: row.name ?? null,
    style: row.style ?? null,
    levels: row.levels ?? null,
    year_built: row.year_built ?? null,
    architect: row.architect ?? null,
    address: row.address ?? null,
    archimap_description: row.archimap_description ?? row.description ?? null
  };
}

function getMergedInfoRow(osmType, osmId) {
  return db.prepare(`
    SELECT osm_type, osm_id, name, style, levels, year_built, architect, address, description, archimap_description, updated_by, updated_at
    FROM local.architectural_info
    WHERE osm_type = ? AND osm_id = ?
    LIMIT 1
  `).get(osmType, osmId);
}

function getLatestUserEditRow(osmType, osmId, createdBy, statuses = null) {
  const actor = String(createdBy || '').trim().toLowerCase();
  if (!actor) return null;
  const allowed = Array.isArray(statuses) && statuses.length > 0
    ? statuses.map(normalizeUserEditStatus)
    : null;
  if (allowed && allowed.length > 0) {
    const placeholders = allowed.map(() => '?').join(', ');
    return db.prepare(`
      SELECT *
      FROM user_edits.building_user_edits
      WHERE osm_type = ? AND osm_id = ? AND lower(trim(created_by)) = ? AND status IN (${placeholders})
      ORDER BY id DESC
      LIMIT 1
    `).get(osmType, osmId, actor, ...allowed);
  }
  return db.prepare(`
    SELECT *
    FROM user_edits.building_user_edits
    WHERE osm_type = ? AND osm_id = ? AND lower(trim(created_by)) = ?
    ORDER BY id DESC
    LIMIT 1
  `).get(osmType, osmId, actor);
}

function supersedePendingUserEdits(osmType, osmId, createdBy, keepId = null) {
  const actor = String(createdBy || '').trim().toLowerCase();
  if (!actor) return;
  if (keepId && Number.isInteger(Number(keepId)) && Number(keepId) > 0) {
    db.prepare(`
      UPDATE user_edits.building_user_edits
      SET
        status = 'superseded',
        updated_at = datetime('now')
      WHERE osm_type = ? AND osm_id = ? AND lower(trim(created_by)) = ? AND status = 'pending' AND id != ?
    `).run(osmType, osmId, actor, Number(keepId));
    return;
  }
  db.prepare(`
    UPDATE user_edits.building_user_edits
    SET
      status = 'superseded',
      updated_at = datetime('now')
    WHERE osm_type = ? AND osm_id = ? AND lower(trim(created_by)) = ? AND status = 'pending'
  `).run(osmType, osmId, actor);
}

function buildChangesFromRows(editRow, tags, mergedRow = null) {
  const osmBaseline = getOsmBaselineFromTags(tags || {});
  const mergedInfo = rowToArchiInfo(mergedRow);
  const baseline = {
    name: mergedInfo?.name ?? osmBaseline.name,
    style: mergedInfo?.style ?? osmBaseline.style,
    levels: mergedInfo?.levels ?? osmBaseline.levels,
    year_built: mergedInfo?.year_built ?? osmBaseline.year_built,
    architect: mergedInfo?.architect ?? osmBaseline.architect,
    address: mergedInfo?.address ?? osmBaseline.address,
    archimap_description: mergedInfo?.archimap_description ?? null
  };

  const changes = [];
  for (const field of ARCHI_EDIT_FIELDS) {
    const baselineValue = normalizeInfoForDiff(baseline[field.key]);
    const localValue = normalizeInfoForDiff(editRow[field.key]);
    if (localValue == null) continue;
    if (baselineValue === localValue) continue;
    changes.push({
      field: field.key,
      label: field.label,
      osmTag: field.osmTag,
      isLocalTag: !field.osmTag,
      osmValue: baselineValue,
      localValue
    });
  }
  return changes;
}

function parseTagsJsonSafe(raw) {
  try {
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function getSessionEditActorKey(req) {
  const email = String(req?.session?.user?.email || '').trim().toLowerCase();
  if (email) return email;
  return String(req?.session?.user?.username || '').trim().toLowerCase();
}

function mapUserEditRow(row, tags, mergedInfoRow) {
  const changes = buildChangesFromRows(row, tags, mergedInfoRow);
  return {
    editId: Number(row.id || 0),
    osmType: row.osm_type,
    osmId: row.osm_id,
    orphaned: !tags || Object.keys(tags || {}).length === 0,
    updatedBy: row.created_by || null,
    updatedAt: row.updated_at || row.created_at || null,
    createdAt: row.created_at || null,
    status: normalizeUserEditStatus(row.status),
    adminComment: row.admin_comment || null,
    reviewedBy: row.reviewed_by || null,
    reviewedAt: row.reviewed_at || null,
    mergedBy: row.merged_by || null,
    mergedAt: row.merged_at || null,
    changes
  };
}

function getUserEditsList({ createdBy = null, status = null, limit = 2000 }) {
  const cappedLimit = Math.max(1, Math.min(5000, Number(limit) || 2000));
  const where = [];
  const params = [];
  if (createdBy) {
    where.push('lower(trim(ai.created_by)) = ?');
    params.push(String(createdBy).trim().toLowerCase());
  }
  if (status) {
    where.push('ai.status = ?');
    params.push(normalizeUserEditStatus(status));
  }
  const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  const rows = db.prepare(`
    SELECT
      ai.id,
      ai.osm_type,
      ai.osm_id,
      ai.name,
      ai.style,
      ai.levels,
      ai.year_built,
      ai.architect,
      ai.address,
      ai.archimap_description,
      ai.created_by,
      ai.status,
      ai.admin_comment,
      ai.reviewed_by,
      ai.reviewed_at,
      ai.merged_by,
      ai.merged_at,
      ai.created_at,
      ai.updated_at,
      bc.tags_json,
      li.name AS merged_name,
      li.style AS merged_style,
      li.levels AS merged_levels,
      li.year_built AS merged_year_built,
      li.architect AS merged_architect,
      li.address AS merged_address,
      li.archimap_description AS merged_archimap_description
    FROM user_edits.building_user_edits ai
    LEFT JOIN building_contours bc
      ON bc.osm_type = ai.osm_type AND bc.osm_id = ai.osm_id
    LEFT JOIN local.architectural_info li
      ON li.osm_type = ai.osm_type AND li.osm_id = ai.osm_id
    ${whereSql}
    ORDER BY ai.updated_at DESC, ai.id DESC
    LIMIT ?
  `).all(...params, cappedLimit);

  const out = [];
  for (const row of rows) {
    const tags = parseTagsJsonSafe(row.tags_json);
    const mergedInfoRow = {
      name: row.merged_name,
      style: row.merged_style,
      levels: row.merged_levels,
      year_built: row.merged_year_built,
      architect: row.merged_architect,
      address: row.merged_address,
      archimap_description: row.merged_archimap_description
    };
    out.push(mapUserEditRow(row, tags, mergedInfoRow));
  }
  return out;
}

function getUserEditDetailsById(editId) {
  const id = Number(editId);
  if (!Number.isInteger(id) || id <= 0) return null;
  const row = db.prepare(`
    SELECT
      ai.id,
      ai.osm_type,
      ai.osm_id,
      ai.name,
      ai.style,
      ai.levels,
      ai.year_built,
      ai.architect,
      ai.address,
      ai.archimap_description,
      ai.created_by,
      ai.status,
      ai.admin_comment,
      ai.reviewed_by,
      ai.reviewed_at,
      ai.merged_by,
      ai.merged_at,
      ai.created_at,
      ai.updated_at,
      bc.tags_json,
      li.name AS merged_name,
      li.style AS merged_style,
      li.levels AS merged_levels,
      li.year_built AS merged_year_built,
      li.architect AS merged_architect,
      li.address AS merged_address,
      li.archimap_description AS merged_archimap_description
    FROM user_edits.building_user_edits ai
    LEFT JOIN building_contours bc
      ON bc.osm_type = ai.osm_type AND bc.osm_id = ai.osm_id
    LEFT JOIN local.architectural_info li
      ON li.osm_type = ai.osm_type AND li.osm_id = ai.osm_id
    WHERE ai.id = ?
    LIMIT 1
  `).get(id);
  if (!row) return null;
  const tags = parseTagsJsonSafe(row.tags_json);
  const mergedInfoRow = {
    name: row.merged_name,
    style: row.merged_style,
    levels: row.merged_levels,
    year_built: row.merged_year_built,
    architect: row.merged_architect,
    address: row.merged_address,
    archimap_description: row.merged_archimap_description
  };
  const mapped = mapUserEditRow(row, tags, mergedInfoRow);
  return {
    editId: Number(row.id || 0),
    osmType: row.osm_type,
    osmId: row.osm_id,
    orphaned: !row.tags_json,
    updatedBy: row.created_by || null,
    updatedAt: row.updated_at || null,
    createdAt: row.created_at || null,
    status: normalizeUserEditStatus(row.status),
    adminComment: row.admin_comment || null,
    reviewedBy: row.reviewed_by || null,
    reviewedAt: row.reviewed_at || null,
    mergedBy: row.merged_by || null,
    mergedAt: row.merged_at || null,
    local: {
      name: row.name ?? null,
      style: row.style ?? null,
      levels: row.levels ?? null,
      yearBuilt: row.year_built ?? null,
      architect: row.architect ?? null,
      address: row.address ?? null,
      archimapDescription: row.archimap_description ?? null
    },
    changes: mapped.changes
  };
}

function getUserPersonalEditsByKeys(actorKey, keys, statuses = ['pending', 'rejected']) {
  const actor = String(actorKey || '').trim().toLowerCase();
  if (!actor || !Array.isArray(keys) || keys.length === 0) return new Map();
  const normalizedStatuses = (Array.isArray(statuses) ? statuses : [])
    .map(normalizeUserEditStatus)
    .filter((value, index, arr) => arr.indexOf(value) === index);
  if (normalizedStatuses.length === 0) return new Map();

  const out = new Map();
  const CHUNK_SIZE = 300;
  for (let i = 0; i < keys.length; i += CHUNK_SIZE) {
    const chunk = keys.slice(i, i + CHUNK_SIZE);
    const clauses = [];
    const params = [actor, ...normalizedStatuses];
    for (const key of chunk) {
      const parsed = parseOsmKey(key);
      if (!parsed) continue;
      clauses.push('(osm_type = ? AND osm_id = ?)');
      params.push(parsed.osmType, parsed.osmId);
    }
    if (clauses.length === 0) continue;
    const statusPlaceholders = normalizedStatuses.map(() => '?').join(', ');
    const rows = db.prepare(`
      SELECT ue.*
      FROM user_edits.building_user_edits ue
      JOIN (
        SELECT osm_type, osm_id, MAX(id) AS max_id
        FROM user_edits.building_user_edits
        WHERE lower(trim(created_by)) = ?
          AND status IN (${statusPlaceholders})
          AND (${clauses.join(' OR ')})
        GROUP BY osm_type, osm_id
      ) latest
        ON latest.max_id = ue.id
    `).all(...params);

    for (const row of rows) {
      out.set(`${row.osm_type}/${row.osm_id}`, row);
    }
  }
  return out;
}

function mergePersonalEditsIntoFeatureInfo(features, actorKey) {
  const keys = features
    .map((f) => String(f?.id || f?.properties?.osm_key || ''))
    .filter((id) => /^(way|relation)\/\d+$/.test(id));
  if (keys.length === 0) return features;

  const personalByKey = getUserPersonalEditsByKeys(actorKey, keys, ['pending', 'rejected']);
  if (personalByKey.size === 0) return features;

  for (const feature of features) {
    const key = String(feature?.id || feature?.properties?.osm_key || '');
    const row = personalByKey.get(key);
    if (!row) continue;
    feature.properties = feature.properties || {};
    feature.properties.archiInfo = {
      osm_type: row.osm_type,
      osm_id: row.osm_id,
      name: row.name ?? null,
      style: row.style ?? null,
      levels: row.levels ?? null,
      year_built: row.year_built ?? null,
      architect: row.architect ?? null,
      address: row.address ?? null,
      archimap_description: row.archimap_description ?? null,
      updated_by: row.created_by ?? null,
      updated_at: row.updated_at ?? null,
      review_status: normalizeUserEditStatus(row.status),
      admin_comment: row.admin_comment ?? null,
      user_edit_id: Number(row.id || 0)
    };
    feature.properties.hasExtraInfo = true;
  }

  return features;
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

registerAuthRoutes({
  app,
  db,
  createSimpleRateLimiter,
  sessionSecret: SESSION_SECRET,
  userEditRequiresPermission: USER_EDIT_REQUIRES_PERMISSION,
  registrationEnabled: REGISTRATION_ENABLED,
  registrationCodeTtlMinutes: REGISTRATION_CODE_TTL_MINUTES,
  registrationCodeResendCooldownSec: REGISTRATION_CODE_RESEND_COOLDOWN_SEC,
  registrationCodeMaxAttempts: REGISTRATION_CODE_MAX_ATTEMPTS,
  registrationMinPasswordLength: REGISTRATION_MIN_PASSWORD_LENGTH,
  passwordResetTtlMinutes: PASSWORD_RESET_TTL_MINUTES,
  appBaseUrl: APP_BASE_URL,
  appDisplayName: APP_DISPLAY_NAME,
  smtp: {
    url: SMTP_URL,
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_SECURE,
    user: SMTP_USER,
    pass: SMTP_PASS,
    from: EMAIL_FROM
  }
});

app.get('/api/building-info/:osmType/:osmId', (req, res) => {
  const osmType = req.params.osmType;
  const osmId = Number(req.params.osmId);
  if (!['way', 'relation'].includes(osmType) || !Number.isInteger(osmId)) {
    return res.status(400).json({ error: 'Некорректный идентификатор здания' });
  }

  const merged = getMergedInfoRow(osmType, osmId);
  const actorKey = getSessionEditActorKey(req);
  const personal = actorKey ? getLatestUserEditRow(osmType, osmId, actorKey, ['pending', 'rejected']) : null;
  const row = personal || merged;
  if (!row) {
    return res.status(404).json({ error: 'Информация не найдена' });
  }

  return res.json({
    osm_type: osmType,
    osm_id: osmId,
    name: row.name ?? null,
    style: row.style ?? null,
    levels: row.levels ?? null,
    year_built: row.year_built ?? null,
    architect: row.architect ?? null,
    address: row.address ?? null,
    description: row.description ?? null,
    archimap_description: row.archimap_description ?? row.description ?? null,
    updated_by: row.created_by ?? row.updated_by ?? null,
    updated_at: row.updated_at ?? null,
    review_status: personal ? normalizeUserEditStatus(personal.status) : 'accepted',
    admin_comment: personal?.admin_comment ?? null,
    user_edit_id: personal ? Number(personal.id || 0) : null
  });
});

app.post('/api/building-info', requireCsrfSession, requireAuth, requireBuildingEditPermission, (req, res) => {
  const body = req.body || {};
  const osmType = body.osmType;
  const osmId = Number(body.osmId);

  if (!['way', 'relation'].includes(osmType) || !Number.isInteger(osmId)) {
    return res.status(400).json({ error: 'Некорректный идентификатор здания' });
  }

  const validated = sanitizeArchiPayload(body);
  if (validated.error) {
    return res.status(400).json({ error: validated.error });
  }
  const actorKey = getSessionEditActorKey(req);
  if (!actorKey) {
    return res.status(400).json({ error: 'Не удалось определить текущего пользователя' });
  }
  const payload = validated.value;

  const tx = db.transaction(() => {
    const latest = getLatestUserEditRow(osmType, osmId, actorKey, ['pending']);
    if (latest && Number.isInteger(Number(latest.id)) && Number(latest.id) > 0) {
      db.prepare(`
        UPDATE user_edits.building_user_edits
        SET
          name = @name,
          style = @style,
          levels = @levels,
          year_built = @year_built,
          architect = @architect,
          address = @address,
          archimap_description = @archimap_description,
          status = 'pending',
          admin_comment = NULL,
          reviewed_by = NULL,
          reviewed_at = NULL,
          merged_by = NULL,
          merged_at = NULL,
          merged_fields_json = NULL,
          updated_at = datetime('now')
        WHERE id = @id
      `).run({
        id: latest.id,
        ...payload
      });
      supersedePendingUserEdits(osmType, osmId, actorKey, Number(latest.id));
      return Number(latest.id || 0);
    }

    supersedePendingUserEdits(osmType, osmId, actorKey, null);
    const inserted = db.prepare(`
      INSERT INTO user_edits.building_user_edits (
        osm_type, osm_id, created_by,
        name, style, levels, year_built, architect, address, archimap_description,
        status, created_at, updated_at
      )
      VALUES (
        @osm_type, @osm_id, @created_by,
        @name, @style, @levels, @year_built, @architect, @address, @archimap_description,
        'pending', datetime('now'), datetime('now')
      )
    `).run({
      osm_type: osmType,
      osm_id: osmId,
      created_by: actorKey,
      ...payload
    });
    return Number(inserted?.lastInsertRowid || 0);
  });

  const editId = tx();

  return res.json({ ok: true, editId, status: 'pending' });
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
  attachInfoToFeatures([feature], { actorKey: getSessionEditActorKey(req) });
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
  const statusRaw = String(req.query?.status || '').trim().toLowerCase();
  const status = statusRaw === 'all' || !statusRaw ? null : normalizeUserEditStatus(statusRaw);
  const out = getUserEditsList({ status, limit: 5000 });
  return res.json({
    total: out.length,
    items: out
  });
});

app.get('/api/admin/building-edits/:editId', requireAuth, requireAdmin, (req, res) => {
  const editId = Number(req.params.editId);
  if (!Number.isInteger(editId) || editId <= 0) {
    return res.status(400).json({ error: 'Некорректный идентификатор правки' });
  }
  const item = getUserEditDetailsById(editId);
  if (!item) {
    return res.status(404).json({ error: 'Правка не найдена' });
  }
  return res.json({ item });
});

app.get('/api/admin/users/:email', requireAuth, requireAdmin, (req, res) => {
  const email = String(req.params.email || '').trim().toLowerCase();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Некорректный email' });
  }
  const row = db.prepare(`
    SELECT
      u.email,
      u.first_name,
      u.last_name,
      u.can_edit,
      u.is_admin,
      u.is_master_admin,
      u.created_at,
      COALESCE(e.edit_count, 0) AS edits_count,
      e.last_edit_at
    FROM auth.users u
    LEFT JOIN (
      SELECT
        lower(trim(created_by)) AS created_by_key,
        COUNT(*) AS edit_count,
        MAX(updated_at) AS last_edit_at
      FROM user_edits.building_user_edits
      GROUP BY lower(trim(created_by))
    ) e
      ON e.created_by_key = lower(u.email)
    WHERE lower(u.email) = ?
    LIMIT 1
  `).get(email);
  if (!row) {
    return res.status(404).json({ error: 'Пользователь не найден' });
  }
  return res.json({
    item: {
      email: String(row.email || ''),
      firstName: row.first_name == null ? null : String(row.first_name),
      lastName: row.last_name == null ? null : String(row.last_name),
      canEdit: Number(row.can_edit || 0) > 0,
      isAdmin: Number(row.is_master_admin || 0) > 0 || Number(row.is_admin || 0) > 0,
      isMasterAdmin: Number(row.is_master_admin || 0) > 0,
      createdAt: String(row.created_at || ''),
      editsCount: Number(row.edits_count || 0),
      lastEditAt: row.last_edit_at ? String(row.last_edit_at) : null
    }
  });
});

app.get('/api/admin/users/:email/edits', requireAuth, requireAdmin, (req, res) => {
  const email = String(req.params.email || '').trim().toLowerCase();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Некорректный email' });
  }
  const items = getUserEditsList({ createdBy: email, limit: 5000 });
  return res.json({ total: items.length, items });
});

app.get('/api/account/edits', requireAuth, (req, res) => {
  const actorKey = getSessionEditActorKey(req);
  if (!actorKey) {
    return res.status(400).json({ error: 'Не удалось определить текущего пользователя' });
  }
  const statusRaw = String(req.query?.status || '').trim().toLowerCase();
  const status = statusRaw === 'all' || !statusRaw ? null : normalizeUserEditStatus(statusRaw);
  const items = getUserEditsList({ createdBy: actorKey, status, limit: 5000 });
  return res.json({ total: items.length, items });
});

app.get('/api/account/edits/:editId', requireAuth, (req, res) => {
  const actorKey = getSessionEditActorKey(req);
  if (!actorKey) {
    return res.status(400).json({ error: 'Не удалось определить текущего пользователя' });
  }
  const editId = Number(req.params.editId);
  if (!Number.isInteger(editId) || editId <= 0) {
    return res.status(400).json({ error: 'Некорректный идентификатор правки' });
  }
  const item = getUserEditDetailsById(editId);
  if (!item) {
    return res.status(404).json({ error: 'Правка не найдена' });
  }
  if (String(item.updatedBy || '').trim().toLowerCase() !== actorKey) {
    return res.status(403).json({ error: 'Доступ запрещен' });
  }
  return res.json({ item });
});

app.post('/api/admin/building-edits/:editId/reject', requireCsrfSession, requireAuth, requireAdmin, (req, res) => {
  const editId = Number(req.params.editId);
  if (!Number.isInteger(editId) || editId <= 0) {
    return res.status(400).json({ error: 'Некорректный идентификатор правки' });
  }
  const row = getUserEditDetailsById(editId);
  if (!row) return res.status(404).json({ error: 'Правка не найдена' });
  if (normalizeUserEditStatus(row.status) !== 'pending') {
    return res.status(409).json({ error: 'Правка уже обработана' });
  }
  const comment = sanitizeFieldText(req.body?.comment, 1200);
  const reviewer = getSessionEditActorKey(req) || 'admin';
  const result = db.prepare(`
    UPDATE user_edits.building_user_edits
    SET
      status = 'rejected',
      admin_comment = ?,
      reviewed_by = ?,
      reviewed_at = datetime('now'),
      merged_by = NULL,
      merged_at = NULL,
      merged_fields_json = NULL,
      updated_at = datetime('now')
    WHERE id = ? AND status = 'pending'
  `).run(comment, reviewer, editId);
  if (Number(result?.changes || 0) === 0) {
    return res.status(409).json({ error: 'Правка уже обработана другим администратором' });
  }
  return res.json({ ok: true, editId, status: 'rejected' });
});

app.post('/api/admin/building-edits/:editId/merge', requireCsrfSession, requireAuth, requireAdmin, (req, res) => {
  const editId = Number(req.params.editId);
  if (!Number.isInteger(editId) || editId <= 0) {
    return res.status(400).json({ error: 'Некорректный идентификатор правки' });
  }
  const item = getUserEditDetailsById(editId);
  if (!item) {
    return res.status(404).json({ error: 'Правка не найдена' });
  }
  if (normalizeUserEditStatus(item.status) !== 'pending') {
    return res.status(409).json({ error: 'Правка уже обработана' });
  }
  const forceMerge = Boolean(req.body?.force === true);

  const allowedFields = new Set(item.changes.map((change) => String(change.field || '')));
  if (allowedFields.size === 0) {
    return res.status(409).json({ error: 'В правке нет отличий от текущих данных' });
  }

  const requestedFields = Array.isArray(req.body?.fields)
    ? req.body.fields.map((value) => String(value || '').trim()).filter((key) => ARCHI_FIELD_SET.has(key) && allowedFields.has(key))
    : [];
  const fieldsToMerge = requestedFields.length > 0 ? [...new Set(requestedFields)] : [...allowedFields];

  const valuesRaw = req.body?.values && typeof req.body.values === 'object' ? req.body.values : {};
  const sanitizedValues = {};
  for (const key of fieldsToMerge) {
    if (!Object.prototype.hasOwnProperty.call(valuesRaw, key)) continue;
    if (key === 'year_built') {
      const parsed = sanitizeYearBuilt(valuesRaw[key]);
      if (parsed == null && String(valuesRaw[key] ?? '').trim() !== '') {
        return res.status(400).json({ error: 'Год постройки должен быть целым числом от 1000 до 2100' });
      }
      sanitizedValues[key] = parsed;
      continue;
    }
    if (key === 'levels') {
      const parsed = sanitizeLevels(valuesRaw[key]);
      if (parsed == null && String(valuesRaw[key] ?? '').trim() !== '') {
        return res.status(400).json({ error: 'Этажность должна быть целым числом от 0 до 300' });
      }
      sanitizedValues[key] = parsed;
      continue;
    }
    sanitizedValues[key] = sanitizeFieldText(valuesRaw[key], key === 'archimap_description' ? 1000 : 300);
  }

  const currentMerged = getMergedInfoRow(item.osmType, item.osmId) || {};
  const editCreatedTs = item.createdAt ? Date.parse(String(item.createdAt)) : NaN;
  const currentMergedTs = currentMerged?.updated_at ? Date.parse(String(currentMerged.updated_at)) : NaN;
  if (!forceMerge && Number.isFinite(editCreatedTs) && Number.isFinite(currentMergedTs) && currentMergedTs > editCreatedTs) {
    return res.status(409).json({
      error: 'Правка устарела: данные здания были изменены после её создания. Обновите правку или выполните merge с force.',
      code: 'EDIT_OUTDATED',
      currentUpdatedAt: currentMerged.updated_at || null,
      editCreatedAt: item.createdAt || null
    });
  }
  const editSource = db.prepare(`
    SELECT name, style, levels, year_built, architect, address, archimap_description
    FROM user_edits.building_user_edits
    WHERE id = ?
    LIMIT 1
  `).get(editId) || {};

  const mergedCandidate = {
    name: currentMerged.name ?? null,
    style: currentMerged.style ?? null,
    levels: currentMerged.levels ?? null,
    year_built: currentMerged.year_built ?? null,
    architect: currentMerged.architect ?? null,
    address: currentMerged.address ?? null,
    archimap_description: currentMerged.archimap_description ?? null
  };
  for (const field of fieldsToMerge) {
    mergedCandidate[field] = Object.prototype.hasOwnProperty.call(sanitizedValues, field)
      ? sanitizedValues[field]
      : (editSource[field] ?? null);
  }

  const reviewer = getSessionEditActorKey(req) || 'admin';
  const adminComment = sanitizeFieldText(req.body?.comment, 1200);
  const nextStatus = fieldsToMerge.length < allowedFields.size ? 'partially_accepted' : 'accepted';

  const tx = db.transaction(() => {
    db.prepare(`
      INSERT INTO local.architectural_info (
        osm_type, osm_id, name, style, levels, year_built, architect, address, archimap_description, updated_by, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(osm_type, osm_id) DO UPDATE SET
        name = excluded.name,
        style = excluded.style,
        levels = excluded.levels,
        year_built = excluded.year_built,
        architect = excluded.architect,
        address = excluded.address,
        archimap_description = excluded.archimap_description,
        updated_by = excluded.updated_by,
        updated_at = datetime('now')
    `).run(
      item.osmType,
      item.osmId,
      mergedCandidate.name,
      mergedCandidate.style,
      mergedCandidate.levels,
      mergedCandidate.year_built,
      mergedCandidate.architect,
      mergedCandidate.address,
      mergedCandidate.archimap_description,
      reviewer
    );

    db.prepare(`
      UPDATE user_edits.building_user_edits
      SET
        status = ?,
        admin_comment = ?,
        reviewed_by = ?,
        reviewed_at = datetime('now'),
        merged_by = ?,
        merged_at = datetime('now'),
        merged_fields_json = ?,
        updated_at = datetime('now')
      WHERE id = ? AND status = 'pending'
    `).run(nextStatus, adminComment, reviewer, reviewer, JSON.stringify(fieldsToMerge), editId);
  });

  try {
    tx();
  } catch {
    return res.status(409).json({ error: 'Не удалось применить merge: правка была изменена параллельно' });
  }
  const updated = db.prepare(`SELECT status FROM user_edits.building_user_edits WHERE id = ?`).get(editId);
  if (!updated || (normalizeUserEditStatus(updated.status) !== 'accepted' && normalizeUserEditStatus(updated.status) !== 'partially_accepted')) {
    return res.status(409).json({ error: 'Правка уже обработана другим администратором' });
  }
  enqueueSearchIndexRefresh(item.osmType, item.osmId);
  return res.json({
    ok: true,
    editId,
    status: nextStatus,
    mergedFields: fieldsToMerge
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
      console.error('[pmtiles] Hint: run "docker compose run --rm archimap node scripts/sync-osm-buildings.js --pmtiles-only" to build tiles in Docker.');
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
  const contoursTotal = Number(db.prepare('SELECT COUNT(*) AS total FROM building_contours').get()?.total || 0);
  const needsBootstrapSync = contoursTotal <= 0;

  if (needsBootstrapSync) {
    if (!AUTO_SYNC_ENABLED) {
      console.log('[auto-sync] bootstrap run: building_contours is empty (AUTO_SYNC_ENABLED ignored for first sync)');
    } else if (!AUTO_SYNC_ON_START) {
      console.log('[auto-sync] bootstrap run: building_contours is empty (AUTO_SYNC_ON_START ignored for first sync)');
    }
    runCitySync('bootstrap-first-run');
  }

  if (!AUTO_SYNC_ENABLED) {
    console.log('[auto-sync] disabled by AUTO_SYNC_ENABLED=false');
    if (!needsBootstrapSync) {
      maybeGeneratePmtilesOnStartup();
    }
    return;
  }

  if (!needsBootstrapSync && AUTO_SYNC_ON_START) {
    if (shouldRunStartupSync()) {
      runCitySync('startup');
    }
  } else if (!needsBootstrapSync) {
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
      secure: NODE_ENV === 'production',
      maxAge: 1000 * 60 * 60 * 24 * 30
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
    if (!SESSION_ALLOW_MEMORY_FALLBACK) {
      throw new Error(`[session] Redis unavailable and SESSION_ALLOW_MEMORY_FALLBACK=false: ${String(error.message || error)}`);
    }
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
      console.log('[server] archimap started successfully');
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


