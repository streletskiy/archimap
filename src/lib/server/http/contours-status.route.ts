const { sendCachedJson } = require('../infra/http-cache.infra');

function registerContoursStatusRoute(app, db, contoursStatusRateLimiter) {
  const isPostgres = db.provider === 'postgres';
  const selectSummaryFromTable = isPostgres ? db.prepare(`
    SELECT total, last_updated, refreshed_at
    FROM osm.building_contours_summary
    WHERE singleton_id = 1
    LIMIT 1
  `) : null;

  const selectSummaryFallback = db.prepare(`
    SELECT COUNT(*) AS total, MAX(updated_at) AS last_updated
    FROM osm.building_contours
  `);

  app.get('/api/contours-status', contoursStatusRateLimiter, async (req, res) => {
    let summary = null;
    if (isPostgres && selectSummaryFromTable) {
      try {
        summary = await selectSummaryFromTable.get();
      } catch {
        summary = null;
      }
    }

    if (!summary || summary.total == null) {
      summary = await selectSummaryFallback.get();
    }

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
