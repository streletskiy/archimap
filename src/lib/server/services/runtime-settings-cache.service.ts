function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function createRuntimeSettingsCache(options: LooseRecord = {}) {
  const {
    fallback = {},
    load,
    normalize,
    selectConfig = (value) => value?.config
  } = options;

  if (typeof load !== 'function') {
    throw new Error('createRuntimeSettingsCache: load must be a function');
  }
  if (typeof normalize !== 'function') {
    throw new Error('createRuntimeSettingsCache: normalize must be a function');
  }

  let cache = isPlainObject(fallback) ? { ...fallback } : {};
  let refreshPromise = null;

  function updateCache(config) {
    if (!isPlainObject(config)) {
      return cache;
    }
    cache = normalize(config, cache);
    return cache;
  }

  function refresh() {
    if (refreshPromise) {
      return refreshPromise;
    }
    refreshPromise = Promise.resolve()
      .then(load)
      .then((result) => updateCache(selectConfig(result)))
      .catch(() => cache)
      .finally(() => {
        refreshPromise = null;
      });
    return refreshPromise;
  }

  function getValue() {
    void refresh();
    return cache;
  }

  function applySnapshot(snapshot) {
    return updateCache(snapshot);
  }

  return {
    refresh,
    getValue,
    applySnapshot
  };
}

module.exports = {
  createRuntimeSettingsCache
};
