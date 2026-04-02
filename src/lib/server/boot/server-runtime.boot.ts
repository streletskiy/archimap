const { spawn } = require('child_process');
const { ensureAuthSchema } = require('../auth');
const { createRateLimiterFactory } = require('../services/rate-limiter.service');
const { createSearchService } = require('../services/search.service');
const { createBuildingEditsService } = require('../services/building-edits.service');
const { createAppSettingsService } = require('../services/app-settings.service');
const { createStyleRegionOverridesService } = require('../services/style-region-overrides.service');
const { createOsmSyncService } = require('../services/osm-sync.service');
const {
  DEFAULT_FILTER_TAG_ALLOWLIST,
  normalizeFilterTagKeyList,
  normalizeFilterTagKey
} = require('../services/filter-tags.service');
const { createDataSettingsService } = require('../services/data-settings.service');
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
const { registerErrorHandlers } = require('../infra/error-handling.infra');
const { initSessionStore } = require('../infra/session-store.infra');
const { initSyncWorkersInfra } = require('../infra/sync-workers.infra');
const { createFeatureInfoSupport } = require('../http/feature-info.http');
const { createAuthMiddlewareSupport } = require('../http/auth-middleware.http');
const { createMiniApp } = require('../infra/mini-app.infra');
const { getAppVersion, getBuildInfo } = require('../version');
const { createRateLimiters } = require('./rate-limiters.boot');
const { createRuntimeSettingsBoot } = require('./runtime-settings.boot');
const { createDbRuntimeBoot } = require('./db-runtime.boot');
const { createFilterTagKeysBoot } = require('./filter-tag-keys.boot');
const { createDesignRefSuggestionsBoot } = require('./design-ref-suggestions.boot');
const { createSearchIndexBoot } = require('./search-index.boot');
const { createRegionPmtilesBoot } = require('./region-pmtiles.boot');
const { createServerRuntimeConfig } = require('./server-runtime.config');
const { applyServerRuntimeMiddleware } = require('./server-runtime.middleware');
const { registerServerRuntimeRoutes } = require('./server-runtime.routes');

async function runPostDbStartupTasks(runtime: LooseRecord) {
  runtime.refreshRuntimeSettings();
  try {
    await Promise.resolve(runtime.refreshDesignRefSuggestionsCache?.('startup'));
  } catch (error) {
    runtime.logger.error('design_ref_suggestions_startup_failed', { error: String(error?.message || error) });
  }

  if (runtime.syncWorkers) {
    try {
      await Promise.resolve(runtime.syncWorkers.initAutoSync());
    } catch (error) {
      runtime.logger.error('auto_sync_init_failed', { error: String(error?.message || error) });
    }
  }

  const syncInProgress = Boolean(runtime.syncWorkers?.isSyncInProgress?.());
  if (syncInProgress) {
    runtime.logger.info('search_rebuild_startup_deferred', { reason: 'sync_in_progress' });
  } else {
    runtime.rebuildSearchIndex('startup').catch((error) => {
      runtime.logger.error('search_rebuild_startup_failed', { error: String(error?.message || error) });
    });
  }

  if (!runtime.rtreeState.ready) {
    runtime.scheduleBuildingContoursRtreeRebuild('startup');
  }
}

class ServerRuntime {
  [key: string]: any;

  constructor(options: LooseRecord = {}) {
    this.config = createServerRuntimeConfig(options);
    this.app = createMiniApp();
    this.app.disable('x-powered-by');
    if (this.config.trustProxy) {
      this.app.set('trust proxy', 1);
    }

    // createSimpleRateLimiter is lazily initialized with Redis config
    this.normalizeUserEditStatus = normalizeUserEditStatus;
    this.sanitizeFieldText = sanitizeFieldText;
    this.sanitizeYearBuilt = sanitizeYearBuilt;
    this.sanitizeLevels = sanitizeLevels;
    this.sanitizeArchiPayload = sanitizeArchiPayload;
    this.sanitizeEditedFields = sanitizeEditedFields;
    this.getAppVersion = getAppVersion;
    this.getBuildInfo = getBuildInfo;
    this.logger = createLogger({
      level: this.config.logLevel,
      service: 'archimap-server'
    });

    this.sessionMiddleware = null;
    this.httpServer = null;
    this.shuttingDown = false;
    this.syncWorkers = null;
    this.runtimeInitPromise = null;
    this.startupTasksScheduled = false;
    this.stopRuntimePromise = null;
    this.signalHandlersRegistered = false;

    this.initializeSubsystems();
    applyServerRuntimeMiddleware(this);
    registerServerRuntimeRoutes(this);
    registerErrorHandlers(this.app, {
      logger: this.logger,
      nodeEnv: this.config.nodeEnv
    });
    this.syncWorkers = this.createSyncWorkers();
  }

  initializeSubsystems() {
    const rateLimiterFactory = createRateLimiterFactory({
      redisUrl: this.config.redisUrl,
      logger: this.logger
    });
    this.createSimpleRateLimiter = rateLimiterFactory.createSimpleRateLimiter;

    this.rateLimiters = createRateLimiters({
      createSimpleRateLimiter: this.createSimpleRateLimiter
    });

    const dbRuntime = createDbRuntimeBoot({
      runtimeEnv: this.config.runtimeEnv,
      rawEnv: this.config.rawEnv,
      provider: this.config.dbProvider,
      sqlite: {
        dbPath: this.config.paths.dbPath,
        osmDbPath: this.config.paths.osmDbPath,
        localEditsDbPath: this.config.paths.localEditsDbPath,
        userEditsDbPath: this.config.paths.userEditsDbPath,
        userAuthDbPath: this.config.paths.userAuthDbPath,
        ensureAuthSchema,
        rtreeRebuildBatchSize: this.config.rtreeRebuildBatchSize,
        rtreeRebuildPauseMs: this.config.rtreeRebuildPauseMs,
        isSyncInProgress: () => this.syncWorkers?.isSyncInProgress?.() || false
      },
      postgres: {},
      logger: this.logger
    });
    this.db = dbRuntime.db;
    this.dbRuntimePromise = dbRuntime.dbRuntimePromise;
    this.closeDbRuntime = dbRuntime.closeDbRuntime;
    this.rtreeState = dbRuntime.rtreeState;
    this.isDbRuntimeReady = dbRuntime.isDbRuntimeReady;
    this.scheduleBuildingContoursRtreeRebuild = dbRuntime.scheduleBuildingContoursRtreeRebuild;

    this.appSettingsService = createAppSettingsService({
      db: this.db,
      settingsSecret: String(this.config.rawEnv.APP_SETTINGS_SECRET || this.config.sessionSecret).trim() || this.config.sessionSecret,
      fallbackGeneral: {
        appDisplayName: this.config.appDisplayName,
        appBaseUrl: this.config.appBaseUrl,
        registrationEnabled: this.config.registrationEnabled,
        userEditRequiresPermission: this.config.userEditRequiresPermission,
        basemapProvider: 'carto',
        maptilerApiKey: '',
        customBasemapUrl: '',
        customBasemapApiKey: ''
      },
      fallbackSmtp: {
        url: this.config.smtpUrl,
        host: this.config.smtpHost,
        port: this.config.smtpPort,
        secure: this.config.smtpSecure,
        user: this.config.smtpUser,
        pass: this.config.smtpPass,
        from: String(this.config.rawEnv.EMAIL_FROM || this.config.smtpUser || '').trim()
      }
    });

    this.dataSettingsService = createDataSettingsService({
      db: this.db,
      dataDir: this.config.paths.dataDir,
      fallbackData: {
        autoSyncEnabled: this.config.autoSyncEnabled,
        autoSyncOnStart: this.config.autoSyncOnStart,
        autoSyncIntervalHours: this.config.autoSyncIntervalHours,
        pmtilesMinZoom: this.config.buildingsPmtilesMinZoom,
        pmtilesMaxZoom: this.config.buildingsPmtilesMaxZoom,
        sourceLayer: this.config.buildingsPmtilesSourceLayer
      }
    });
    this.styleRegionOverridesService = createStyleRegionOverridesService({
      db: this.db
    });

    Object.assign(this, createRuntimeSettingsBoot({
      appSettingsService: this.appSettingsService,
      dataSettingsService: this.dataSettingsService,
      defaults: {
        appDisplayName: this.config.appDisplayName,
        appBaseUrl: this.config.appBaseUrl,
        registrationEnabled: this.config.registrationEnabled,
        userEditRequiresPermission: this.config.userEditRequiresPermission,
        basemapProvider: 'carto',
        maptilerApiKey: '',
        customBasemapUrl: '',
        customBasemapApiKey: '',
        smtpUrl: this.config.smtpUrl,
        smtpHost: this.config.smtpHost,
        smtpPort: this.config.smtpPort,
        smtpSecure: this.config.smtpSecure,
        smtpUser: this.config.smtpUser,
        smtpPass: this.config.smtpPass,
        emailFrom: String(this.config.rawEnv.EMAIL_FROM || this.config.smtpUser || '').trim()
      },
      filterTags: {
        defaultAllowlist: DEFAULT_FILTER_TAG_ALLOWLIST,
        normalizeFilterTagKeyList
      }
    }));

    const filterTagKeysBoot = createFilterTagKeysBoot({
      db: this.db,
      dbProvider: this.config.dbProvider,
      logger: this.logger,
      spawn,
      processExecPath: this.config.processRef.execPath,
      rootDir: this.config.rootDir,
      filterTagKeysRebuildScriptPath: this.config.paths.filterTagKeysRebuildScriptPath,
      env: this.config.rawEnv,
      sqlite: {
        dbPath: this.config.paths.dbPath,
        osmDbPath: this.config.paths.osmDbPath
      },
      getEffectiveFilterTagAllowlist: this.getEffectiveFilterTagAllowlist,
      normalizeFilterTagKey,
      isShuttingDown: () => this.shuttingDown
    });
    this.scheduleFilterTagKeysCacheRebuild = filterTagKeysBoot.scheduleFilterTagKeysCacheRebuild;
    this.getAllFilterTagKeysCached = filterTagKeysBoot.getAllFilterTagKeysCached;
    this.getFilterTagKeysCached = filterTagKeysBoot.getFilterTagKeysCached;
    this.isFilterTagAllowed = filterTagKeysBoot.isFilterTagAllowed;
    this.resetFilterTagKeysCache = filterTagKeysBoot.resetFilterTagKeysCache;
    this.stopFilterTagKeysBoot = filterTagKeysBoot.stop;
    this.isFilterTagKeysRebuildInProgress = filterTagKeysBoot.isFilterTagKeysRebuildInProgress;

    const designRefSuggestionsBoot = createDesignRefSuggestionsBoot({
      db: this.db,
      dbProvider: this.config.dbProvider,
      logger: this.logger
    });
    this.getDesignRefSuggestionsCached = designRefSuggestionsBoot.getDesignRefSuggestionsCached;
    this.refreshDesignRefSuggestionsCache = designRefSuggestionsBoot.refreshDesignRefSuggestionsCache;
    this.resetDesignRefSuggestionsCache = designRefSuggestionsBoot.resetDesignRefSuggestionsCache;

    const searchIndexBoot = createSearchIndexBoot({
      db: this.db,
      dbProvider: this.config.dbProvider,
      logger: this.logger,
      spawn,
      processExecPath: this.config.processRef.execPath,
      rootDir: this.config.rootDir,
      searchRebuildScriptPath: this.config.paths.searchRebuildScriptPath,
      searchRefreshWorkerScriptPath: this.config.paths.searchRefreshWorkerScriptPath,
      batchSize: this.config.searchIndexBatchSize,
      env: this.config.rawEnv,
      sqlite: {
        dbPath: this.config.paths.dbPath,
        osmDbPath: this.config.paths.osmDbPath,
        localEditsDbPath: this.config.paths.localEditsDbPath
      },
      isShuttingDown: () => this.shuttingDown
    });
    this.rebuildSearchIndex = searchIndexBoot.rebuildSearchIndex;
    this.refreshSearchIndexForBuilding = searchIndexBoot.refreshSearchIndexForBuilding;
    this.enqueueSearchIndexRefresh = searchIndexBoot.enqueueSearchIndexRefresh;
    this.stopSearchIndexBoot = searchIndexBoot.stop;
    this.isSearchIndexRebuildInProgress = searchIndexBoot.isSearchIndexRebuildInProgress;

    this.osmSyncService = createOsmSyncService({
      db: this.db,
      settingsSecret: String(this.config.rawEnv.APP_SETTINGS_SECRET || this.config.sessionSecret).trim() || this.config.sessionSecret,
      appSettingsService: this.appSettingsService,
      enqueueSearchIndexRefresh: this.enqueueSearchIndexRefresh,
      refreshDesignRefSuggestionsCache: this.refreshDesignRefSuggestionsCache
    });

    Object.assign(this, createRegionPmtilesBoot({
      dataDir: this.config.paths.dataDir,
      logger: this.logger
    }));

    const buildingEditsService = createBuildingEditsService({
      db: this.db,
      normalizeUserEditStatus: this.normalizeUserEditStatus
    });
    this.ARCHI_FIELD_SET = buildingEditsService.ARCHI_FIELD_SET;
    this.getMergedInfoRow = buildingEditsService.getMergedInfoRow;
    this.getOsmContourRow = buildingEditsService.getOsmContourRow;
    this.getLatestUserEditRow = buildingEditsService.getLatestUserEditRow;
    this.supersedePendingUserEdits = buildingEditsService.supersedePendingUserEdits;
    this.getSessionEditActorKey = buildingEditsService.getSessionEditActorKey;
    this.applyUserEditRowToInfo = buildingEditsService.applyUserEditRowToInfo;
    this.getUserEditsList = buildingEditsService.getUserEditsList;
    this.getUserEditsPage = buildingEditsService.getUserEditsPage;
    this.getUserEditsPageRaw = buildingEditsService.getUserEditsPageRaw;
    this.getUserEditDetailsById = buildingEditsService.getUserEditDetailsById;
    this.reassignUserEdit = buildingEditsService.reassignUserEdit;
    this.deleteUserEdit = buildingEditsService.deleteUserEdit;
    this.withdrawPendingUserEdit = buildingEditsService.withdrawPendingUserEdit;
    this.mergePersonalEditsIntoFeatureInfo = buildingEditsService.mergePersonalEditsIntoFeatureInfo;
    this.applyPersonalEditsToFilterItems = buildingEditsService.applyPersonalEditsToFilterItems;

    const featureInfoSupport = createFeatureInfoSupport({
      db: this.db,
      mergePersonalEditsIntoFeatureInfo: this.mergePersonalEditsIntoFeatureInfo
    });
    this.rowToFeature = featureInfoSupport.rowToFeature;
    this.attachInfoToFeatures = featureInfoSupport.attachInfoToFeatures;

    const authMiddlewareSupport = createAuthMiddlewareSupport({
      db: this.db,
      getUserEditRequiresPermission: this.getUserEditRequiresPermission
    });
    this.requireAuth = authMiddlewareSupport.requireAuth;
    this.requireAdmin = authMiddlewareSupport.requireAdmin;
    this.requireBuildingEditPermission = authMiddlewareSupport.requireBuildingEditPermission;

    this.searchService = createSearchService({
      db: this.db,
      defaultLon: this.config.mapDefaultLon,
      defaultLat: this.config.mapDefaultLat,
      isRebuildInProgress: this.isSearchIndexRebuildInProgress
    });
  }

  normalizeMapConfig() {
    const lon = Number.isFinite(this.config.mapDefaultLon)
      ? Math.min(180, Math.max(-180, this.config.mapDefaultLon))
      : 44.0059;
    const lat = Number.isFinite(this.config.mapDefaultLat)
      ? Math.min(90, Math.max(-90, this.config.mapDefaultLat))
      : 56.3269;
    const zoom = Number.isFinite(this.config.mapDefaultZoom)
      ? Math.min(22, Math.max(0, this.config.mapDefaultZoom))
      : 15;
    return { lon, lat, zoom };
  }

  createSyncWorkers() {
    return initSyncWorkersInfra({
      spawn,
      processExecPath: this.config.processRef.execPath,
      syncRegionScriptPath: this.config.paths.syncRegionScriptPath,
      cwd: this.config.rootDir,
      env: {
        ...this.config.rawEnv,
        DB_PROVIDER: this.config.dbProvider
      },
      dataSettingsService: this.dataSettingsService,
      autoSyncEnabled: this.config.autoSyncEnabled,
      autoSyncOnStart: this.config.autoSyncOnStart,
      autoSyncIntervalHours: this.config.autoSyncIntervalHours,
      isShuttingDown: () => this.shuttingDown,
      getContoursTotal: async () => Number((await this.db.prepare('SELECT COUNT(*) AS total FROM osm.building_contours').get())?.total || 0),
      onSyncSuccess: async (payload = null) => {
        const managedRegionSync = Boolean(payload?.region);
        try {
          await this.osmSyncService?.cleanupSyncedLocalOverwritesAfterImport?.();
        } catch (error) {
          this.logger.error('osm_sync_cleanup_after_import_failed', {
            error: String(error?.message || error)
          });
        }
        await this.rebuildSearchIndex(managedRegionSync ? `region-sync:${payload.region.id}` : 'region-sync');
        this.resetFilterTagKeysCache();
        this.scheduleFilterTagKeysCacheRebuild(managedRegionSync ? `region-sync:${payload.region.id}` : 'region-sync');
        await this.refreshDesignRefSuggestionsCache?.(managedRegionSync ? `region-sync:${payload.region.id}` : 'region-sync');
      }
    });
  }

  async getBuildingSearchResults(queryText, centerLon, centerLat, limit = 30, cursor = 0) {
    return this.searchService.getBuildingSearchResults(queryText, centerLon, centerLat, limit, cursor);
  }

  runStartupTasksOnce() {
    if (this.startupTasksScheduled) return;
    this.startupTasksScheduled = true;
    Promise.resolve(this.dbRuntimePromise)
      .then(() => runPostDbStartupTasks(this))
      .catch((error) => {
        this.logger.error('startup_tasks_wait_db_failed', { error: String(error?.message || error) });
      });
  }

  initializeRuntime() {
    if (this.runtimeInitPromise) return this.runtimeInitPromise;

    this.runtimeInitPromise = initSessionStore({
      sessionSecret: this.config.sessionSecret,
      nodeEnv: this.config.nodeEnv,
      sessionCookieSecure: this.config.sessionCookieSecure,
      redisUrl: this.config.redisUrl,
      sessionAllowMemoryFallback: this.config.sessionAllowMemoryFallback,
      maxAgeMs: 1000 * 60 * 60 * 24 * 30,
      logger: this.logger
    })
      .then((middleware) => {
        this.sessionMiddleware = middleware;
        validateSecurityConfig({
          nodeEnv: this.config.nodeEnv,
          sessionSecret: this.config.sessionSecret,
          appBaseUrl: this.config.appBaseUrl,
          sessionAllowMemoryFallback: this.config.sessionAllowMemoryFallback
        });
        return middleware;
      })
      .catch((error) => {
        this.runtimeInitPromise = null;
        throw error;
      });

    return this.runtimeInitPromise;
  }

  async startHttpServer() {
    await this.initializeRuntime();
    if (this.httpServer) return this.httpServer;

    await new Promise<void>((resolve, reject) => {
      const server = this.app.listen(this.config.port, this.config.host, () => {
        this.httpServer = server;
        this.logger.info('server_started', {
          localUrl: `http://localhost:${this.config.port}`,
          networkUrl: `http://${this.config.host}:${this.config.port}`,
          nodeEnv: this.config.nodeEnv
        });
        resolve();
      });
      server.once('error', reject);
    });

    this.runStartupTasksOnce();
    return this.httpServer;
  }

  async prepareRuntime() {
    await this.initializeRuntime();
    this.runStartupTasksOnce();
    return this.app;
  }

  stopRuntime(signal = 'manual') {
    if (this.stopRuntimePromise) return this.stopRuntimePromise;

    this.stopRuntimePromise = (async () => {
      if (this.shuttingDown) return;
      this.shuttingDown = true;
      this.logger.info('server_shutdown_started', { signal });

      if (this.syncWorkers) {
        this.syncWorkers.stop();
      }
      this.stopSearchIndexBoot();
      this.stopFilterTagKeysBoot();

      if (this.httpServer) {
        await new Promise<void>((resolve) => {
          this.httpServer.close(() => {
            this.logger.info('server_shutdown_complete');
            resolve();
          });
        });
        this.httpServer = null;
      }

      await this.closeDbRuntime();
    })().finally(() => {
      this.stopRuntimePromise = null;
    });

    return this.stopRuntimePromise;
  }

  shutdown(signal) {
    this.stopRuntime(signal)
      .then(() => {
        this.config.processRef.exit(0);
      })
      .catch((error) => {
        this.logger.error('server_shutdown_failed', { error: String(error?.message || error) });
        this.config.processRef.exit(1);
      });

    setTimeout(() => {
      this.logger.error('server_shutdown_forced_timeout');
      this.config.processRef.exit(1);
    }, 10000).unref();
  }

  registerSignalHandlers() {
    if (this.signalHandlersRegistered) return;
    this.signalHandlersRegistered = true;
    this.config.processRef.on('SIGTERM', () => this.shutdown('SIGTERM'));
    this.config.processRef.on('SIGINT', () => this.shutdown('SIGINT'));
  }

  runAsMain() {
    this.registerSignalHandlers();
    return this.startHttpServer()
      .catch((error) => {
        this.logger.error('server_session_store_init_failed', { error: String(error?.message || error) });
        this.config.processRef.exit(1);
      });
  }

  toRuntimeHandle() {
    return {
      app: this.app,
      initializeRuntime: this.initializeRuntime.bind(this),
      prepareRuntime: this.prepareRuntime.bind(this),
      startHttpServer: this.startHttpServer.bind(this),
      stopRuntime: this.stopRuntime.bind(this),
      runAsMain: this.runAsMain.bind(this)
    };
  }
}

function createServerRuntime(options: LooseRecord = {}) {
  return new ServerRuntime(options).toRuntimeHandle();
}

module.exports = {
  ServerRuntime,
  createServerRuntime,
  runPostDbStartupTasks
};
