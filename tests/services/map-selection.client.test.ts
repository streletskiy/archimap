const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const test = require('node:test');

let controllerImportCounter = 0;

async function loadSelectionUtils() {
  const modulePath = path.join(process.cwd(), 'frontend', 'src', 'lib', 'components', 'map', 'selection-utils.ts');
  return import(pathToFileURL(modulePath).href);
}

async function loadMapSelectionController() {
  const modulePath = path.join(process.cwd(), 'frontend', 'src', 'lib', 'components', 'map', 'map-selection-controller.ts');
  return import(`${pathToFileURL(modulePath).href}?v=${controllerImportCounter += 1}`);
}

test('getFeatureIdentity resolves osm_key first', async () => {
  const { getFeatureIdentity } = await loadSelectionUtils();
  const identity = getFeatureIdentity({
    id: 999,
    properties: {
      osm_key: 'way/321',
      osm_type: 'relation',
      osm_id: 777
    }
  });
  assert.deepEqual(identity, { osmType: 'way', osmId: 321 });
});

test('getFeatureIdentity falls back to encoded feature id', async () => {
  const { getFeatureIdentity, encodeOsmFeatureId } = await loadSelectionUtils();
  const identity = getFeatureIdentity({
    id: encodeOsmFeatureId('relation', 42),
    properties: {}
  });
  assert.deepEqual(identity, { osmType: 'relation', osmId: 42 });
});

test('getFeatureIdentity infers relation for multipolygon with osm_id', async () => {
  const { getFeatureIdentity } = await loadSelectionUtils();
  const identity = getFeatureIdentity({
    properties: {
      osm_id: 777
    },
    geometry: {
      type: 'MultiPolygon'
    }
  });
  assert.deepEqual(identity, { osmType: 'relation', osmId: 777 });
});

test('getSelectionFilter is deterministic for same building and switches for different buildings', async () => {
  const { getSelectionFilter } = await loadSelectionUtils();

  const first = getSelectionFilter(null, { osmType: 'way', osmId: 10 });
  const firstAgain = getSelectionFilter(null, { osmType: 'way', osmId: 10 });
  const second = getSelectionFilter(null, { osmType: 'way', osmId: 11 });

  assert.deepEqual(first, firstAgain);
  assert.notDeepEqual(first, second);
});

test('createMapSelectionController queries part layers in the building hit test', async () => {
  const { createMapSelectionController } = await loadMapSelectionController();
  const queriedLayers = [];
  const dispatches = [];
  const map = {
    getLayer(layerId) {
      return { id: layerId };
    },
    queryRenderedFeatures(point, options: LooseRecord = {}) {
      queriedLayers.push([...(options.layers || [])]);
      if ((options.layers || []).length === 2) {
        return [];
      }
      return [{
        id: 248,
        layer: { id: 'region-buildings-7-part-fill' },
        properties: {
          osm_type: 'way',
          osm_id: 42
        }
      }];
    },
    setFilter() {},
    setLayoutProperty() {},
    on() {},
    off() {},
    once() {},
    easeTo() {}
  };

  const controller = createMapSelectionController({
    getMap: () => map,
    getActiveRegions: () => [{ id: 7 }],
    recordDebugSetFilter: () => {},
    debugSelectionLog: () => {},
    dispatchBuildingClick: (payload) => dispatches.push(payload)
  });

  controller.handleMapBuildingClick({
    originalEvent: { timeStamp: 1234 },
    point: { x: 15, y: 20 },
    lngLat: { lng: 37.5, lat: 55.7 }
  });

  assert.ok(queriedLayers.some((layers) => layers.includes('region-buildings-7-part-fill')));
  assert.ok(queriedLayers.some((layers) => layers.includes('region-buildings-7-part-line')));
  assert.equal(dispatches.length, 1);
  assert.equal(dispatches[0].osmType, 'way');
  assert.equal(dispatches[0].osmId, 42);
  assert.equal(dispatches[0].feature.layer.id, 'region-buildings-7-part-fill');
});

