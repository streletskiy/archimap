(function initArchiMapMainMap() {
  function readViewFromUrl() {
    const hash = String(window.location.hash || '');
    const match = hash.match(/^#map=(\d+(?:\.\d+)?)\/(-?\d+(?:\.\d+)?)\/(-?\d+(?:\.\d+)?)$/);
    if (!match) return null;

    const zoom = Number(match[1]);
    const lat = Number(match[2]);
    const lon = Number(match[3]);
    if ([zoom, lat, lon].some((n) => Number.isNaN(n))) return null;
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
    return { zoom, center: [lon, lat] };
  }

  function saveLastMapHash(hashValue) {
    const text = String(hashValue || '').trim();
    if (!text.startsWith('#map=')) return;
    try {
      localStorage.setItem('archimap-last-map-hash', text);
    } catch {
      // ignore
    }
  }

  function readBuildingFromUrl() {
    const url = new URL(window.location.href);
    const raw = url.searchParams.get('b');
    if (!raw) return null;
    const match = String(raw).trim().match(/^(way|relation)\/(\d+)$/);
    if (!match) return null;
    return { osmType: match[1], osmId: Number(match[2]) };
  }

  function writeBuildingToUrl(osmType, osmId, options = {}) {
    const mode = options.mode === 'replace' ? 'replace' : 'push';
    const nextValue = `${osmType}/${osmId}`;
    const url = new URL(window.location.href);
    if (url.searchParams.get('b') === nextValue) return;
    url.searchParams.set('b', nextValue);
    if (mode === 'replace') {
      history.replaceState(null, '', url.toString());
      return;
    }
    history.pushState(null, '', url.toString());
  }

  function clearBuildingFromUrl(options = {}) {
    const mode = options.mode === 'replace' ? 'replace' : 'push';
    const url = new URL(window.location.href);
    if (!url.searchParams.has('b')) return;
    url.searchParams.delete('b');
    if (mode === 'replace') {
      history.replaceState(null, '', url.toString());
      return;
    }
    history.pushState(null, '', url.toString());
  }

  function readRequestedPostLoginPath() {
    try {
      const url = new URL(window.location.href);
      const raw = String(url.searchParams.get('next') || '').trim();
      if (!raw) return null;
      if (!raw.startsWith('/')) return null;
      if (raw.startsWith('//')) return null;
      if (raw.includes('://')) return null;
      return raw;
    } catch {
      return null;
    }
  }

  function shouldOpenAuthFromUrl() {
    try {
      const url = new URL(window.location.href);
      return String(url.searchParams.get('auth') || '') === '1';
    } catch {
      return false;
    }
  }

  function getDefaultMapView(config, fallback) {
    const lon = Number(config?.lon);
    const lat = Number(config?.lat);
    const zoom = Number(config?.zoom);
    if (!Number.isFinite(lon) || !Number.isFinite(lat) || !Number.isFinite(zoom)) {
      return fallback;
    }
    if (lon < -180 || lon > 180 || lat < -90 || lat > 90 || zoom < 0 || zoom > 22) {
      return fallback;
    }
    return { center: [lon, lat], zoom };
  }

  function getMapStyleForTheme(theme, lightStyleUrl, darkStyleUrl) {
    return theme === 'dark' ? darkStyleUrl : lightStyleUrl;
  }

  function getLocalBuildingStyleForTheme(theme, fallbackByTheme, externalStyleByTheme) {
    const normalized = theme === 'dark' ? 'dark' : 'light';
    if (externalStyleByTheme && typeof externalStyleByTheme === 'object' && externalStyleByTheme[normalized]) {
      return externalStyleByTheme[normalized];
    }
    return fallbackByTheme[normalized];
  }

  window.ArchiMapMainMap = {
    readViewFromUrl,
    saveLastMapHash,
    readBuildingFromUrl,
    writeBuildingToUrl,
    clearBuildingFromUrl,
    readRequestedPostLoginPath,
    shouldOpenAuthFromUrl,
    getDefaultMapView,
    getMapStyleForTheme,
    getLocalBuildingStyleForTheme
  };
})();
