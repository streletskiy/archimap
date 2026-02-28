require('dotenv').config();

const fs = require('fs');
const path = require('path');
const express = require('express');
const Database = require('better-sqlite3');
const { ensureAuthSchema, registerAuthRoutes } = require('./auth');
const { createSimpleRateLimiter } = require('./services/rate-limiter.service');
const { createSearchService } = require('./services/search.service');
const { createBuildingEditsService } = require('./services/building-edits.service');
const { requireCsrfSession } = require('./services/csrf.service');
const {
  normalizeUserEditStatus,
  sanitizeFieldText,
  sanitizeYearBuilt,
  sanitizeLevels,
  sanitizeArchiPayload
} = require('./services/edits.service');
const { validateSecurityConfig } = require('./infra/security-config.infra');
const { applySecurityHeadersMiddleware } = require('./infra/security-headers.infra');
const { initSessionStore } = require('./infra/session-store.infra');
const { initSyncWorkersInfra } = require('./infra/sync-workers.infra');
const { initDbBootstrapInfra } = require('./infra/db-bootstrap.infra');
const { registerContoursStatusRoute } = require('./routes/contours-status.route');
const { registerAppRoutes, registerPublicStaticRoute } = require('./routes/app.route');
const { registerAdminRoutes } = require('./routes/admin.route');
const { registerBuildingsRoutes } = require('./routes/buildings.route');
const { registerSearchRoutes } = require('./routes/search.route');
const { registerAccountRoutes } = require('./routes/account.route');
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
const syncScriptPath = path.join(__dirname, 'scripts', 'sync-osm-buildings.js');
const searchRebuildScriptPath = path.join(__dirname, 'scripts', 'rebuild-search-index.js');
const filterTagKeysRebuildScriptPath = path.join(__dirname, 'scripts', 'rebuild-filter-tag-keys-cache.js');
const SEARCH_INDEX_BATCH_SIZE = Math.max(200, Math.min(20000, Number(process.env.SEARCH_INDEX_BATCH_SIZE || 2500)));

let sessionMiddleware = null;
let currentSearchRebuildChild = null;
let currentFilterTagKeysRebuildChild = null;
let httpServer = null;
let shuttingDown = false;
let searchIndexRebuildInProgress = false;
let queuedSearchIndexRebuildReason = null;
const pendingSearchIndexRefreshes = new Set();
let filterTagKeysCache = { keys: null, loadedAt: 0 };
let filterTagKeysRebuildInProgress = false;
let queuedFilterTagKeysRebuildReason = null;
let searchService = null;
let syncWorkers = null;

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

const RTREE_REBUILD_BATCH_SIZE = Math.max(500, Math.min(20000, Number(process.env.RTREE_REBUILD_BATCH_SIZE || 4000)));
const RTREE_REBUILD_PAUSE_MS = Math.max(0, Math.min(200, Number(process.env.RTREE_REBUILD_PAUSE_MS || 8)));

const {
  db,
  rtreeState,
  scheduleBuildingContoursRtreeRebuild
} = initDbBootstrapInfra({
  Database,
  dbPath,
  localEditsDbPath,
  userEditsDbPath,
  userAuthDbPath,
  buildingsPmtilesPath,
  ensureAuthSchema,
  rtreeRebuildBatchSize: RTREE_REBUILD_BATCH_SIZE,
  rtreeRebuildPauseMs: RTREE_REBUILD_PAUSE_MS,
  isSyncInProgress: () => syncWorkers?.isSyncInProgress?.() || false,
  logger: console
});

app.use(express.json());

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

applySecurityHeadersMiddleware(app, { nodeEnv: NODE_ENV });

app.use((req, res, next) => {
  if (!sessionMiddleware) {
    return res.status(503).json({ error: 'Сервис инициализируется, попробуйте ещё раз' });
  }
  return sessionMiddleware(req, res, next);
});

const buildingEditsService = createBuildingEditsService({
  db,
  normalizeUserEditStatus
});
const {
  ARCHI_FIELD_SET,
  getMergedInfoRow,
  getLatestUserEditRow,
  supersedePendingUserEdits,
  getSessionEditActorKey,
  getUserEditsList,
  getUserEditDetailsById,
  mergePersonalEditsIntoFeatureInfo,
  applyPersonalEditsToFilterItems
} = buildingEditsService;


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

searchService = createSearchService({
  db,
  defaultLon: MAP_DEFAULT_LON,
  defaultLat: MAP_DEFAULT_LAT,
  isRebuildInProgress: () => searchIndexRebuildInProgress
});

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
  return searchService.getBuildingSearchResults(queryText, centerLon, centerLat, limit, cursor);
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

registerAppRoutes({
  app,
  db,
  rootDir: __dirname,
  buildingsPmtilesPath,
  normalizeMapConfig,
  getBuildInfo,
  registrationEnabled: REGISTRATION_ENABLED,
  buildingsPmtilesSourceLayer: BUILDINGS_PMTILES_SOURCE_LAYER,
  getFilterTagKeysCached,
  isFilterTagKeysRebuildInProgress: () => filterTagKeysRebuildInProgress
});

registerAdminRoutes({
  app,
  db,
  requireAuth,
  requireAdmin,
  requireCsrfSession,
  getUserEditsList,
  getUserEditDetailsById,
  getSessionEditActorKey,
  normalizeUserEditStatus,
  sanitizeFieldText,
  sanitizeYearBuilt,
  sanitizeLevels,
  getMergedInfoRow,
  enqueueSearchIndexRefresh,
  ARCHI_FIELD_SET,
  registrationCodeHtmlTemplate,
  registrationCodeTextTemplate,
  passwordResetHtmlTemplate,
  passwordResetTextTemplate,
  appDisplayName: APP_DISPLAY_NAME,
  appBaseUrl: APP_BASE_URL,
  registrationCodeTtlMinutes: REGISTRATION_CODE_TTL_MINUTES,
  passwordResetTtlMinutes: PASSWORD_RESET_TTL_MINUTES
});

registerBuildingsRoutes({
  app,
  db,
  rtreeState,
  filterDataRateLimiter,
  filterDataBboxRateLimiter,
  requireCsrfSession,
  requireAuth,
  requireBuildingEditPermission,
  getSessionEditActorKey,
  applyPersonalEditsToFilterItems,
  rowToFeature,
  attachInfoToFeatures,
  getMergedInfoRow,
  getLatestUserEditRow,
  normalizeUserEditStatus,
  sanitizeArchiPayload,
  supersedePendingUserEdits
});

registerSearchRoutes({
  app,
  searchRateLimiter,
  getBuildingSearchResults
});

registerAccountRoutes({
  app,
  requireAuth,
  getSessionEditActorKey,
  normalizeUserEditStatus,
  getUserEditsList,
  getUserEditDetailsById
});

registerContoursStatusRoute(app, db);
registerPublicStaticRoute({ app, rootDir: __dirname });
syncWorkers = initSyncWorkersInfra({
  spawn,
  processExecPath: process.execPath,
  syncScriptPath,
  cwd: __dirname,
  env: process.env,
  autoSyncEnabled: AUTO_SYNC_ENABLED,
  autoSyncOnStart: AUTO_SYNC_ON_START,
  autoSyncIntervalHours: AUTO_SYNC_INTERVAL_HOURS,
  buildingsPmtilesPath,
  isShuttingDown: () => shuttingDown,
  getContoursTotal: () => Number(db.prepare('SELECT COUNT(*) AS total FROM building_contours').get()?.total || 0),
  onSyncSuccess: () => {
    rebuildSearchIndex('auto-sync');
    filterTagKeysCache = { keys: null, loadedAt: 0 };
    scheduleFilterTagKeysCacheRebuild('auto-sync');
  }
});

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[server] received ${signal}, shutting down...`);

  if (syncWorkers) {
    syncWorkers.stop();
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

initSessionStore({
  sessionSecret: SESSION_SECRET,
  nodeEnv: NODE_ENV,
  redisUrl: REDIS_URL,
  sessionAllowMemoryFallback: SESSION_ALLOW_MEMORY_FALLBACK,
  maxAgeMs: 1000 * 60 * 60 * 24 * 30
})
  .then((middleware) => {
    sessionMiddleware = middleware;
    validateSecurityConfig({
      nodeEnv: NODE_ENV,
      sessionSecret: SESSION_SECRET,
      appBaseUrl: APP_BASE_URL,
      sessionAllowMemoryFallback: SESSION_ALLOW_MEMORY_FALLBACK
    });
    httpServer = app.listen(PORT, HOST, () => {
      console.log('[server] archimap started successfully');
      console.log(`[server] Local:   http://localhost:${PORT}`);
      console.log(`[server] Network: http://${HOST}:${PORT}`);
      rebuildSearchIndex('startup');
      scheduleFilterTagKeysCacheRebuild('startup');
      if (syncWorkers) syncWorkers.initAutoSync();
      if (!rtreeState.ready) {
        scheduleBuildingContoursRtreeRebuild('startup');
      }
    });
  })
  .catch((error) => {
    console.error(`[server] Failed to initialize session store: ${String(error.message || error)}`);
    process.exit(1);
  });




