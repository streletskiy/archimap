function createLruCache({ max = 200, ttlMs = 15000 } = {}) {
  const store = new Map();

  function isFresh(entry) {
    if (!entry) return false;
    return (Date.now() - entry.ts) <= ttlMs;
  }

  function get(key) {
    const entry = store.get(key);
    if (!isFresh(entry)) {
      if (entry) store.delete(key);
      return null;
    }
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
  createLruCache
};
