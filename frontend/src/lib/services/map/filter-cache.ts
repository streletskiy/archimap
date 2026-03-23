export function createFilterCache({
  ttlMs = 0,
  maxItems = 0
} = {}) {
  let filterMatchesCache = new Map();

  function pruneFilterMatchesCache() {
    while (filterMatchesCache.size > maxItems) {
      const oldest = filterMatchesCache.keys().next().value;
      if (!oldest) break;
      filterMatchesCache.delete(oldest);
    }
  }

  function getCachedFilterMatches(cacheKey) {
    const cached = filterMatchesCache.get(cacheKey);
    if (!cached) return null;
    if ((Date.now() - Number(cached.cachedAt || 0)) > ttlMs) {
      filterMatchesCache.delete(cacheKey);
      return null;
    }
    return cached.payload;
  }

  function findCachedFilterMatches(match) {
    if (typeof match !== 'function') return null;
    const entries = [...filterMatchesCache.entries()].reverse();
    for (const [cacheKey, cached] of entries) {
      if ((Date.now() - Number(cached?.cachedAt || 0)) > ttlMs) {
        filterMatchesCache.delete(cacheKey);
        continue;
      }
      if (match(cached?.payload, cacheKey)) {
        return cached.payload;
      }
    }
    return null;
  }

  function putCachedFilterMatches(cacheKey, payload) {
    filterMatchesCache.set(cacheKey, {
      cachedAt: Date.now(),
      payload
    });
    pruneFilterMatchesCache();
  }

  function clear() {
    filterMatchesCache = new Map();
  }

  return {
    clear,
    findCachedFilterMatches,
    getCachedFilterMatches,
    putCachedFilterMatches
  };
}
