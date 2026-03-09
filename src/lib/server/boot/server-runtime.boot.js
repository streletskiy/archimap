const path = require('path');
const { spawn } = require('child_process');
const { ensureAuthSchema, registerAuthRoutes } = require('../auth');
const { createSimpleRateLimiter } = require('../services/rate-limiter.service');
const { createSearchService } = require('../services/search.service');
const { createBuildingEditsService } = require('../services/building-edits.service');
const { createAppSettingsService } = require('../services/app-settings.service');
const {
  DEFAULT_FILTER_TAG_ALLOWLIST,
  normalizeFilterTagKeyList,
  normalizeFilterTagKey
} = require('../services/filter-tags.service');
const { createDataSettingsService } = require('../services/data-settings.service');
const { requireCsrfSession } = require('../services/csrf.service');
const { createLogger } = require('../services/logger.service');
const {
  normalizeUserEditStatus,
  sanitizeFieldText,
  sanitizeYearBuilt,
  sanitizeLevels,
  sanitizeArchiPayload,
  sanitizeEditedFields
} = require('../services/edits.service');
const { validateSecurityConfig } = require('../infra/security-config.infra');
const { collectInlineScriptHashesFromFile } = require('../infra/csp.infra');
const { parseRuntimeEnv } = require('../infra/env.infra');
const { applySecurityHeadersMiddleware } = require('../infra/security-headers.infra');
const { registerErrorHandlers } = require('../infra/error-handling.infra');
const { initSessionStore } = require('../infra/session-store.infra');
const { initSyncWorkersInfra } = require('../infra/sync-workers.infra');
const { initObservabilityInfra } = require('../infra/observability.infra');
const { registerContoursStatusRoute } = require('../http/contours-status.route');
const { registerAppRoutes } = require('../http/app.route');
const { registerAdminRoutes } = require('../http/admin.route');
const { registerBuildingsRoutes } = require('../http/buildings.route');
const { registerSearchRoutes } = require('../http/search.route');
const { registerAccountRoutes } = require('../http/account.route');
const { createAuthMiddlewareSupport } = require('../http/auth-middleware.http');
const { createFeatureInfoSupport } = require('../http/feature-info.http');
const { createMiniApp, jsonMiddleware } = require('../infra/mini-app.infra');
const { getAppVersion, getBuildInfo } = require('../version');
const {
  registrationCodeHtmlTemplate,
  registrationCodeTextTemplate,
  passwordResetHtmlTemplate,
  passwordResetTextTemplate
} = require('../email-templates');
const { createRateLimiters } = require('./rate-limiters.boot');
const { createRuntimeSettingsBoot } = require('./runtime-settings.boot');
const { createDbRuntimeBoot } = require('./db-runtime.boot');
const { createFilterTagKeysBoot } = require('./filter-tag-keys.boot');
const { createSearchIndexBoot } = require('./search-index.boot');
const { createRegionPmtilesBoot } = require('./region-pmtiles.boot');

function createServerRuntime(options = {}) {
  const rootDir = path.resolve(options.rootDir || path.join(__dirname, '..', '..', '..', '..'));
  const rawEnv = options.rawEnv || process.env;
  const processRef = options.processRef || process;

  const app = createMiniApp();
  app.disable('x-powered-by');

  const runtimeEnv = parseRuntimeEnv(rawEnv);
  const PORT = runtimeEnv.port;
  const HOST = runtimeEnv.host;
  const NODE_ENV = runtimeEnv.nodeEnv;
  const DB_PROVIDER = runtimeEnv.dbProvider;
  const TRUST_PROXY = String(rawEnv.TRUST_PROXY ?? 'false').toLowerCase() === 'true';
  if (TRUST_PROXY) {
    app.set('trust proxy', 1);
  }
  const SESSION_SECRET = runtimeEnv.sessionSecret;
  const SESSION_ALLOW_MEMORY_FALLBACK = String(rawEnv.SESSION_ALLOW_MEMORY_FALLBACK ?? (NODE_ENV === 'production' ? 'false' : 'true')).toLowerCase() === 'true';
  const SESSION_COOKIE_SECURE_RAW = String(rawEnv.SESSION_COOKIE_SECURE || '').trim().toLowerCase();
  const SESSION_COOKIE_SECURE = SESSION_COOKIE_SECURE_RAW === 'true'
    ? true
    : (SESSION_COOKIE_SECURE_RAW === 'false'
      ? false
      : (NODE_ENV === 'production'));
  const AUTO_SYNC_ENABLED = String(rawEnv.AUTO_SYNC_ENABLED ?? 'true').toLowerCase() === 'true';
  const AUTO_SYNC_ON_START = String(rawEnv.AUTO_SYNC_ON_START ?? 'true').toLowerCase() === 'true';
  const AUTO_SYNC_INTERVAL_HOURS = Number(rawEnv.AUTO_SYNC_INTERVAL_HOURS || 168);
  const REDIS_URL = rawEnv.REDIS_URL || 'redis://redis:6379';
  const MAP_DEFAULT_LON = Number(rawEnv.MAP_DEFAULT_LON ?? 44.0059);
  const MAP_DEFAULT_LAT = Number(rawEnv.MAP_DEFAULT_LAT ?? 56.3269);
  const MAP_DEFAULT_ZOOM = Number(rawEnv.MAP_DEFAULT_ZOOM ?? 15);
  const BUILDINGS_PMTILES_SOURCE_LAYER = String(rawEnv.BUILDINGS_PMTILES_SOURCE_LAYER || 'buildings').trim() || 'buildings';
  const BUILDINGS_PMTILES_MIN_ZOOM = Math.max(0, Math.min(22, Number(rawEnv.BUILDINGS_PMTILES_MIN_ZOOM || 13)));
  const BUILDINGS_PMTILES_MAX_ZOOM = Math.max(BUILDINGS_PMTILES_MIN_ZOOM, Math.min(22, Number(rawEnv.BUILDINGS_PMTILES_MAX_ZOOM || 16)));
  const SMTP_URL = String(rawEnv.SMTP_URL || '').trim();
  const SMTP_HOST = String(rawEnv.SMTP_HOST || '').trim();
  const SMTP_PORT = Number(rawEnv.SMTP_PORT || 587);
  const SMTP_SECURE = String(rawEnv.SMTP_SECURE || 'false').toLowerCase() === 'true';
  const SMTP_USER = String(rawEnv.SMTP_USER || '').trim();
  const SMTP_PASS = String(rawEnv.SMTP_PASS || '').trim();
  const EMAIL_FROM = String(rawEnv.EMAIL_FROM || SMTP_USER || '').trim();
  const APP_SETTINGS_SECRET = String(rawEnv.APP_SETTINGS_SECRET || SESSION_SECRET).trim() || SESSION_SECRET;
  const APP_BASE_URL = runtimeEnv.appBaseUrl;
  const USER_EDIT_REQUIRES_PERMISSION = String(rawEnv.USER_EDIT_REQUIRES_PERMISSION ?? 'true').toLowerCase() === 'true';
  const REGISTRATION_ENABLED = String(rawEnv.REGISTRATION_ENABLED ?? 'true').toLowerCase() === 'true';
  const REGISTRATION_CODE_TTL_MINUTES = Math.max(2, Math.min(60, Number(rawEnv.REGISTRATION_CODE_TTL_MINUTES || 15)));
  const REGISTRATION_CODE_RESEND_COOLDOWN_SEC = Math.max(10, Math.min(600, Number(rawEnv.REGISTRATION_CODE_RESEND_COOLDOWN_SEC || 60)));
  const REGISTRATION_CODE_MAX_ATTEMPTS = Math.max(3, Math.min(12, Number(rawEnv.REGISTRATION_CODE_MAX_ATTEMPTS || 6)));
  const REGISTRATION_MIN_PASSWORD_LENGTH = Math.max(8, Math.min(72, Number(rawEnv.REGISTRATION_MIN_PASSWORD_LENGTH || 8)));
  const PASSWORD_RESET_TTL_MINUTES = Math.max(5, Math.min(180, Number(rawEnv.PASSWORD_RESET_TTL_MINUTES || 60)));
  const APP_DISPLAY_NAME = String(rawEnv.APP_DISPLAY_NAME || 'archimap').trim() || 'archimap';
  const LOG_LEVEL = String(rawEnv.LOG_LEVEL || 'info').trim().toLowerCase() || 'info';
  const METRICS_ENABLED = String(rawEnv.METRICS_ENABLED ?? 'true').toLowerCase() === 'true';
  const FRONTEND_INDEX_PATH = path.join(rootDir, 'frontend', 'build', 'index.html');
  const CSP_SCRIPT_HASHES = collectInlineScriptHashesFromFile(FRONTEND_INDEX_PATH);

  const dataDir = path.join(rootDir, 'data');
  const dbPath = String(
    rawEnv.DATABASE_PATH
    || rawEnv.ARCHIMAP_DB_PATH
    || runtimeEnv.sqliteUrl
    || path.join(dataDir, 'archimap.db')
  ).trim() || path.join(dataDir, 'archimap.db');
  const osmDbPath = String(rawEnv.OSM_DB_PATH || path.join(dataDir, 'osm.db')).trim() || path.join(dataDir, 'osm.db');
  const localEditsDbPath = rawEnv.LOCAL_EDITS_DB_PATH || path.join(dataDir, 'local-edits.db');
  const userEditsDbPath = rawEnv.USER_EDITS_DB_PATH || path.join(dataDir, 'user-edits.db');
  const userAuthDbPath = String(rawEnv.USER_AUTH_DB_PATH || path.join(dataDir, 'users.db')).trim() || path.join(dataDir, 'users.db');
  const syncRegionScriptPath = path.join(rootDir, 'scripts', 'sync-osm-region.js');
  const searchRebuildScriptPath = path.join(rootDir, 'workers', 'rebuild-search-index.worker.js');
  const filterTagKeysRebuildScriptPath = path.join(rootDir, 'workers', 'rebuild-filter-tag-keys-cache.worker.js');
  const SEARCH_INDEX_BATCH_SIZE = Math.max(200, Math.min(20000, Number(rawEnv.SEARCH_INDEX_BATCH_SIZE || 2500)));
  const logger = createLogger({ level: LOG_LEVEL, service: 'archimap-server' });

  let sessionMiddleware = null;
  let httpServer = null;
  let shuttingDown = false;
  let syncWorkers = null;
  let runtimeInitPromise = null;
  let startupTasksScheduled = false;
  let stopRuntimePromise = null;
  let signalHandlersRegistered = false;

  function normalizeMapConfig() {
    const lon = Number.isFinite(MAP_DEFAULT_LON) ? Math.min(180, Math.max(-180, MAP_DEFAULT_LON)) : 44.0059;
    const lat = Number.isFinite(MAP_DEFAULT_LAT) ? Math.min(90, Math.max(-90, MAP_DEFAULT_LAT)) : 56.3269;
    const zoom = Number.isFinite(MAP_DEFAULT_ZOOM) ? Math.min(22, Math.max(0, MAP_DEFAULT_ZOOM)) : 15;
    return { lon, lat, zoom };
  }

  const {
    searchRateLimiter,
    publicApiRateLimiter,
    accountReadRateLimiter,
    adminApiRateLimiter,
    filterDataRateLimiter,
    filterDataBboxRateLimiter,
    filterMatchesRateLimiter,
    buildingsReadRateLimiter,
    buildingsWriteRateLimiter,
    contoursStatusRateLimiter
  } = createRateLimiters({
    createSimpleRateLimiter
  });

  const RTREE_REBUILD_BATCH_SIZE = Math.max(500, Math.min(20000, Number(rawEnv.RTREE_REBUILD_BATCH_SIZE || 4000)));
  const RTREE_REBUILD_PAUSE_MS = Math.max(0, Math.min(200, Number(rawEnv.RTREE_REBUILD_PAUSE_MS || 8)));
  const {
    db,
    dbRuntimePromise,
    closeDbRuntime,
    rtreeState,
    isDbRuntimeReady,
    scheduleBuildingContoursRtreeRebuild
  } = createDbRuntimeBoot({
    runtimeEnv,
    rawEnv,
    provider: DB_PROVIDER,
    sqlite: {
      dbPath,
      osmDbPath,
      localEditsDbPath,
      userEditsDbPath,
      userAuthDbPath,
      ensureAuthSchema,
      rtreeRebuildBatchSize: RTREE_REBUILD_BATCH_SIZE,
      rtreeRebuildPauseMs: RTREE_REBUILD_PAUSE_MS,
      isSyncInProgress: () => syncWorkers?.isSyncInProgress?.() || false
    },
    postgres: {},
    logger
  });

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

  const dataSettingsService = createDataSettingsService({
    db,
    dataDir,
    fallbackData: {
      autoSyncEnabled: AUTO_SYNC_ENABLED,
      autoSyncOnStart: AUTO_SYNC_ON_START,
      autoSyncIntervalHours: AUTO_SYNC_INTERVAL_HOURS,
      pmtilesMinZoom: BUILDINGS_PMTILES_MIN_ZOOM,
      pmtilesMaxZoom: BUILDINGS_PMTILES_MAX_ZOOM,
      sourceLayer: BUILDINGS_PMTILES_SOURCE_LAYER
    }
  });

  const {
    getUserEditRequiresPermission,
    getRegistrationEnabled,
    getAppBaseUrl,
    getAppDisplayName,
    getEffectiveSmtpConfig,
    getEffectiveFilterTagAllowlist,
    applyGeneralSettingsSnapshot,
    applySmtpSettingsSnapshot,
    applyFilterTagAllowlistSnapshot,
    refreshRuntimeSettings
  } = createRuntimeSettingsBoot({
    appSettingsService,
    dataSettingsService,
    defaults: {
      appDisplayName: APP_DISPLAY_NAME,
      appBaseUrl: APP_BASE_URL,
      registrationEnabled: REGISTRATION_ENABLED,
      userEditRequiresPermission: USER_EDIT_REQUIRES_PERMISSION,
      smtpUrl: SMTP_URL,
      smtpHost: SMTP_HOST,
      smtpPort: SMTP_PORT,
      smtpSecure: SMTP_SECURE,
      smtpUser: SMTP_USER,
      smtpPass: SMTP_PASS,
      emailFrom: EMAIL_FROM
    },
    filterTags: {
      defaultAllowlist: DEFAULT_FILTER_TAG_ALLOWLIST,
      normalizeFilterTagKeyList
    }
  });

  const {
    scheduleFilterTagKeysCacheRebuild,
    getAllFilterTagKeysCached,
    getFilterTagKeysCached,
    isFilterTagAllowed,
    resetFilterTagKeysCache,
    stop: stopFilterTagKeysBoot,
    isFilterTagKeysRebuildInProgress
  } = createFilterTagKeysBoot({
    db,
    dbProvider: DB_PROVIDER,
    logger,
    spawn,
    processExecPath: processRef.execPath,
    rootDir,
    filterTagKeysRebuildScriptPath,
    env: rawEnv,
    sqlite: {
      dbPath,
      osmDbPath
    },
    getEffectiveFilterTagAllowlist,
    normalizeFilterTagKey,
    isShuttingDown: () => shuttingDown
  });

  const {
    rebuildSearchIndex,
    enqueueSearchIndexRefresh,
    stop: stopSearchIndexBoot,
    isSearchIndexRebuildInProgress
  } = createSearchIndexBoot({
    db,
    dbProvider: DB_PROVIDER,
    logger,
    spawn,
    processExecPath: processRef.execPath,
    rootDir,
    searchRebuildScriptPath,
    batchSize: SEARCH_INDEX_BATCH_SIZE,
    env: rawEnv,
    sqlite: {
      dbPath,
      osmDbPath,
      localEditsDbPath
    },
    isShuttingDown: () => shuttingDown
  });

  const {
    migrateRegionPmtilesFile,
    removeRegionPmtilesFiles
  } = createRegionPmtilesBoot({
    dataDir,
    logger
  });

  app.use(jsonMiddleware());

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
      dbReady: isDbRuntimeReady()
    })
  });

  app.use((req, res, next) => {
    if (!isDbRuntimeReady()) {
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
    getOsmContourRow,
    getLatestUserEditRow,
    supersedePendingUserEdits,
    getSessionEditActorKey,
    applyUserEditRowToInfo,
    getUserEditsList,
    getUserEditDetailsById,
    reassignUserEdit,
    deleteUserEdit,
    mergePersonalEditsIntoFeatureInfo,
    applyPersonalEditsToFilterItems
  } = buildingEditsService;

  const {
    rowToFeature,
    attachInfoToFeatures
  } = createFeatureInfoSupport({
    db,
    mergePersonalEditsIntoFeatureInfo
  });

  const {
    requireAuth,
    requireAdmin,
    requireBuildingEditPermission
  } = createAuthMiddlewareSupport({
    db,
    getUserEditRequiresPermission
  });

  const searchService = createSearchService({
    db,
    defaultLon: MAP_DEFAULT_LON,
    defaultLat: MAP_DEFAULT_LAT,
    isRebuildInProgress: isSearchIndexRebuildInProgress
  });

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
    getSmtpConfig: getEffectiveSmtpConfig
  });

  registerAppRoutes({
    app,
    publicApiRateLimiter,
    rootDir,
    dataDir,
    normalizeMapConfig,
    getBuildInfo,
    getAppVersion,
    registrationEnabled: REGISTRATION_ENABLED,
    getRegistrationEnabled,
    dataSettingsService,
    getFilterTagKeysCached,
    getAllFilterTagKeysCached,
    isFilterTagKeysRebuildInProgress
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
    getOsmContourRow,
    reassignUserEdit,
    deleteUserEdit,
    enqueueSearchIndexRefresh,
    ARCHI_FIELD_SET,
    registrationCodeHtmlTemplate,
    registrationCodeTextTemplate,
    passwordResetHtmlTemplate,
    passwordResetTextTemplate,
    appSettingsService,
    dataSettingsService,
    getAllFilterTagKeysCached,
    applyFilterTagAllowlistSnapshot,
    onGeneralSettingsSaved: applyGeneralSettingsSnapshot,
    onSmtpSettingsSaved: applySmtpSettingsSnapshot,
    onDataRegionsSaved: async ({ action, saved, previous, deleted } = {}) => {
      if (action === 'save') {
        migrateRegionPmtilesFile(previous, saved);
      }
      if (action === 'delete') {
        removeRegionPmtilesFiles(deleted?.region);
        await rebuildSearchIndex(`region-delete:${deleted?.region?.id || 'unknown'}`);
        resetFilterTagKeysCache();
        scheduleFilterTagKeysCacheRebuild(`region-delete:${deleted?.region?.id || 'unknown'}`);
      }
      return syncWorkers?.reloadSchedules?.();
    },
    onRegionSyncRequested: (regionId, options) => syncWorkers?.requestRegionSync?.(regionId, options),
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
    isFilterTagAllowed,
    rowToFeature,
    attachInfoToFeatures,
    applyUserEditRowToInfo,
    getMergedInfoRow,
    getOsmContourRow,
    getLatestUserEditRow,
    normalizeUserEditStatus,
    sanitizeArchiPayload,
    sanitizeEditedFields,
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
    processExecPath: processRef.execPath,
    syncRegionScriptPath,
    cwd: rootDir,
    env: {
      ...rawEnv,
      DB_PROVIDER
    },
    dataSettingsService,
    autoSyncEnabled: AUTO_SYNC_ENABLED,
    autoSyncOnStart: AUTO_SYNC_ON_START,
    autoSyncIntervalHours: AUTO_SYNC_INTERVAL_HOURS,
    isShuttingDown: () => shuttingDown,
    getContoursTotal: async () => Number((await db.prepare('SELECT COUNT(*) AS total FROM osm.building_contours').get())?.total || 0),
    onSyncSuccess: async (payload = null) => {
      const managedRegionSync = Boolean(payload?.region);
      await rebuildSearchIndex(managedRegionSync ? `region-sync:${payload.region.id}` : 'region-sync');
      resetFilterTagKeysCache();
      scheduleFilterTagKeysCacheRebuild(managedRegionSync ? `region-sync:${payload.region.id}` : 'region-sync');
    }
  });

  function runStartupTasksOnce() {
    if (startupTasksScheduled) return;
    startupTasksScheduled = true;
    Promise.resolve(dbRuntimePromise)
      .then(() => {
        refreshRuntimeSettings();
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
      stopSearchIndexBoot();
      stopFilterTagKeysBoot();

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
        processRef.exit(0);
      })
      .catch((error) => {
        logger.error('server_shutdown_failed', { error: String(error?.message || error) });
        processRef.exit(1);
      });

    setTimeout(() => {
      logger.error('server_shutdown_forced_timeout');
      processRef.exit(1);
    }, 10000).unref();
  }

  function registerSignalHandlers() {
    if (signalHandlersRegistered) return;
    signalHandlersRegistered = true;
    processRef.on('SIGTERM', () => shutdown('SIGTERM'));
    processRef.on('SIGINT', () => shutdown('SIGINT'));
  }

  function runAsMain() {
    registerSignalHandlers();
    return startHttpServer()
      .catch((error) => {
        logger.error('server_session_store_init_failed', { error: String(error?.message || error) });
        processRef.exit(1);
      });
  }

  return {
    app,
    initializeRuntime,
    prepareRuntime,
    startHttpServer,
    stopRuntime,
    runAsMain
  };
}

module.exports = {
  createServerRuntime
};
