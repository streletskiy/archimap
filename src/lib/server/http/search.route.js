function registerSearchRoutes({ app, searchRateLimiter, getBuildingSearchResults }) {
  app.get('/api/search-buildings', searchRateLimiter, (req, res) => {
    const q = String(req.query.q || '').trim();
    if (q.length < 2) {
      return res.status(400).json({ error: 'Минимальная длина запроса: 2 символа' });
    }
    if (q.length > 120) {
      return res.status(400).json({ error: 'Максимальная длина запроса: 120 символов' });
    }

    const lon = Number(req.query.lon);
    const lat = Number(req.query.lat);
    const limit = Number(req.query.limit || 30);
    const cursor = Number(req.query.cursor || 0);
    if (!Number.isFinite(cursor) || cursor < 0) {
      return res.status(400).json({ error: 'Некорректный cursor' });
    }

    const result = getBuildingSearchResults(q, lon, lat, limit, cursor);
    return res.json({
      items: result.items,
      hasMore: result.hasMore,
      nextCursor: result.nextCursor
    });
  });
}

module.exports = {
  registerSearchRoutes
};
