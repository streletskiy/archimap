import {
  DEFAULT_CUSTOM_BASEMAP_URL,
  normalizeBasemapApiKey,
  normalizeBasemapProvider,
  normalizeCustomBasemapUrl
} from './map/basemap-config.js';

const FALLBACK_CONFIG = Object.freeze({
  mapDefault: { lon: 44.0059, lat: 56.3269, zoom: 15 },
  buildingRegionsPmtiles: [],
  basemap: {
    provider: 'carto',
    maptilerApiKey: '',
    customBasemapUrl: DEFAULT_CUSTOM_BASEMAP_URL,
    customBasemapApiKey: ''
  },
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

function normalizeBasemapConfig(value) {
  const provider = normalizeBasemapProvider(value?.provider);
  const maptilerApiKey = normalizeBasemapApiKey(value?.maptilerApiKey);
  const customBasemapUrl = normalizeCustomBasemapUrl(
    value?.customBasemapUrl,
    FALLBACK_CONFIG.basemap.customBasemapUrl
  );
  const customBasemapApiKey = normalizeBasemapApiKey(value?.customBasemapApiKey);
  if (provider === 'maptiler' && !maptilerApiKey) {
    return {
      provider: 'carto',
      maptilerApiKey: '',
      customBasemapUrl,
      customBasemapApiKey
    };
  }
  if (provider === 'custom' && !customBasemapUrl) {
    return {
      provider: 'carto',
      maptilerApiKey,
      customBasemapUrl,
      customBasemapApiKey
    };
  }
  return {
    provider,
    maptilerApiKey,
    customBasemapUrl,
    customBasemapApiKey
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
    basemap: normalizeBasemapConfig(fromWindow?.basemap),
    mapSelection: {
      debug: Boolean(fromWindow?.mapSelection?.debug ?? FALLBACK_CONFIG.mapSelection.debug)
    }
  };
}
