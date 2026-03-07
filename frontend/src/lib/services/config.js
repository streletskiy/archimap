const FALLBACK_CONFIG = Object.freeze({
  mapDefault: { lon: 44.0059, lat: 56.3269, zoom: 15 },
  buildingRegionsPmtiles: [],
  mapSelection: { debug: false }
});

function normalizeBounds(value) {
  const bounds = value && typeof value === 'object'
    ? {
      west: Number(value.west),
      south: Number(value.south),
      east: Number(value.east),
      north: Number(value.north)
    }
    : null;
  if (!bounds) return null;
  if (![bounds.west, bounds.south, bounds.east, bounds.north].every(Number.isFinite)) return null;
  return bounds;
}

function normalizeRegionPmtiles(item) {
  const id = Number(item?.id);
  if (!Number.isInteger(id) || id <= 0) return null;
  const url = String(item?.url || '').trim();
  const sourceLayer = String(item?.sourceLayer || '').trim();
  const bounds = normalizeBounds(item?.bounds);
  if (!url || !sourceLayer || !bounds) return null;
  return {
    id,
    slug: String(item?.slug || '').trim(),
    name: String(item?.name || '').trim(),
    url,
    sourceLayer,
    bounds,
    pmtilesMinZoom: Number(item?.pmtilesMinZoom),
    pmtilesMaxZoom: Number(item?.pmtilesMaxZoom),
    lastSuccessfulSyncAt: item?.lastSuccessfulSyncAt ? String(item.lastSuccessfulSyncAt) : null
  };
}

export function getRuntimeConfig() {
  const fromWindow = globalThis?.window?.__ARCHIMAP_CONFIG;
  if (!fromWindow || typeof fromWindow !== 'object') {
    return FALLBACK_CONFIG;
  }
  return {
    mapDefault: {
      lon: Number(fromWindow?.mapDefault?.lon ?? FALLBACK_CONFIG.mapDefault.lon),
      lat: Number(fromWindow?.mapDefault?.lat ?? FALLBACK_CONFIG.mapDefault.lat),
      zoom: Number(fromWindow?.mapDefault?.zoom ?? FALLBACK_CONFIG.mapDefault.zoom)
    },
    buildingRegionsPmtiles: Array.isArray(fromWindow?.buildingRegionsPmtiles)
      ? fromWindow.buildingRegionsPmtiles.map(normalizeRegionPmtiles).filter(Boolean)
      : FALLBACK_CONFIG.buildingRegionsPmtiles,
    mapSelection: {
      debug: Boolean(fromWindow?.mapSelection?.debug ?? FALLBACK_CONFIG.mapSelection.debug)
    }
  };
}
