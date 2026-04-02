const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
const { sendCachedJson } = require('../infra/http-cache.infra');
const { sendPmtiles } = require('../infra/pmtiles-stream.infra');
const {
  CUSTOM_BASEMAP_TILEJSON_PROXY_URL,
  CUSTOM_BASEMAP_TILE_PROXY_URL,
  DEFAULT_CUSTOM_BASEMAP_URL,
  buildBasemapSourceUrl,
  normalizeBasemapApiKey,
  normalizeBasemapProvider,
  normalizeCustomBasemapUrl
} = require('../services/basemap-config');
const {
  fetchRemoteJson,
  rewriteCustomBasemapTileJson,
  sendProxiedBinaryResponse
} = require('../services/basemap-proxy.service');
const {
  resolveExistingRegionPmtilesPath,
  resolveRegionPmtilesPath
} = require('../services/data-settings.service');

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
    dataDir,
    normalizeMapConfig,
    getBuildInfo,
    getAppVersion,
    loadEffectiveGeneralConfig,
    registrationEnabled,
    getRegistrationEnabled,
    dataSettingsService,
    styleRegionOverridesService,
    getFilterTagKeysCached,
    getAllFilterTagKeysCached,
    isFilterTagKeysRebuildInProgress
  } = deps;
  const frontendBuildDir = path.join(rootDir, 'frontend', 'build');
  const frontendIndexPath = path.join(frontendBuildDir, 'index.html');
  const invokeSvelteNodeHandler = createSvelteNodeHandlerInvoker(rootDir);

  function normalizeBasemapConfig(raw: LooseRecord = {}) {
    const provider = normalizeBasemapProvider(raw?.basemapProvider);
    const maptilerApiKey = normalizeBasemapApiKey(raw?.maptilerApiKey);
    const customBasemapUrl = normalizeCustomBasemapUrl(raw?.customBasemapUrl, DEFAULT_CUSTOM_BASEMAP_URL);
    const customBasemapApiKey = normalizeBasemapApiKey(raw?.customBasemapApiKey);
    if (provider === 'maptiler' && !maptilerApiKey) {
      return {
        provider: 'carto',
        maptilerApiKey: '',
        customBasemapUrl,
        customBasemapApiKey
      };
    }
    if (provider === 'custom' && !customBasemapUrl) {
      return {
        provider: 'carto',
        maptilerApiKey,
        customBasemapUrl,
        customBasemapApiKey
      };
    }
    return {
      provider,
      maptilerApiKey,
      customBasemapUrl,
      customBasemapApiKey
    };
  }

  async function getEffectiveBasemapSettings() {
    const effectiveGeneralSettings = typeof loadEffectiveGeneralConfig === 'function'
      ? await Promise.resolve(loadEffectiveGeneralConfig()).catch(() => null)
      : null;
    const generalConfig = effectiveGeneralSettings?.config && typeof effectiveGeneralSettings.config === 'object'
      ? effectiveGeneralSettings.config
      : {};
    return {
      config: generalConfig,
      customBasemapUrl: normalizeCustomBasemapUrl(generalConfig?.customBasemapUrl, DEFAULT_CUSTOM_BASEMAP_URL),
      customBasemapApiKey: normalizeBasemapApiKey(generalConfig?.customBasemapApiKey)
    };
  }

  function getRequestOrigin(req) {
    const forwardedProto = String(req.get?.('x-forwarded-proto') || '').split(',')[0].trim().toLowerCase();
    const protocol = forwardedProto === 'https' || forwardedProto === 'http'
      ? forwardedProto
      : String(req.protocol || 'http').trim().toLowerCase() || 'http';
    const forwardedHost = String(req.get?.('x-forwarded-host') || '').split(',')[0].trim();
    const host = forwardedHost || String(req.get?.('host') || '').trim();
    if (!host) return '';
    return `${protocol}://${host.replace(/\/+$/, '')}`;
  }

  async function getAvailableRegionPmtiles() {
    if (!dataSettingsService) return [];
    const regions = await dataSettingsService.listRuntimePmtilesRegions();
    return regions.filter((region) => {
      return Boolean(resolveExistingRegionPmtilesPath(dataDir, region));
    }).map((region) => ({
      ...region,
      url: `/api/data/regions/${region.id}/pmtiles`
    }));
  }

  app.get('/app-config.js', publicApiRateLimiter, async (req, res) => {
    const mapDefault = normalizeMapConfig();
    const regionalPmtiles = await getAvailableRegionPmtiles();
    const buildInfo = getBuildInfo();
    const effectiveBasemapSettings = await getEffectiveBasemapSettings();
    const generalConfig = effectiveBasemapSettings.config;
    const mapSelection = {
      debug: String(process.env.MAP_SELECTION_ATOMIC_DEBUG || '').trim() === 'true'
    };
    const effectiveRegistrationEnabled = typeof generalConfig?.registrationEnabled === 'boolean'
      ? generalConfig.registrationEnabled
      : (
        typeof getRegistrationEnabled === 'function'
          ? Boolean(getRegistrationEnabled())
          : Boolean(registrationEnabled)
      );
    const auth = {
      registrationEnabled: effectiveRegistrationEnabled
    };
    const basemap = normalizeBasemapConfig(generalConfig);
    res.type('application/javascript').send(
      `window.__ARCHIMAP_CONFIG = ${JSON.stringify({
        mapDefault,
        buildingRegionsPmtiles: regionalPmtiles,
        buildInfo,
        auth,
        basemap,
        mapSelection
      })};`
    );
  });

  app.get(CUSTOM_BASEMAP_TILEJSON_PROXY_URL, async (req, res) => {
    try {
      const { customBasemapUrl, customBasemapApiKey } = await getEffectiveBasemapSettings();
      if (!customBasemapUrl) {
        return res.status(400).json({
          code: 'ERR_CUSTOM_BASEMAP_NOT_CONFIGURED',
          error: 'Custom basemap URL is not configured'
        });
      }

      const upstreamUrl = buildBasemapSourceUrl(customBasemapUrl, customBasemapApiKey);
      const tilejson = await fetchRemoteJson(upstreamUrl, {
        accept: 'application/json'
      });
      const proxiedTilejson = rewriteCustomBasemapTileJson(
        tilejson,
        upstreamUrl,
        customBasemapApiKey,
        getRequestOrigin(req)
      );
      return sendCachedJson(req, res, proxiedTilejson, {
        cacheControl: 'private, no-cache'
      });
    } catch (error) {
      return res.status(Number(error?.status) || 502).json({
        code: 'ERR_CUSTOM_BASEMAP_TILEJSON_FAILED',
        error: 'Failed to load custom basemap tilejson'
      });
    }
  });

  app.get(CUSTOM_BASEMAP_TILE_PROXY_URL, async (req, res) => {
    try {
      const upstreamTemplate = String(req.query?.u || '').trim();
      const z = String(req.query?.z || '').trim();
      const x = String(req.query?.x || '').trim();
      const y = String(req.query?.y || '').trim();
      if (!upstreamTemplate || !z || !x || !y) {
        return res.status(400).json({
          code: 'ERR_CUSTOM_BASEMAP_TILE_REQUEST_INVALID',
          error: 'Invalid custom basemap tile request'
        });
      }
      const upstreamUrl = upstreamTemplate
        .replace(/\{z\}/g, z)
        .replace(/\{x\}/g, x)
        .replace(/\{y\}/g, y);
      return await sendProxiedBinaryResponse(req, res, upstreamUrl);
    } catch {
      return res.status(500).json({
        code: 'ERR_CUSTOM_BASEMAP_TILE_FAILED',
        error: 'Failed to load custom basemap tile'
      });
    }
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

  app.get('/api/data/regions/:regionId/pmtiles', async (req, res) => {
    const regionId = Number(req.params.regionId);
    if (!Number.isInteger(regionId) || regionId <= 0) {
      return res.status(400).json({ code: 'ERR_INVALID_REGION_ID', error: 'Invalid region id' });
    }
    const region = dataSettingsService
      ? await dataSettingsService.getRegionById(regionId)
      : null;
    if (!region) {
      return res.status(404).json({ code: 'ERR_REGION_NOT_FOUND', error: 'Region not found' });
    }
    const pmtilesPath = resolveExistingRegionPmtilesPath(dataDir, region)
      || resolveRegionPmtilesPath(dataDir, region);
    return sendPmtiles(req, res, pmtilesPath, {
      cacheControl: 'public, max-age=300, stale-while-revalidate=120'
    });
  });

  app.get('/api/filter-tag-keys', publicApiRateLimiter, async (req, res) => {
    try {
      const allKeys = typeof getAllFilterTagKeysCached === 'function'
        ? await getAllFilterTagKeysCached()
        : [];
      const keys = await getFilterTagKeysCached();
      return sendCachedJson(req, res, {
        keys,
        warmingUp: isFilterTagKeysRebuildInProgress() || allKeys.length === 0
      }, {
        cacheControl: 'public, max-age=300'
      });
    } catch {
      return res.status(500).json({ code: 'ERR_FILTER_TAG_KEYS_LOAD_FAILED', error: 'Failed to load OSM tag keys' });
    }
  });

  app.get('/api/filter-presets', publicApiRateLimiter, async (req, res) => {
    try {
      const items = dataSettingsService
        ? await dataSettingsService.getFilterPresetsForRuntime()
        : [];
      return sendCachedJson(req, res, {
        items: Array.isArray(items) ? items : []
      }, {
        cacheControl: 'public, max-age=60'
      });
    } catch {
      return res.status(500).json({ code: 'ERR_FILTER_PRESETS_LOAD_FAILED', error: 'Failed to load filter presets' });
    }
  });

  app.get('/api/style-overrides', publicApiRateLimiter, async (req, res) => {
    try {
      const items = styleRegionOverridesService
        ? await styleRegionOverridesService.listPublicOverrides()
        : [];
      return sendCachedJson(req, res, { items }, {
        cacheControl: 'public, max-age=60'
      });
    } catch {
      return res.status(500).json({ code: 'ERR_STYLE_OVERRIDES_LOAD_FAILED', error: 'Failed to load public architecture style overrides' });
    }
  });

}

module.exports = {
  registerAppRoutes
};
