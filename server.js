require('dotenv').config({ quiet: true });

const fs = require('fs');
const path = require('path');
const { ensureAuthSchema, registerAuthRoutes } = require('./src/lib/server/auth');
const { createSimpleRateLimiter } = require('./src/lib/server/services/rate-limiter.service');
const { createSearchService } = require('./src/lib/server/services/search.service');
const { createBuildingEditsService } = require('./src/lib/server/services/building-edits.service');
const { createAppSettingsService } = require('./src/lib/server/services/app-settings.service');
const { requireCsrfSession } = require('./src/lib/server/services/csrf.service');
const { createLogger } = require('./src/lib/server/services/logger.service');
const {
  normalizeUserEditStatus,
  sanitizeFieldText,
  sanitizeYearBuilt,
  sanitizeLevels,
  sanitizeArchiPayload
} = require('./src/lib/server/services/edits.service');
const { validateSecurityConfig } = require('./src/lib/server/infra/security-config.infra');
const { collectInlineScriptHashesFromFile } = require('./src/lib/server/infra/csp.infra');
const { parseRuntimeEnv } = require('./src/lib/server/infra/env.infra');
const { applySecurityHeadersMiddleware } = require('./src/lib/server/infra/security-headers.infra');
const { registerErrorHandlers } = require('./src/lib/server/infra/error-handling.infra');
const { initSessionStore } = require('./src/lib/server/infra/session-store.infra');
const { initSyncWorkersInfra } = require('./src/lib/server/infra/sync-workers.infra');
const { createDbRuntime } = require('./src/lib/server/infra/db-runtime.infra');
const { initObservabilityInfra } = require('./src/lib/server/infra/observability.infra');
const { registerContoursStatusRoute } = require('./src/routes/contours-status.route');
const { registerAppRoutes } = require('./src/routes/app.route');
const { registerAdminRoutes } = require('./src/routes/admin.route');
const { registerBuildingsRoutes } = require('./src/routes/buildings.route');
const { registerSearchRoutes } = require('./src/routes/search.route');
const { registerAccountRoutes } = require('./src/routes/account.route');
const { createMiniApp, jsonMiddleware } = require('./src/lib/server/infra/mini-app.infra');
const { getAppVersion, getBuildInfo } = require('./src/lib/server/version');
const {
  registrationCodeHtmlTemplate,
  registrationCodeTextTemplate,
  passwordResetHtmlTemplate,
  passwordResetTextTemplate
} = require('./src/lib/server/email-templates');
const { spawn } = require('child_process');

const app = createMiniApp();
app.disable('x-powered-by');

const runtimeEnv = parseRuntimeEnv(process.env);
const PORT = runtimeEnv.port;
const HOST = runtimeEnv.host;
const NODE_ENV = runtimeEnv.nodeEnv;
const DB_PROVIDER = runtimeEnv.dbProvider;
const TRUST_PROXY = String(process.env.TRUST_PROXY ?? 'false').toLowerCase() === 'true';
if (TRUST_PROXY) {
  app.set('trust proxy', 1);
}
const SESSION_SECRET = runtimeEnv.sessionSecret;
const SESSION_ALLOW_MEMORY_FALLBACK = String(process.env.SESSION_ALLOW_MEMORY_FALLBACK ?? (NODE_ENV === 'production' ? 'false' : 'true')).toLowerCase() === 'true';
const SESSION_COOKIE_SECURE_RAW = String(process.env.SESSION_COOKIE_SECURE || '').trim().toLowerCase();
const SESSION_COOKIE_SECURE = SESSION_COOKIE_SECURE_RAW === 'true'
  ? true
  : (SESSION_COOKIE_SECURE_RAW === 'false'
    ? false
    : (NODE_ENV === 'production'));
const AUTO_SYNC_ENABLED = String(process.env.AUTO_SYNC_ENABLED ?? 'true').toLowerCase() === 'true';
const AUTO_SYNC_ON_START = String(process.env.AUTO_SYNC_ON_START ?? 'true').toLowerCase() === 'true';
const AUTO_SYNC_INTERVAL_HOURS = Number(process.env.AUTO_SYNC_INTERVAL_HOURS || 168);
const REDIS_URL = process.env.REDIS_URL || 'redis://redis:6379';
const MAP_DEFAULT_LON = Number(process.env.MAP_DEFAULT_LON ?? 44.0059);
const MAP_DEFAULT_LAT = Number(process.env.MAP_DEFAULT_LAT ?? 56.3269);
const MAP_DEFAULT_ZOOM = Number(process.env.MAP_DEFAULT_ZOOM ?? 15);
const BUILDINGS_PMTILES_FILE = path.basename(String(process.env.BUILDINGS_PMTILES_FILE || 'buildings.pmtiles').trim() || 'buildings.pmtiles');
const BUILDINGS_PMTILES_SOURCE_LAYER = String(process.env.BUILDINGS_PMTILES_SOURCE_LAYER || 'buildings').trim() || 'buildings';
const SMTP_URL = String(process.env.SMTP_URL || '').trim();
const SMTP_HOST = String(process.env.SMTP_HOST || '').trim();
const SMTP_PORT = Number(process.env.SMTP_PORT || 587);
const SMTP_SECURE = String(process.env.SMTP_SECURE || 'false').toLowerCase() === 'true';
const SMTP_USER = String(process.env.SMTP_USER || '').trim();
const SMTP_PASS = String(process.env.SMTP_PASS || '').trim();
const EMAIL_FROM = String(process.env.EMAIL_FROM || SMTP_USER || '').trim();
const APP_SETTINGS_SECRET = String(process.env.APP_SETTINGS_SECRET || SESSION_SECRET).trim() || SESSION_SECRET;
const APP_BASE_URL = runtimeEnv.appBaseUrl;
const USER_EDIT_REQUIRES_PERMISSION = String(process.env.USER_EDIT_REQUIRES_PERMISSION ?? 'true').toLowerCase() === 'true';
const REGISTRATION_ENABLED = String(process.env.REGISTRATION_ENABLED ?? 'true').toLowerCase() === 'true';
const REGISTRATION_CODE_TTL_MINUTES = Math.max(2, Math.min(60, Number(process.env.REGISTRATION_CODE_TTL_MINUTES || 15)));
const REGISTRATION_CODE_RESEND_COOLDOWN_SEC = Math.max(10, Math.min(600, Number(process.env.REGISTRATION_CODE_RESEND_COOLDOWN_SEC || 60)));
const REGISTRATION_CODE_MAX_ATTEMPTS = Math.max(3, Math.min(12, Number(process.env.REGISTRATION_CODE_MAX_ATTEMPTS || 6)));
const REGISTRATION_MIN_PASSWORD_LENGTH = Math.max(8, Math.min(72, Number(process.env.REGISTRATION_MIN_PASSWORD_LENGTH || 8)));
const PASSWORD_RESET_TTL_MINUTES = Math.max(5, Math.min(180, Number(process.env.PASSWORD_RESET_TTL_MINUTES || 60)));
const APP_DISPLAY_NAME = String(process.env.APP_DISPLAY_NAME || 'archimap').trim() || 'archimap';
const LOG_LEVEL = String(process.env.LOG_LEVEL || 'info').trim().toLowerCase() || 'info';
const METRICS_ENABLED = String(process.env.METRICS_ENABLED ?? 'true').toLowerCase() === 'true';
const FRONTEND_INDEX_PATH = path.join(__dirname, 'frontend', 'build', 'index.html');
const CSP_SCRIPT_HASHES = collectInlineScriptHashesFromFile(FRONTEND_INDEX_PATH);

const dataDir = path.join(__dirname, 'data');
const dbPath = String(
  process.env.DATABASE_PATH
  || process.env.ARCHIMAP_DB_PATH
  || runtimeEnv.sqliteUrl
  || path.join(dataDir, 'archimap.db')
).trim() || path.join(dataDir, 'archimap.db');
const osmDbPath = String(process.env.OSM_DB_PATH || path.join(dataDir, 'osm.db')).trim() || path.join(dataDir, 'osm.db');
const buildingsPmtilesPath = path.join(dataDir, BUILDINGS_PMTILES_FILE);
const localEditsDbPath = process.env.LOCAL_EDITS_DB_PATH || path.join(dataDir, 'local-edits.db');
const userEditsDbPath = process.env.USER_EDITS_DB_PATH || path.join(dataDir, 'user-edits.db');
const userAuthDbPath = String(process.env.USER_AUTH_DB_PATH || path.join(dataDir, 'users.db')).trim() || path.join(dataDir, 'users.db');
const syncScriptPath = path.join(__dirname, 'scripts', 'sync-osm-buildings.js');
const searchRebuildScriptPath = path.join(__dirname, 'workers', 'rebuild-search-index.worker.js');
const filterTagKeysRebuildScriptPath = path.join(__dirname, 'workers', 'rebuild-filter-tag-keys-cache.worker.js');
const SEARCH_INDEX_BATCH_SIZE = Math.max(200, Math.min(20000, Number(process.env.SEARCH_INDEX_BATCH_SIZE || 2500)));
const logger = createLogger({ level: LOG_LEVEL, service: 'archimap-server' });

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
let dbRuntimeReady = false;

function normalizeMapConfig() {
  const lon = Number.isFinite(MAP_DEFAULT_LON) ? Math.min(180, Math.max(-180, MAP_DEFAULT_LON)) : 44.0059;
  const lat = Number.isFinite(MAP_DEFAULT_LAT) ? Math.min(90, Math.max(-90, MAP_DEFAULT_LAT)) : 56.3269;
  const zoom = Number.isFinite(MAP_DEFAULT_ZOOM) ? Math.min(22, Math.max(0, MAP_DEFAULT_ZOOM)) : 15;
  return { lon, lat, zoom };
}

const searchRateLimiter = createSimpleRateLimiter({
  windowMs: 60 * 1000,
  maxRequests: 60,
  message: 'Слишком много поисковых запросов, попробуйте позже'
});
const publicApiRateLimiter = createSimpleRateLimiter({
  windowMs: 60 * 1000,
  maxRequests: 180,
  message: 'Слишком много запросов, попробуйте позже'
});
const accountReadRateLimiter = createSimpleRateLimiter({
  windowMs: 60 * 1000,
  maxRequests: 120,
  message: 'Слишком много запросов аккаунта, попробуйте позже'
});
const adminApiRateLimiter = createSimpleRateLimiter({
  windowMs: 60 * 1000,
  maxRequests: 120,
  message: 'Слишком много административных запросов, попробуйте позже'
});
const filterDataRateLimiter = createSimpleRateLimiter({
  windowMs: 60 * 1000,
  maxRequests: 240,
  message: 'Слишком много запросов данных по зданиям, попробуйте позже'
});
const filterDataBboxRateLimiter = createSimpleRateLimiter({
  windowMs: 60 * 1000,
  maxRequests: 60,
  message: 'Слишком много запросов bbox, попробуйте позже'
});
const filterMatchesRateLimiter = createSimpleRateLimiter({
  windowMs: 60 * 1000,
  maxRequests: 90,
  message: 'Слишком много запросов фильтрации, попробуйте позже'
});
const buildingsReadRateLimiter = createSimpleRateLimiter({
  windowMs: 60 * 1000,
  maxRequests: 120,
  message: 'Слишком много запросов к зданиям, попробуйте позже'
});
const buildingsWriteRateLimiter = createSimpleRateLimiter({
  windowMs: 60 * 1000,
  maxRequests: 60,
  message: 'Слишком много изменений по зданиям, попробуйте позже'
});
const contoursStatusRateLimiter = createSimpleRateLimiter({
  windowMs: 60 * 1000,
  maxRequests: 60,
  message: 'Слишком много запросов статуса контуров, попробуйте позже'
});

const RTREE_REBUILD_BATCH_SIZE = Math.max(500, Math.min(20000, Number(process.env.RTREE_REBUILD_BATCH_SIZE || 4000)));
const RTREE_REBUILD_PAUSE_MS = Math.max(0, Math.min(200, Number(process.env.RTREE_REBUILD_PAUSE_MS || 8)));

function createDeferredDb(runtimePromise, provider) {
  return {
    provider,
    prepare(sql) {
      return {
        get: async (...args) => {
          const runtime = await runtimePromise;
          return runtime.db.prepare(sql).get(...args);
        },
        all: async (...args) => {
          const runtime = await runtimePromise;
          return runtime.db.prepare(sql).all(...args);
        },
        run: async (...args) => {
          const runtime = await runtimePromise;
          return runtime.db.prepare(sql).run(...args);
        }
      };
    },
    exec: async (sql) => {
      const runtime = await runtimePromise;
      return runtime.db.exec(sql);
    },
    transaction(fn) {
      return async (...args) => {
        const runtime = await runtimePromise;
        const tx = runtime.db.transaction(fn);
        return tx(...args);
      };
    }
  };
}

const rtreeState = { supported: false, ready: false, rebuilding: false };
let scheduleBuildingContoursRtreeRebuild = () => {};
const dbRuntimePromise = createDbRuntime({
  runtimeEnv,
  rawEnv: process.env,
  sqlite: {
    dbPath,
    osmDbPath,
    localEditsDbPath,
    userEditsDbPath,
    userAuthDbPath,
    buildingsPmtilesPath,
    ensureAuthSchema,
    rtreeRebuildBatchSize: RTREE_REBUILD_BATCH_SIZE,
    rtreeRebuildPauseMs: RTREE_REBUILD_PAUSE_MS,
    isSyncInProgress: () => syncWorkers?.isSyncInProgress?.() || false
  },
  postgres: {},
  logger
});
const db = createDeferredDb(dbRuntimePromise, DB_PROVIDER);

dbRuntimePromise.then((runtime) => {
  dbRuntimeReady = true;
  if (runtime?.rtreeState && typeof runtime.rtreeState === 'object') {
    rtreeState.supported = Boolean(runtime.rtreeState.supported);
    rtreeState.ready = Boolean(runtime.rtreeState.ready);
    rtreeState.rebuilding = Boolean(runtime.rtreeState.rebuilding);
  }
  scheduleBuildingContoursRtreeRebuild = typeof runtime?.scheduleBuildingContoursRtreeRebuild === 'function'
    ? runtime.scheduleBuildingContoursRtreeRebuild
    : (() => {});
}).catch((error) => {
  logger.error('db_runtime_init_failed', { error: String(error?.message || error) });
  process.exit(1);
});

async function closeDbRuntime() {
  try {
    const runtime = await dbRuntimePromise;
    if (runtime && typeof runtime.close === 'function') {
      await runtime.close();
    }
  } catch {
    // ignore shutdown cleanup errors
  }
}

const appSettingsService = createAppSettingsService({
  db,
  settingsSecret: APP_SETTINGS_SECRET,
  fallbackGeneral: {
    appDisplayName: APP_DISPLAY_NAME,
    appBaseUrl: APP_BASE_URL,
    registrationEnabled: REGISTRATION_ENABLED,
    userEditRequiresPermission: USER_EDIT_REQUIRES_PERMISSION
  },
  fallbackSmtp: {
    url: SMTP_URL,
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_SECURE,
    user: SMTP_USER,
    pass: SMTP_PASS,
    from: EMAIL_FROM
  }
});

const generalConfigFallback = {
  appDisplayName: APP_DISPLAY_NAME,
  appBaseUrl: APP_BASE_URL,
  registrationEnabled: REGISTRATION_ENABLED,
  userEditRequiresPermission: USER_EDIT_REQUIRES_PERMISSION
};
let generalConfigCache = { ...generalConfigFallback };
let generalConfigRefreshPromise = null;
const smtpConfigFallback = {
  url: SMTP_URL,
  host: SMTP_HOST,
  port: SMTP_PORT,
  secure: SMTP_SECURE,
  user: SMTP_USER,
  pass: SMTP_PASS,
  from: EMAIL_FROM
};
let smtpConfigCache = { ...smtpConfigFallback };
let smtpConfigRefreshPromise = null;

function scheduleGeneralConfigRefresh() {
  if (generalConfigRefreshPromise) return;
  generalConfigRefreshPromise = appSettingsService.getEffectiveGeneralConfig()
    .then((result) => {
      if (result?.config && typeof result.config === 'object') {
        generalConfigCache = {
          appDisplayName: String(result.config.appDisplayName || APP_DISPLAY_NAME).trim() || APP_DISPLAY_NAME,
          appBaseUrl: String(result.config.appBaseUrl || '').trim(),
          registrationEnabled: Boolean(result.config.registrationEnabled),
          userEditRequiresPermission: Boolean(result.config.userEditRequiresPermission)
        };
      }
    })
    .catch(() => {
      // keep fallback cache on read failures
    })
    .finally(() => {
      generalConfigRefreshPromise = null;
    });
}

function scheduleSmtpConfigRefresh() {
  if (smtpConfigRefreshPromise) return;
  smtpConfigRefreshPromise = appSettingsService.getEffectiveSmtpConfig()
    .then((result) => {
      if (result?.config && typeof result.config === 'object') {
        smtpConfigCache = {
          url: String(result.config.url || '').trim(),
          host: String(result.config.host || '').trim(),
          port: Number(result.config.port || SMTP_PORT),
          secure: Boolean(result.config.secure),
          user: String(result.config.user || '').trim(),
          pass: String(result.config.pass || '').trim(),
          from: String(result.config.from || '').trim()
        };
      }
    })
    .catch(() => {
      // keep fallback cache on read failures
    })
    .finally(() => {
      smtpConfigRefreshPromise = null;
    });
}

function getEffectiveGeneralConfig() {
  scheduleGeneralConfigRefresh();
  return generalConfigCache;
}

function getUserEditRequiresPermission() {
  return Boolean(getEffectiveGeneralConfig().userEditRequiresPermission);
}

function getRegistrationEnabled() {
  return Boolean(getEffectiveGeneralConfig().registrationEnabled);
}

function getAppBaseUrl() {
  return String(getEffectiveGeneralConfig().appBaseUrl || '').trim();
}

function getAppDisplayName() {
  return String(getEffectiveGeneralConfig().appDisplayName || 'archimap').trim() || 'archimap';
}

function getEffectiveSmtpConfig() {
  scheduleSmtpConfigRefresh();
  return smtpConfigCache;
}

function applyGeneralSettingsSnapshot(saved) {
  const general = saved?.general;
  if (!general || typeof general !== 'object') return;
  generalConfigCache = {
    appDisplayName: String(general.appDisplayName || APP_DISPLAY_NAME).trim() || APP_DISPLAY_NAME,
    appBaseUrl: String(general.appBaseUrl || '').trim(),
    registrationEnabled: Boolean(general.registrationEnabled),
    userEditRequiresPermission: Boolean(general.userEditRequiresPermission)
  };
}

function applySmtpSettingsSnapshot(saved) {
  const smtp = saved?.smtp;
  if (!smtp || typeof smtp !== 'object') return;
  smtpConfigCache = {
    url: String(smtp.url || '').trim(),
    host: String(smtp.host || '').trim(),
    port: Number(smtp.port || SMTP_PORT),
    secure: Boolean(smtp.secure),
    user: String(smtp.user || '').trim(),
    pass: smtp.keepPassword === false ? '' : String(smtp.pass || smtpConfigCache.pass || '').trim(),
    from: String(smtp.from || '').trim()
  };
}

app.use(jsonMiddleware());

const selectFilterTagKeysFromCache = db.prepare(`
  SELECT tag_key
  FROM filter_tag_keys_cache
  ORDER BY ${DB_PROVIDER === 'postgres' ? 'lower(tag_key), tag_key' : 'tag_key COLLATE NOCASE'}
`);

function scheduleFilterTagKeysCacheRebuild(reason = 'manual') {
  if (filterTagKeysRebuildInProgress) {
    queuedFilterTagKeysRebuildReason = reason;
    return;
  }

  filterTagKeysRebuildInProgress = true;
  logger.info('filter_tags_rebuild_started', { reason });
  const child = spawn(process.execPath, [filterTagKeysRebuildScriptPath], {
    cwd: __dirname,
    env: {
      ...process.env,
      DB_PROVIDER,
      FILTER_TAG_KEYS_REBUILD_REASON: reason,
      ...(DB_PROVIDER === 'sqlite'
        ? {
          ARCHIMAP_DB_PATH: dbPath,
          OSM_DB_PATH: osmDbPath
        }
        : {})
    },
    stdio: 'inherit'
  });
  currentFilterTagKeysRebuildChild = child;

  child.on('error', (error) => {
    currentFilterTagKeysRebuildChild = null;
    filterTagKeysRebuildInProgress = false;
    logger.error('filter_tags_rebuild_start_failed', { reason, error: String(error.message || error) });
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
      logger.info('filter_tags_rebuild_stopped', { reason: 'shutdown' });
      return;
    }
    if (code === 0) {
      filterTagKeysCache = { keys: null, loadedAt: 0 };
      logger.info('filter_tags_rebuild_finished', { reason });
    } else {
      logger.error('filter_tags_rebuild_failed', { reason, code });
    }
    if (queuedFilterTagKeysRebuildReason) {
      const nextReason = queuedFilterTagKeysRebuildReason;
      queuedFilterTagKeysRebuildReason = null;
      scheduleFilterTagKeysCacheRebuild(nextReason);
    }
  });
}

async function getFilterTagKeysCached() {
  const now = Date.now();
  const ttlMs = 5 * 60 * 1000;
  if (Array.isArray(filterTagKeysCache.keys) && (now - filterTagKeysCache.loadedAt) < ttlMs) {
    return filterTagKeysCache.keys;
  }
  const cachedKeys = (await selectFilterTagKeysFromCache.all())
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

applySecurityHeadersMiddleware(app, {
  nodeEnv: NODE_ENV,
  cspConnectOrigins: runtimeEnv.cspConnectSrcExtra,
  cspScriptHashes: CSP_SCRIPT_HASHES
});
initObservabilityInfra(app, {
  logger,
  requestIdFactory: () => logger.requestId(),
  metricsEnabled: METRICS_ENABLED,
  getVersionInfo: getAppVersion,
  getReadinessChecks: () => ({
    sessionStoreReady: Boolean(sessionMiddleware),
    dbReady: dbRuntimeReady
  })
});

app.use((req, res, next) => {
  if (!dbRuntimeReady) {
    return res.status(503).json({ error: 'Сервис инициализируется, попробуйте ещё раз' });
  }
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

async function attachInfoToFeatures(features, options = {}) {
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
    const rows = await db.prepare(`
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
    await mergePersonalEditsIntoFeatureInfo(features, actorKey);
  }

  return features;
}

async function requireAuth(req, res, next) {
  if (!req.session || !req.session.user) {
    return res.status(401).json({ error: 'Требуется авторизация' });
  }
  const email = String(req.session.user.email || '').trim().toLowerCase();
  if (!email) {
    return res.status(401).json({ error: 'Требуется авторизация' });
  }
  const row = await db.prepare('SELECT email, can_edit, is_admin, is_master_admin, first_name, last_name FROM auth.users WHERE email = ?').get(email);
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
    canEditBuildings: isAdmin ? true : (getUserEditRequiresPermission() ? canEdit : true),
    firstName: row.first_name == null ? null : String(row.first_name),
    lastName: row.last_name == null ? null : String(row.last_name)
  };
  return next();
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

async function requireBuildingEditPermission(req, res, next) {
  if (!req.session?.user) {
    return res.status(401).json({ error: 'Требуется авторизация' });
  }

  if (isAdminRequest(req)) return next();
  if (!getUserEditRequiresPermission()) return next();

  const email = String(req.session.user.email || '').trim().toLowerCase();
  if (!email) {
    return res.status(403).json({ error: 'Редактирование недоступно для этой учетной записи' });
  }

  const row = await db.prepare('SELECT can_edit, is_admin FROM auth.users WHERE email = ?').get(email);
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

async function getSearchIndexCountsSnapshot() {
  return await db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM osm.building_contours) AS contours_count,
      (SELECT COUNT(*) FROM building_search_source) AS search_source_count,
      (SELECT COUNT(*) FROM building_search_fts) AS search_fts_count
  `).get();
}

async function getSearchRebuildDecision() {
  const countsSnapshot = await getSearchIndexCountsSnapshot();
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

async function flushDeferredSearchRefreshes() {
  if (pendingSearchIndexRefreshes.size === 0) return;
  const pending = Array.from(pendingSearchIndexRefreshes);
  pendingSearchIndexRefreshes.clear();
  logger.info('search_deferred_refreshes_applied', { pending: pending.length });
  for (const key of pending) {
    const [osmType, osmIdRaw] = String(key).split('/');
    const osmId = Number(osmIdRaw);
    if (['way', 'relation'].includes(osmType) && Number.isInteger(osmId)) {
      await refreshSearchIndexForBuilding(osmType, osmId, { force: true });
    }
  }
}

function maybeRunQueuedSearchRebuild() {
  if (!queuedSearchIndexRebuildReason) return;
  const nextReason = queuedSearchIndexRebuildReason;
  queuedSearchIndexRebuildReason = null;
  rebuildSearchIndex(nextReason).catch((error) => {
    logger.error('search_rebuild_run_failed', { reason: nextReason, error: String(error?.message || error) });
  });
}

function enqueueSearchIndexRefresh(osmType, osmId) {
  setImmediate(async () => {
    try {
      await refreshSearchIndexForBuilding(osmType, osmId);
    } catch (error) {
      logger.error('search_incremental_refresh_failed', { osmType, osmId, error: String(error.message || error) });
    }
  });
}

async function rebuildSearchIndex(reason = 'manual', options = {}) {
  const force = Boolean(options.force);
  if (searchIndexRebuildInProgress) {
    queuedSearchIndexRebuildReason = reason;
    logger.info('search_rebuild_queued', { reason });
    return;
  }

  if (!force) {
    const decision = await getSearchRebuildDecision();
    if (!decision.shouldRebuild) {
      logger.info('search_rebuild_skipped', { reason, details: decision.reason });
      return;
    }
    logger.info('search_rebuild_required', { reason, details: decision.reason });
  }

  const startedAt = Date.now();
  searchIndexRebuildInProgress = true;
  logger.info('search_rebuild_started', { reason, batchSize: SEARCH_INDEX_BATCH_SIZE });

  const child = spawn(process.execPath, [searchRebuildScriptPath], {
    cwd: __dirname,
    env: {
      ...process.env,
      DB_PROVIDER,
      SEARCH_REBUILD_REASON: reason,
      SEARCH_INDEX_BATCH_SIZE: String(SEARCH_INDEX_BATCH_SIZE),
      ...(DB_PROVIDER === 'sqlite'
        ? {
          ARCHIMAP_DB_PATH: dbPath,
          OSM_DB_PATH: osmDbPath,
          LOCAL_EDITS_DB_PATH: localEditsDbPath
        }
        : {})
    },
    stdio: 'inherit'
  });
  currentSearchRebuildChild = child;

  child.on('error', (error) => {
    currentSearchRebuildChild = null;
    searchIndexRebuildInProgress = false;
    logger.error('search_rebuild_start_failed', { reason, error: String(error.message || error) });
    flushDeferredSearchRefreshes().catch(() => {});
    maybeRunQueuedSearchRebuild();
  });

  child.on('close', (code, signal) => {
    currentSearchRebuildChild = null;
    searchIndexRebuildInProgress = false;

    if (shuttingDown && (signal === 'SIGTERM' || signal === 'SIGINT')) {
      logger.info('search_rebuild_stopped', { reason: 'shutdown' });
      return;
    }
    if (code === 0) {
      logger.info('search_rebuild_finished', { reason, durationMs: Date.now() - startedAt });
    } else {
      logger.error('search_rebuild_failed', { reason, code });
    }

    flushDeferredSearchRefreshes().catch(() => {});
    maybeRunQueuedSearchRebuild();
  });
}

async function refreshSearchIndexForBuilding(osmType, osmId, options = {}) {
  const force = Boolean(options.force);
  if (!force && searchIndexRebuildInProgress) {
    pendingSearchIndexRefreshes.add(`${osmType}/${osmId}`);
    return;
  }
  const row = db.provider === 'postgres'
    ? await db.prepare(`
    SELECT
      bc.osm_type || '/' || bc.osm_id AS osm_key,
      bc.osm_type AS osm_type,
      bc.osm_id AS osm_id,
      NULLIF(trim(coalesce(
        ai.name,
        CASE WHEN bc.tags_json ~ '^\\s*\\{' THEN bc.tags_json::jsonb->>'name' ELSE NULL END,
        CASE WHEN bc.tags_json ~ '^\\s*\\{' THEN bc.tags_json::jsonb->>'name:ru' ELSE NULL END,
        CASE WHEN bc.tags_json ~ '^\\s*\\{' THEN bc.tags_json::jsonb->>'official_name' ELSE NULL END,
        ''
      )), '') AS name,
      NULLIF(trim(coalesce(
        ai.address,
        CASE WHEN bc.tags_json ~ '^\\s*\\{' THEN bc.tags_json::jsonb->>'addr:full' ELSE NULL END,
        trim(
          coalesce(CASE WHEN bc.tags_json ~ '^\\s*\\{' THEN bc.tags_json::jsonb->>'addr:postcode' ELSE NULL END || ', ', '') ||
          coalesce(CASE WHEN bc.tags_json ~ '^\\s*\\{' THEN bc.tags_json::jsonb->>'addr:city' ELSE NULL END || ', ', '') ||
          coalesce(CASE WHEN bc.tags_json ~ '^\\s*\\{' THEN bc.tags_json::jsonb->>'addr:place' ELSE NULL END || ', ', '') ||
          coalesce(CASE WHEN bc.tags_json ~ '^\\s*\\{' THEN bc.tags_json::jsonb->>'addr:street' ELSE NULL END, '') ||
          CASE
            WHEN nullif(trim(CASE WHEN bc.tags_json ~ '^\\s*\\{' THEN bc.tags_json::jsonb->>'addr:housenumber' ELSE NULL END), '') IS NOT NULL
            THEN ', ' || (CASE WHEN bc.tags_json ~ '^\\s*\\{' THEN bc.tags_json::jsonb->>'addr:housenumber' ELSE NULL END)
            ELSE ''
          END
        )
      )), '') AS address,
      NULLIF(trim(coalesce(
        ai.style,
        CASE WHEN bc.tags_json ~ '^\\s*\\{' THEN bc.tags_json::jsonb->>'building:architecture' ELSE NULL END,
        CASE WHEN bc.tags_json ~ '^\\s*\\{' THEN bc.tags_json::jsonb->>'architecture' ELSE NULL END,
        CASE WHEN bc.tags_json ~ '^\\s*\\{' THEN bc.tags_json::jsonb->>'style' ELSE NULL END,
        ''
      )), '') AS style,
      NULLIF(trim(coalesce(
        ai.architect,
        CASE WHEN bc.tags_json ~ '^\\s*\\{' THEN bc.tags_json::jsonb->>'architect' ELSE NULL END,
        CASE WHEN bc.tags_json ~ '^\\s*\\{' THEN bc.tags_json::jsonb->>'architect_name' ELSE NULL END,
        ''
      )), '') AS architect,
      CASE WHEN ai.osm_id IS NOT NULL THEN 1 ELSE 0 END AS local_priority,
      (bc.min_lon + bc.max_lon) / 2.0 AS center_lon,
      (bc.min_lat + bc.max_lat) / 2.0 AS center_lat
    FROM osm.building_contours bc
    LEFT JOIN local.architectural_info ai
      ON ai.osm_type = bc.osm_type AND ai.osm_id = bc.osm_id
    WHERE bc.osm_type = ? AND bc.osm_id = ?
  `).get(osmType, osmId)
    : await db.prepare(`
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
    FROM osm.building_contours bc
    LEFT JOIN local.architectural_info ai
      ON ai.osm_type = bc.osm_type AND ai.osm_id = bc.osm_id
    WHERE bc.osm_type = ? AND bc.osm_id = ?
  `).get(osmType, osmId);

  const osmKey = `${osmType}/${osmId}`;
  if (!row) {
    await db.prepare(`DELETE FROM building_search_source WHERE osm_key = ?`).run(osmKey);
    await db.prepare(`DELETE FROM building_search_fts WHERE osm_key = ?`).run(osmKey);
    return;
  }

  await db.prepare(`
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

  await db.prepare(`DELETE FROM building_search_fts WHERE osm_key = ?`).run(row.osm_key);
  await db.prepare(`
    INSERT INTO building_search_fts (osm_key, name, address, style, architect)
    VALUES (?, ?, ?, ?, ?)
  `).run(row.osm_key, row.name || '', row.address || '', row.style || '', row.architect || '');
}

async function getBuildingSearchResults(queryText, centerLon, centerLat, limit = 30, cursor = 0) {
  return searchService.getBuildingSearchResults(queryText, centerLon, centerLat, limit, cursor);
}

registerAuthRoutes({
  app,
  db,
  createSimpleRateLimiter,
  logger,
  sessionSecret: SESSION_SECRET,
  userEditRequiresPermission: USER_EDIT_REQUIRES_PERMISSION,
  getUserEditRequiresPermission,
  registrationEnabled: REGISTRATION_ENABLED,
  getRegistrationEnabled,
  registrationCodeTtlMinutes: REGISTRATION_CODE_TTL_MINUTES,
  registrationCodeResendCooldownSec: REGISTRATION_CODE_RESEND_COOLDOWN_SEC,
  registrationCodeMaxAttempts: REGISTRATION_CODE_MAX_ATTEMPTS,
  registrationMinPasswordLength: REGISTRATION_MIN_PASSWORD_LENGTH,
  passwordResetTtlMinutes: PASSWORD_RESET_TTL_MINUTES,
  appBaseUrl: APP_BASE_URL,
  getAppBaseUrl,
  appDisplayName: APP_DISPLAY_NAME,
  getAppDisplayName,
  getSmtpConfig: getEffectiveSmtpConfig,
});

registerAppRoutes({
  app,
  publicApiRateLimiter,
  rootDir: __dirname,
  buildingsPmtilesPath,
  normalizeMapConfig,
  getBuildInfo,
  getAppVersion,
  registrationEnabled: REGISTRATION_ENABLED,
  getRegistrationEnabled,
  buildingsPmtilesSourceLayer: BUILDINGS_PMTILES_SOURCE_LAYER,
  getFilterTagKeysCached,
  isFilterTagKeysRebuildInProgress: () => filterTagKeysRebuildInProgress
});

registerAdminRoutes({
  app,
  db,
  adminApiRateLimiter,
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
  appSettingsService,
  onGeneralSettingsSaved: applyGeneralSettingsSnapshot,
  onSmtpSettingsSaved: applySmtpSettingsSnapshot,
  appDisplayName: APP_DISPLAY_NAME,
  getAppDisplayName,
  appBaseUrl: APP_BASE_URL,
  getAppBaseUrl,
  registrationCodeTtlMinutes: REGISTRATION_CODE_TTL_MINUTES,
  passwordResetTtlMinutes: PASSWORD_RESET_TTL_MINUTES
});

registerBuildingsRoutes({
  app,
  db,
  rtreeState,
  buildingsReadRateLimiter,
  buildingsWriteRateLimiter,
  filterDataRateLimiter,
  filterDataBboxRateLimiter,
  filterMatchesRateLimiter,
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
  accountReadRateLimiter,
  requireAuth,
  getSessionEditActorKey,
  normalizeUserEditStatus,
  getUserEditsList,
  getUserEditDetailsById
});

registerContoursStatusRoute(app, db, contoursStatusRateLimiter);
registerErrorHandlers(app, { logger, nodeEnv: NODE_ENV });
syncWorkers = initSyncWorkersInfra({
  spawn,
  processExecPath: process.execPath,
  syncScriptPath,
  cwd: __dirname,
  env: {
    ...process.env,
    DB_PROVIDER
  },
  autoSyncEnabled: AUTO_SYNC_ENABLED,
  autoSyncOnStart: AUTO_SYNC_ON_START,
  autoSyncIntervalHours: AUTO_SYNC_INTERVAL_HOURS,
  buildingsPmtilesPath,
  isShuttingDown: () => shuttingDown,
  getContoursTotal: async () => Number((await db.prepare('SELECT COUNT(*) AS total FROM osm.building_contours').get())?.total || 0),
  onSyncSuccess: async () => {
    if (!fs.existsSync(buildingsPmtilesPath)) {
      logger.warn('pmtiles_missing_after_sync', { path: buildingsPmtilesPath });
      syncWorkers?.runPmtilesBuild?.('post-sync-missing');
    }
    await rebuildSearchIndex('auto-sync');
    filterTagKeysCache = { keys: null, loadedAt: 0 };
    scheduleFilterTagKeysCacheRebuild('auto-sync');
  }
});

let runtimeInitPromise = null;
let startupTasksScheduled = false;
let stopRuntimePromise = null;

function runStartupTasksOnce() {
  if (startupTasksScheduled) return;
  startupTasksScheduled = true;
  Promise.resolve(dbRuntimePromise)
    .then(() => {
      scheduleGeneralConfigRefresh();
      scheduleSmtpConfigRefresh();
      rebuildSearchIndex('startup').catch((error) => {
        logger.error('search_rebuild_startup_failed', { error: String(error?.message || error) });
      });
      scheduleFilterTagKeysCacheRebuild('startup');
      if (syncWorkers) {
        Promise.resolve(syncWorkers.initAutoSync()).catch((error) => {
          logger.error('auto_sync_init_failed', { error: String(error?.message || error) });
        });
      }
      if (!rtreeState.ready) {
        scheduleBuildingContoursRtreeRebuild('startup');
      }
    })
    .catch((error) => {
      logger.error('startup_tasks_wait_db_failed', { error: String(error?.message || error) });
    });
}

function initializeRuntime() {
  if (runtimeInitPromise) return runtimeInitPromise;
  runtimeInitPromise = initSessionStore({
    sessionSecret: SESSION_SECRET,
    nodeEnv: NODE_ENV,
    sessionCookieSecure: SESSION_COOKIE_SECURE,
    redisUrl: REDIS_URL,
    sessionAllowMemoryFallback: SESSION_ALLOW_MEMORY_FALLBACK,
    maxAgeMs: 1000 * 60 * 60 * 24 * 30,
    logger
  })
    .then((middleware) => {
      sessionMiddleware = middleware;
      validateSecurityConfig({
        nodeEnv: NODE_ENV,
        sessionSecret: SESSION_SECRET,
        appBaseUrl: APP_BASE_URL,
        sessionAllowMemoryFallback: SESSION_ALLOW_MEMORY_FALLBACK
      });
      return middleware;
    })
    .catch((error) => {
      runtimeInitPromise = null;
      throw error;
    });
  return runtimeInitPromise;
}

async function startHttpServer() {
  await initializeRuntime();
  if (httpServer) return httpServer;

  await new Promise((resolve, reject) => {
    const server = app.listen(PORT, HOST, () => {
      httpServer = server;
      logger.info('server_started', {
        localUrl: `http://localhost:${PORT}`,
        networkUrl: `http://${HOST}:${PORT}`,
        nodeEnv: NODE_ENV
      });
      resolve();
    });
    server.once('error', reject);
  });

  runStartupTasksOnce();
  return httpServer;
}

async function prepareRuntime() {
  await initializeRuntime();
  runStartupTasksOnce();
  return app;
}

function stopRuntime(signal = 'manual') {
  if (stopRuntimePromise) return stopRuntimePromise;
  stopRuntimePromise = (async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('server_shutdown_started', { signal });

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
      await new Promise((resolve) => {
        httpServer.close(() => {
          logger.info('server_shutdown_complete');
          resolve();
        });
      });
      httpServer = null;
    }
    await closeDbRuntime();
  })().finally(() => {
    stopRuntimePromise = null;
  });
  return stopRuntimePromise;
}

function shutdown(signal) {
  stopRuntime(signal)
    .then(() => {
      process.exit(0);
    })
    .catch((error) => {
      logger.error('server_shutdown_failed', { error: String(error?.message || error) });
      process.exit(1);
    });

  setTimeout(() => {
    logger.error('server_shutdown_forced_timeout');
    process.exit(1);
  }, 10000).unref();
}

if (require.main === module) {
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  startHttpServer()
    .catch((error) => {
      logger.error('server_session_store_init_failed', { error: String(error.message || error) });
      process.exit(1);
    });
}

module.exports = {
  app,
  initializeRuntime,
  prepareRuntime,
  startHttpServer,
  stopRuntime
};




