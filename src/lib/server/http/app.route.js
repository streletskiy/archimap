const path = require('path');
const fs = require('fs');
const express = require('express');
const { sendCachedJson } = require('../infra/http-cache.infra');
const { sendPmtiles } = require('../infra/pmtiles-stream.infra');

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

  app.get(['/', /^\/(?:admin|account|info|app)(?:\/.*)?$/], (req, res) => {
    if (!fs.existsSync(frontendIndexPath)) {
      return res.status(503).type('text/plain').send('Svelte frontend is not built yet. Run: npm run frontend:build');
    }
    return res.sendFile(frontendIndexPath);
  });

  app.get('/api/buildings.pmtiles', (req, res) => {
    return sendPmtiles(req, res, buildingsPmtilesPath, {
      cacheControl: 'public, max-age=300, stale-while-revalidate=120'
    });
  });

  app.get('/api/filter-tag-keys', publicApiRateLimiter, (req, res) => {
    try {
      const keys = getFilterTagKeysCached();
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
  registerAppRoutes,
  registerFrontendStaticRoute({ app, rootDir }) {
    const frontendBuildDir = path.join(rootDir, 'frontend', 'build');
    app.use(express.static(frontendBuildDir, { index: false }));
  }
};
