(function initArchiMapMainSearch() {
  function buildSearchCacheKey(query, center, limit, cursor = 0) {
    const q = String(query || '').trim().toLowerCase();
    const lon = Number(center?.lng || 0).toFixed(3);
    const lat = Number(center?.lat || 0).toFixed(3);
    return `${q}|${lon}|${lat}|${Number(limit) || 0}|${Number(cursor) || 0}`;
  }

  function debounce(fn, delayMs) {
    let timer = null;
    return (...args) => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => fn(...args), delayMs);
    };
  }

  window.ArchiMapMainSearch = {
    buildSearchCacheKey,
    debounce
  };
})();
