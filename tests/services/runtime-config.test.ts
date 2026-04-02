const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('url');

function frontendModulePath(...parts) {
  return pathToFileURL(path.join(__dirname, '..', '..', 'frontend', 'src', ...parts)).href;
}

async function importFrontendModule(...parts) {
  return import(frontendModulePath(...parts));
}

function restoreWindow(originalWindow) {
  if (typeof originalWindow === 'undefined') {
    delete globalThis.window;
    return;
  }
  globalThis.window = originalWindow;
}

test('getRuntimeConfig falls back to region-only runtime config when window payload is absent', async () => {
  const { getRuntimeConfig } = await importFrontendModule('lib', 'services', 'config.ts');
  const originalWindow = globalThis.window;

  try {
    delete globalThis.window;
    const runtimeConfig = getRuntimeConfig();
    assert.deepEqual(runtimeConfig.mapDefault, { lon: 44.0059, lat: 56.3269, zoom: 15 });
    assert.deepEqual(runtimeConfig.buildingRegionsPmtiles, []);
    assert.deepEqual(runtimeConfig.basemap, {
      provider: 'carto',
      maptilerApiKey: '',
      customBasemapUrl: '',
      customBasemapApiKey: ''
    });
    assert.deepEqual(runtimeConfig.mapSelection, { debug: false });
  } finally {
    restoreWindow(originalWindow);
  }
});

test('getRuntimeConfig normalizes regional PMTiles payload and viewport helper activates only intersecting regions', async () => {
  const { getRuntimeConfig } = await importFrontendModule('lib', 'services', 'config.ts');
  const { getActiveRegionPmtiles } = await importFrontendModule('lib', 'services', 'region-pmtiles.ts');
  const originalWindow = globalThis.window;

  try {
    globalThis.window = {
      __ARCHIMAP_CONFIG: {
        mapDefault: { lon: 30, lat: 60, zoom: 11 },
        buildingRegionsPmtiles: [
          {
            id: 7,
            slug: 'north',
            name: 'North',
            url: '/api/data/regions/7/pmtiles',
            sourceLayer: 'buildings',
            bounds: { west: 10, south: 10, east: 20, north: 20 },
            pmtilesMinZoom: 12,
            pmtilesMaxZoom: 16,
            lastSuccessfulSyncAt: '2026-03-07T12:00:00.000Z'
          },
          {
            id: 8,
            slug: 'broken',
            name: 'Broken',
            url: '/api/data/regions/8/pmtiles',
            sourceLayer: '',
            bounds: { west: 30, south: 30, east: 35, north: 35 }
          }
        ],
        basemap: {
          provider: 'maptiler',
          maptilerApiKey: 'sample-maptiler-key'
        },
        mapSelection: { debug: true }
      }
    } as unknown as Window & typeof globalThis;

    const runtimeConfig = getRuntimeConfig();
    assert.equal(runtimeConfig.buildingRegionsPmtiles.length, 1);
    assert.deepEqual(runtimeConfig.buildingRegionsPmtiles[0], {
      id: 7,
      slug: 'north',
      name: 'North',
      url: '/api/data/regions/7/pmtiles',
      sourceLayer: 'buildings',
      bounds: { west: 10, south: 10, east: 20, north: 20 },
      pmtilesMinZoom: 12,
      pmtilesMaxZoom: 16,
      lastSuccessfulSyncAt: '2026-03-07T12:00:00.000Z'
    });
    assert.equal(runtimeConfig.mapSelection.debug, true);
    assert.deepEqual(runtimeConfig.basemap, {
      provider: 'maptiler',
      maptilerApiKey: 'sample-maptiler-key',
      customBasemapUrl: '',
      customBasemapApiKey: ''
    });

    const activeRegions = getActiveRegionPmtiles(runtimeConfig.buildingRegionsPmtiles, {
      west: 19.5,
      south: 11,
      east: 21,
      north: 12
    });
    assert.deepEqual(activeRegions.map((item) => item.id), [7]);

    const inactiveRegions = getActiveRegionPmtiles(runtimeConfig.buildingRegionsPmtiles, {
      west: 21.1,
      south: 21.1,
      east: 22,
      north: 22
    });
    assert.deepEqual(inactiveRegions, []);
  } finally {
    restoreWindow(originalWindow);
  }
});

test('getRuntimeConfig falls back to carto when maptiler provider is missing an api key', async () => {
  const { getRuntimeConfig } = await importFrontendModule('lib', 'services', 'config.ts');
  const originalWindow = globalThis.window;

  try {
    globalThis.window = {
      __ARCHIMAP_CONFIG: {
        basemap: {
          provider: 'maptiler',
          maptilerApiKey: ''
        }
      }
    } as unknown as Window & typeof globalThis;

    const runtimeConfig = getRuntimeConfig();
    assert.deepEqual(runtimeConfig.basemap, {
      provider: 'carto',
      maptilerApiKey: '',
      customBasemapUrl: '',
      customBasemapApiKey: ''
    });
  } finally {
    restoreWindow(originalWindow);
  }
});

test('getRuntimeConfig falls back to carto when custom basemap provider is missing a url', async () => {
  const { getRuntimeConfig } = await importFrontendModule('lib', 'services', 'config.ts');
  const originalWindow = globalThis.window;

  try {
    globalThis.window = {
      __ARCHIMAP_CONFIG: {
        basemap: {
          provider: 'custom',
          customBasemapUrl: '',
          customBasemapApiKey: 'test-key'
        }
      }
    } as unknown as Window & typeof globalThis;

    const runtimeConfig = getRuntimeConfig();
    assert.deepEqual(runtimeConfig.basemap, {
      provider: 'carto',
      maptilerApiKey: '',
      customBasemapUrl: '',
      customBasemapApiKey: 'test-key'
    });
  } finally {
    restoreWindow(originalWindow);
  }
});

