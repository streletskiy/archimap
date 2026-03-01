function registerContoursStatusRoute(app, db, contoursStatusRateLimiter) {
  app.get('/api/contours-status', contoursStatusRateLimiter, (req, res) => {
    const summary = db.prepare(`
      SELECT COUNT(*) AS total, MAX(updated_at) AS last_updated
      FROM osm.building_contours
    `).get();

    res.json({
      total: Number(summary.total || 0),
      lastUpdated: summary.last_updated || null
    });
  });
}

module.exports = {
  registerContoursStatusRoute
};
