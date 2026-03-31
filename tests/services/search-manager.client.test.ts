const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const test = require('node:test');

let managerImportCounter = 0;

async function loadSearchStoreModule() {
  const modulePath = path.join(process.cwd(), 'frontend', 'src', 'lib', 'stores', 'search.ts');
  return import(pathToFileURL(modulePath).href);
}

async function loadFilterStoreModule() {
  const modulePath = path.join(process.cwd(), 'frontend', 'src', 'lib', 'stores', 'filters.ts');
  return import(pathToFileURL(modulePath).href);
}

async function loadMapStoreModule() {
  const modulePath = path.join(process.cwd(), 'frontend', 'src', 'lib', 'stores', 'map.ts');
  return import(pathToFileURL(modulePath).href);
}

async function loadSearchManagerModule() {
  const modulePath = path.join(process.cwd(), 'frontend', 'src', 'lib', 'services', 'search-manager.ts');
  return import(`${pathToFileURL(modulePath).href}?v=${managerImportCounter += 1}`);
}

function readStore(store) {
  let currentValue;
  const unsubscribe = store.subscribe((value) => {
    currentValue = value;
  });
  unsubscribe();
  return currentValue;
}

function waitForTick() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function createAbortError() {
  const error = new Error('Aborted');
  error.name = 'AbortError';
  return error;
}

test('requestSearch clears active filters and activates search overlay', async () => {
  const searchModule = await loadSearchStoreModule();
  const filterModule = await loadFilterStoreModule();

  searchModule.resetSearchState();
  searchModule.resetSearchMapState();
  filterModule.resetBuildingFilterLayers();
  filterModule.setBuildingFilterLayers([
    {
      id: 'filter-layer-1',
      color: '#ff0000',
      priority: 0,
      mode: 'and',
      rules: []
    }
  ]);

  searchModule.requestSearch({
    query: 'alpha',
    append: false
  });

  assert.equal(readStore(filterModule.buildingFilterLayers).length, 0);
  assert.equal(Boolean(readStore(searchModule.searchState)?.mapActive), true);

  searchModule.resetSearchState();
  searchModule.resetSearchMapState();
  filterModule.resetBuildingFilterLayers();
});

test('search manager aborts in-flight map results when search is reset', async () => {
  const searchModule = await loadSearchStoreModule();
  const mapModule = await loadMapStoreModule();
  const managerModule = await loadSearchManagerModule();

  const previousFetch = global.fetch;
  const requestUrls = [];
  let abortedRequests = 0;
  let manager = null;

  global.fetch = ((input, init: RequestInit = {}) => {
    requestUrls.push(String(input));
    const signal = init.signal;
    return new Promise((resolve, reject) => {
      const abortRequest = () => {
        abortedRequests += 1;
        reject(createAbortError());
      };
      if (signal) {
        if (signal.aborted) {
          abortRequest();
          return;
        }
        signal.addEventListener('abort', abortRequest, { once: true });
      }
    });
  }) as typeof fetch;

  try {
    searchModule.resetSearchState();
    searchModule.resetSearchMapState();
    mapModule.setMapReady(true);
    mapModule.setMapCenter({
      lng: 37.61,
      lat: 55.75
    });
    mapModule.setMapViewport({
      west: 37.5,
      south: 55.7,
      east: 37.7,
      north: 55.8
    });

    manager = managerModule.createSearchManager();
    manager.start();

    searchModule.requestSearch({
      query: 'alpha',
      append: false
    });

    await waitForTick();
    assert.equal(requestUrls.length >= 2, true);

    searchModule.resetSearchState();

    await waitForTick();

    const searchMapState = readStore(searchModule.searchMapState);
    assert.equal(searchMapState.loading, false);
    assert.deepEqual(searchMapState.items, []);
    assert.equal(abortedRequests >= 2, true);
  } finally {
    global.fetch = previousFetch;
    manager?.destroy?.();
    searchModule.resetSearchState();
    searchModule.resetSearchMapState();
    mapModule.setMapViewport(null);
    mapModule.setMapCenter(null);
    mapModule.setMapReady(false);
  }
});
