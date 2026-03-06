const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
const { sendCachedJson } = require('../infra/http-cache.infra');
const { sendPmtiles } = require('../infra/pmtiles-stream.infra');

function createSvelteNodeHandlerInvoker(rootDir) {
  const handlerPath = path.join(rootDir, 'frontend', 'build', 'handler.js');
  let handlerPromise = null;

  async function resolveHandler() {
    if (!fs.existsSync(handlerPath)) return null;
    if (!handlerPromise) {
      handlerPromise = import(pathToFileURL(handlerPath).href)
        .then((module) => (typeof module?.handler === 'function' ? module.handler : null))
        .catch(() => null);
    }
    return handlerPromise;
  }

  return async (req, res, next) => {
    const handler = await resolveHandler();
    if (typeof handler !== 'function') {
      if (typeof next === 'function') return next();
      return res.status(503).type('text/plain').send('Svelte frontend is not built yet. Run: npm run frontend:build');
    }
    return handler(req, res);
  };
}

function registerAppRoutes(deps) {
  const {
    app,
    publicApiRateLimiter,
    rootDir,
    buildingsPmtilesPath,
    normalizeMapConfig,
    getBuildInfo,
    getAppVersion,
    registrationEnabled,
    getRegistrationEnabled,
    buildingsPmtilesSourceLayer,
    getFilterTagKeysCached,
    isFilterTagKeysRebuildInProgress
  } = deps;
  const frontendBuildDir = path.join(rootDir, 'frontend', 'build');
  const frontendIndexPath = path.join(frontendBuildDir, 'index.html');
  const invokeSvelteNodeHandler = createSvelteNodeHandlerInvoker(rootDir);

  app.get('/app-config.js', publicApiRateLimiter, (req, res) => {
    const mapDefault = normalizeMapConfig();
    const buildingsPmtiles = {
      url: '/api/buildings.pmtiles',
      sourceLayer: buildingsPmtilesSourceLayer
    };
    const buildInfo = getBuildInfo();
    const mapSelection = {
      debug: String(process.env.MAP_SELECTION_ATOMIC_DEBUG || '').trim() === 'true'
    };
    const effectiveRegistrationEnabled = typeof getRegistrationEnabled === 'function'
      ? Boolean(getRegistrationEnabled())
      : Boolean(registrationEnabled);
    const auth = {
      registrationEnabled: effectiveRegistrationEnabled
    };
    res.type('application/javascript').send(
      `window.__ARCHIMAP_CONFIG = ${JSON.stringify({ mapDefault, buildingsPmtiles, buildInfo, auth, mapSelection })};`
    );
  });

  app.get('/api/version', publicApiRateLimiter, (req, res) => {
    const version = typeof getAppVersion === 'function'
      ? getAppVersion()
      : {
        version: String(getBuildInfo?.()?.version || '0.0.0'),
        git: {
          describe: 'unknown',
          commit: String(getBuildInfo?.()?.shortSha || 'unknown'),
          dirty: false
        },
        buildTime: new Date().toISOString(),
        runtime: 'node',
        app: 'archimap',
        isTaggedRelease: false
      };
    return sendCachedJson(req, res, version, {
      cacheControl: 'no-store'
    });
  });

  app.get('/favicon.ico', (req, res) => {
    return res.status(204).end();
  });

  // Chrome DevTools sometimes probes this endpoint; return 204 to avoid noisy 404s.
  app.get('/.well-known/appspecific/com.chrome.devtools.json', (req, res) => {
    return res.status(204).end();
  });

  app.get(['/', /^\/(?:admin|account|info|app)(?:\/.*)?$/], async (req, res, next) => {
    if (!fs.existsSync(frontendIndexPath)) {
      return invokeSvelteNodeHandler(req, res, next);
    }
    return res.sendFile(frontendIndexPath);
  });

  app.get('/api/buildings.pmtiles', (req, res) => {
    return sendPmtiles(req, res, buildingsPmtilesPath, {
      cacheControl: 'public, max-age=300, stale-while-revalidate=120'
    });
  });

  app.get('/api/filter-tag-keys', publicApiRateLimiter, async (req, res) => {
    try {
      const keys = await getFilterTagKeysCached();
      return sendCachedJson(req, res, {
        keys,
        warmingUp: isFilterTagKeysRebuildInProgress() || keys.length === 0
      }, {
        cacheControl: 'public, max-age=300'
      });
    } catch {
      return res.status(500).json({ error: 'Не удалось получить список ключей OSM тегов' });
    }
  });

}

module.exports = {
  registerAppRoutes
};
