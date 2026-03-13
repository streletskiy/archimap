const { applySecurityHeadersMiddleware } = require('../infra/security-headers.infra');
const { initObservabilityInfra } = require('../infra/observability.infra');
const { jsonMiddleware } = require('../infra/mini-app.infra');

function applyServerRuntimeMiddleware(runtime) {
  runtime.app.use(jsonMiddleware());

  applySecurityHeadersMiddleware(runtime.app, {
    nodeEnv: runtime.config.nodeEnv,
    cspConnectOrigins: runtime.config.runtimeEnv.cspConnectSrcExtra,
    cspScriptHashes: runtime.config.paths.cspScriptHashes
  });

  initObservabilityInfra(runtime.app, {
    logger: runtime.logger,
    requestIdFactory: () => runtime.logger.requestId(),
    metricsEnabled: runtime.config.metricsEnabled,
    getVersionInfo: runtime.getAppVersion,
    getReadinessChecks: () => ({
      sessionStoreReady: Boolean(runtime.sessionMiddleware),
      dbReady: runtime.isDbRuntimeReady()
    }),
    getMetricsToken: async () => {
      const g = await runtime.appSettingsService.getEffectiveGeneralConfig();
      return g.config.metricsToken;
    }
  });

  runtime.app.use((req, res, next) => {
    if (!runtime.isDbRuntimeReady()) {
      return res.status(503).json({ code: 'ERR_SERVICE_INITIALIZING', error: 'Service is initializing, please try again' });
    }
    if (!runtime.sessionMiddleware) {
      return res.status(503).json({ code: 'ERR_SERVICE_INITIALIZING', error: 'Service is initializing, please try again' });
    }
    return runtime.sessionMiddleware(req, res, next);
  });
}

module.exports = {
  applyServerRuntimeMiddleware
};
