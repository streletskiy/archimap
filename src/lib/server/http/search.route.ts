const { sendCachedJson } = require('../infra/http-cache.infra');
const { createLruCache } = require('../infra/lru-cache.infra');

function parseSearchBbox(query: LooseRecord = {}) {
  const keys = ['west', 'south', 'east', 'north'];
  const hasAny = keys.some((key) => {
    const raw = query?.[key];
    return raw != null && String(raw).trim() !== '';
  });
  if (!hasAny) {
    return { bbox: null, error: '' };
  }

  const bbox = {
    west: Number(query.west),
    south: Number(query.south),
    east: Number(query.east),
    north: Number(query.north)
  };
  if (![bbox.west, bbox.south, bbox.east, bbox.north].every(Number.isFinite)) {
    return { bbox: null, error: 'Invalid bbox' };
  }
  if (bbox.west >= bbox.east || bbox.south >= bbox.north) {
    return { bbox: null, error: 'Invalid bbox' };
  }
  return { bbox, error: '' };
}

function registerSearchRoutes({ app, searchRateLimiter, getBuildingSearchResults }: LooseRecord) {
  const searchCache = createLruCache({ max: 300, ttlMs: 15 * 1000 });
  const searchMapCache = createLruCache({ max: 300, ttlMs: 15 * 1000 });

  app.get('/api/search-buildings', searchRateLimiter, async (req, res) => {
    const q = String(req.query.q || '').trim();
    if (q.length < 2) {
      return res.status(400).json({ code: 'ERR_QUERY_TOO_SHORT', error: 'Minimum query length is 2 characters' });
    }
    if (q.length > 120) {
      return res.status(400).json({ code: 'ERR_QUERY_TOO_LONG', error: 'Maximum query length is 120 characters' });
    }

    const lon = Number(req.query.lon);
    const lat = Number(req.query.lat);
    const limit = Math.max(1, Math.min(500, Number(req.query.limit || 30)));
    const cursor = Number(req.query.cursor || 0);
    if (!Number.isFinite(cursor) || cursor < 0) {
      return res.status(400).json({ code: 'ERR_INVALID_CURSOR', error: 'Invalid cursor' });
    }
    const { bbox, error: bboxError } = parseSearchBbox(req.query);
    if (bboxError) {
      return res.status(400).json({ code: 'ERR_INVALID_BBOX', error: bboxError });
    }

    const bboxCacheKey = bbox
      ? `${bbox.west.toFixed(4)}:${bbox.south.toFixed(4)}:${bbox.east.toFixed(4)}:${bbox.north.toFixed(4)}`
      : 'bbox:none';
    const cacheKey = `${q}|${Number.isFinite(lon) ? lon.toFixed(5) : 'd'}|${Number.isFinite(lat) ? lat.toFixed(5) : 'd'}|${bboxCacheKey}|${limit}|${cursor}`;
    const cached = searchCache.get(cacheKey);
    if (cached) {
      return sendCachedJson(req, res, cached, {
        cacheControl: 'public, max-age=15'
      });
    }

    const result = await getBuildingSearchResults(q, lon, lat, limit, cursor, bbox);
    const payload = {
      items: result.items,
      total: Number(result.total || 0),
      hasMore: result.hasMore,
      nextCursor: result.nextCursor
    };
    searchCache.set(cacheKey, payload);

    return sendCachedJson(req, res, payload, {
      cacheControl: 'public, max-age=15'
    });
  });

  app.get('/api/search-buildings-map', searchRateLimiter, async (req, res) => {
    const q = String(req.query.q || '').trim();
    if (q.length < 2) {
      return res.status(400).json({ code: 'ERR_QUERY_TOO_SHORT', error: 'Minimum query length is 2 characters' });
    }
    if (q.length > 120) {
      return res.status(400).json({ code: 'ERR_QUERY_TOO_LONG', error: 'Maximum query length is 120 characters' });
    }

    const { bbox, error: bboxError } = parseSearchBbox(req.query);
    if (bboxError || !bbox) {
      return res.status(400).json({ code: bboxError ? 'ERR_INVALID_BBOX' : 'ERR_BBOX_REQUIRED', error: bboxError || 'bbox is required for map search' });
    }

    const lon = Number(req.query.lon);
    const lat = Number(req.query.lat);
    const limit = Math.max(1, Math.min(5000, Number(req.query.limit || 5000)));
    const bboxCacheKey = `${bbox.west.toFixed(4)}:${bbox.south.toFixed(4)}:${bbox.east.toFixed(4)}:${bbox.north.toFixed(4)}`;
    const cacheKey = `${q}|${Number.isFinite(lon) ? lon.toFixed(5) : 'd'}|${Number.isFinite(lat) ? lat.toFixed(5) : 'd'}|${bboxCacheKey}|${limit}`;
    const cached = searchMapCache.get(cacheKey);
    if (cached) {
      return sendCachedJson(req, res, cached, {
        cacheControl: 'public, max-age=15'
      });
    }

    const result = await getBuildingSearchResults(q, lon, lat, limit, 0, bbox);
    const payload = {
      items: result.items,
      total: Number(result.total || 0),
      truncated: Number(result.total || 0) > (Array.isArray(result.items) ? result.items.length : 0)
    };
    searchMapCache.set(cacheKey, payload);

    return sendCachedJson(req, res, payload, {
      cacheControl: 'public, max-age=15'
    });
  });
}

module.exports = {
  registerSearchRoutes
};
