const { sendCachedJson } = require('../infra/http-cache.infra');

function registerContoursStatusRoute(app, db, contoursStatusRateLimiter) {
  const selectSummary = db.prepare(`
    SELECT COUNT(*) AS total, MAX(updated_at) AS last_updated
    FROM osm.building_contours
  `);

  app.get('/api/contours-status', contoursStatusRateLimiter, (req, res) => {
    const summary = selectSummary.get();

    return sendCachedJson(req, res, {
      total: Number(summary.total || 0),
      lastUpdated: summary.last_updated || null
    }, {
      cacheControl: 'public, max-age=60',
      lastModified: summary.last_updated || undefined
    });
  });
}

module.exports = {
  registerContoursStatusRoute
};
