const FALLBACK_CONFIG = Object.freeze({
  mapDefault: { lon: 44.0059, lat: 56.3269, zoom: 15 },
  buildingsPmtiles: { url: '/api/buildings.pmtiles', sourceLayer: 'buildings' }
});

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
    buildingsPmtiles: {
      url: String(fromWindow?.buildingsPmtiles?.url || FALLBACK_CONFIG.buildingsPmtiles.url),
      sourceLayer: String(fromWindow?.buildingsPmtiles?.sourceLayer || FALLBACK_CONFIG.buildingsPmtiles.sourceLayer)
    }
  };
}
