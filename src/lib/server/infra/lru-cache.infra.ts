const metrics = new Map();
function createLruCache({ max = 200, ttlMs = 15000, name = 'other' }: LooseRecord = {}) {
  const store = new Map();
  const label = String(name).replace(/[^a-zA-Z0-9_]/g, '_');
  const stats = metrics.get(label) || { hits: 0, misses: 0, evictions: 0 };
  metrics.set(label, stats);

  function isFresh(entry) {
    if (!entry) return false;
    return Date.now() - entry.ts <= ttlMs;
  }

  function get(key) {
    const entry = store.get(key);
    if (!isFresh(entry)) {
      stats.misses++;
      if (entry) store.delete(key);
      return null;
    }
    stats.hits++;
    // Refresh recency.
    store.delete(key);
    store.set(key, entry);
    return entry.value;
  }

  function set(key, value) {
    if (store.has(key)) {
      store.delete(key);
    }
    store.set(key, { value, ts: Date.now() });
    while (store.size > max) {
      const oldest = store.keys().next().value;
      store.delete(oldest);
      stats.evictions++;
    }
  }

  return {
    get,
    set,
    clear() {
      store.clear();
    },
    size() {
      return store.size;
    }
  };
}

module.exports = {
  createLruCache,
  getCacheMetrics: () => metrics
};
