const path = require('path');
const fs = require('fs');
const express = require('express');

function registerAppRoutes(deps) {
  const {
    app,
    db,
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

  function readLegalDoc(fileName, pageTitle) {
    const filePath = path.join(legalDir, fileName);
    const markdown = fs.readFileSync(filePath, 'utf8');
    return {
      title: pageTitle,
      markdown
    };
  }

  app.get('/app-config.js', (req, res) => {
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

  app.get(['/account', '/account/'], (req, res) => {
    return res.sendFile(path.join(rootDir, 'public', 'account.html'));
  });

  app.get(['/admin', '/admin/'], (req, res) => {
    return res.sendFile(path.join(rootDir, 'public', 'admin.html'));
  });

  app.get(['/info', '/info/'], (req, res) => {
    return res.sendFile(path.join(rootDir, 'public', 'info.html'));
  });

  app.get('/api/legal-docs/:slug', (req, res) => {
    const slug = String(req.params?.slug || '').trim().toLowerCase();
    const bySlug = {
      'user-agreement': { fileName: 'user-agreement.ru.md', title: 'Пользовательское соглашение' },
      'privacy-policy': { fileName: 'privacy-policy.ru.md', title: 'Политика конфиденциальности' }
    };
    const target = bySlug[slug];
    if (!target) {
      return res.status(404).json({ error: 'Документ не найден' });
    }
    try {
      const doc = readLegalDoc(target.fileName, target.title);
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

  app.get('/api/filter-tag-keys', (req, res) => {
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
  registerPublicStaticRoute({ app, rootDir }) {
    app.use(express.static(path.join(rootDir, 'public')));
  }
};
