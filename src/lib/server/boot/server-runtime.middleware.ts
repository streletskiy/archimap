const { applySecurityHeadersMiddleware } = require('../infra/security-headers.infra');
const { initObservabilityInfra } = require('../infra/observability.infra');
const { jsonMiddleware } = require('../infra/mini-app.infra');
const { advanceBuildingDataRevision } = require('../infra/building-data-revision.infra');

function applyServerRuntimeMiddleware(runtime) {
  runtime.app.use(jsonMiddleware());
  runtime.app.use((req, res, next) => {
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) && /^\/api\/(building-info\/|account\/edits\/|admin\/)/.test(req.path || req.url)) {
      res.on('finish', () => { if (res.statusCode >= 200 && res.statusCode < 300) advanceBuildingDataRevision(); });
    }
    return next();
  });

  applySecurityHeadersMiddleware(runtime.app, {
    nodeEnv: runtime.config.nodeEnv,
    cspConnectOrigins: runtime.config.runtimeEnv.cspConnectSrcExtra,
    cspScriptHashes: runtime.config.paths.cspScriptHashes
  });

  runtime.stopObservability = initObservabilityInfra(runtime.app, {
    logger: runtime.logger,
    requestIdFactory: () => runtime.logger.requestId(),
    metricsEnabled: runtime.config.metricsEnabled,
    getVersionInfo: runtime.getAppVersion,
    getReadinessChecks: async () => {
      const [dbReady, sessionStoreReady] = await Promise.all([
        runtime.checkDbReadiness(),
        runtime.sessionMiddleware?.checkReadiness?.() || false
      ]);
      return { dbReady, sessionStoreReady };
    },
    getPoolMetrics: () => runtime.getDbPoolMetrics(),
    getSyncMetrics: () => runtime.syncWorkers?.getMetrics?.(),
    getMetricsToken: async () => {
      if (runtime.config.rawEnv.METRICS_TOKEN) return runtime.config.rawEnv.METRICS_TOKEN;
      const g = await runtime.appSettingsService.getEffectiveGeneralConfig();
      return g.config.metricsToken;
    }
  });

  runtime.app.use((req, res, next) => {
    if (!runtime.isDbRuntimeReady()) {
      return res
        .status(503)
        .json({ code: 'ERR_SERVICE_INITIALIZING', error: 'Service is initializing, please try again' });
    }
    if (!runtime.sessionMiddleware) {
      return res
        .status(503)
        .json({ code: 'ERR_SERVICE_INITIALIZING', error: 'Service is initializing, please try again' });
    }
    return runtime.sessionMiddleware(req, res, next);
  });
}

module.exports = {
  applyServerRuntimeMiddleware
};
