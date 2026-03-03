const path = require('path');
const fs = require('fs');
const express = require('express');

function registerAppRoutes(deps) {
  const {
    app,
    db,
    publicApiRateLimiter,
    rootDir,
    buildingsPmtilesPath,
    normalizeMapConfig,
    getBuildInfo,
    registrationEnabled,
    getRegistrationEnabled,
    buildingsPmtilesSourceLayer,
    getFilterTagKeysCached,
    isFilterTagKeysRebuildInProgress
  } = deps;
  const legalDir = path.join(rootDir, 'legal');
  const frontendBuildDir = path.join(rootDir, 'frontend', 'build');
  const frontendIndexPath = path.join(frontendBuildDir, 'index.html');

  function readLegalDoc(fileName, pageTitle) {
    const filePath = path.join(legalDir, fileName);
    const markdown = fs.readFileSync(filePath, 'utf8');
    return {
      title: pageTitle,
      markdown
    };
  }

  app.get('/app-config.js', publicApiRateLimiter, (req, res) => {
    const mapDefault = normalizeMapConfig();
    const buildingsPmtiles = {
      url: '/api/buildings.pmtiles',
      sourceLayer: buildingsPmtilesSourceLayer
    };
    const buildInfo = getBuildInfo();
    const bootstrapFirstAdminAvailable = Number(db.prepare('SELECT COUNT(*) AS total FROM auth.users').get()?.total || 0) === 0;
    const effectiveRegistrationEnabled = typeof getRegistrationEnabled === 'function'
      ? Boolean(getRegistrationEnabled())
      : Boolean(registrationEnabled);
    const auth = {
      registrationEnabled: effectiveRegistrationEnabled,
      bootstrapFirstAdminAvailable
    };
    res.type('application/javascript').send(
      `window.__ARCHIMAP_CONFIG = ${JSON.stringify({ mapDefault, buildingsPmtiles, buildInfo, auth })};`
    );
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

  app.get('/api/legal-docs/:slug', publicApiRateLimiter, (req, res) => {
    const slug = String(req.params?.slug || '').trim().toLowerCase();
    const bySlug = {
      'user-agreement': { fileName: 'user-agreement.ru.md', title: 'Пользовательское соглашение' },
      'privacy-policy': { fileName: 'privacy-policy.ru.md', title: 'Политика конфиденциальности' },
      'edits-workflow': { fileName: path.join('docs', 'EDITS_WORKFLOW.md'), title: 'Регламент правок', fromRoot: true }
    };
    const target = bySlug[slug];
    if (!target) {
      return res.status(404).json({ error: 'Документ не найден' });
    }
    try {
      const doc = target.fromRoot
        ? { title: target.title, markdown: fs.readFileSync(path.join(rootDir, target.fileName), 'utf8') }
        : readLegalDoc(target.fileName, target.title);
      return res.json({
        ok: true,
        slug,
        title: doc.title,
        markdown: doc.markdown
      });
    } catch {
      return res.status(404).json({ error: 'Документ не найден' });
    }
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

  app.get('/api/filter-tag-keys', publicApiRateLimiter, (req, res) => {
    try {
      const keys = getFilterTagKeysCached();
      res.json({
        keys,
        warmingUp: isFilterTagKeysRebuildInProgress() || keys.length === 0
      });
    } catch {
      res.status(500).json({ error: 'Не удалось получить список ключей OSM тегов' });
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
