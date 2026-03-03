const { sendCachedJson } = require('../infra/http-cache.infra');
const { createLruCache } = require('../infra/lru-cache.infra');

function registerSearchRoutes({ app, searchRateLimiter, getBuildingSearchResults }) {
  const searchCache = createLruCache({ max: 300, ttlMs: 15 * 1000 });

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

    const cacheKey = `${q}|${Number.isFinite(lon) ? lon.toFixed(5) : 'd'}|${Number.isFinite(lat) ? lat.toFixed(5) : 'd'}|${limit}|${cursor}`;
    const cached = searchCache.get(cacheKey);
    if (cached) {
      return sendCachedJson(req, res, cached, {
        cacheControl: 'public, max-age=15'
      });
    }

    const result = getBuildingSearchResults(q, lon, lat, limit, cursor);
    const payload = {
      items: result.items,
      hasMore: result.hasMore,
      nextCursor: result.nextCursor
    };
    searchCache.set(cacheKey, payload);

    return sendCachedJson(req, res, payload, {
      cacheControl: 'public, max-age=15'
    });
  });
}

module.exports = {
  registerSearchRoutes
};
