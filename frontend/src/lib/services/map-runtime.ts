let mapRuntimePromise = null;

export async function loadMapRuntime() {
  if (!mapRuntimePromise) {
    mapRuntimePromise = Promise.all([
      import('maplibre-gl'),
      import('maplibre-gl/dist/maplibre-gl-worker.mjs?url'),
      import('pmtiles')
    ]).then(([maplibreModule, workerModule, pmtilesModule]) => {
      maplibreModule.setWorkerUrl(workerModule.default);
      return {
        maplibregl: maplibreModule,
        PMTiles: pmtilesModule.PMTiles,
        Protocol: pmtilesModule.Protocol
      };
    });
  }

  return mapRuntimePromise;
}

export function resolvePmtilesUrl(url, origin = '') {
  const raw = String(url || '').trim();
  if (!raw) return '';
  if (raw.startsWith('http://') || raw.startsWith('https://')) return raw;
  const baseOrigin = String(origin || '')
    .trim()
    .replace(/\/+$/, '');
  if (!baseOrigin) return raw;
  return `${baseOrigin}${raw.startsWith('/') ? '' : '/'}${raw}`;
}
