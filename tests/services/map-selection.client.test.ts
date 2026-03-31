const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const test = require('node:test');

let controllerImportCounter = 0;

async function loadSelectionUtils() {
  const modulePath = path.join(process.cwd(), 'frontend', 'src', 'lib', 'components', 'map', 'selection-utils.ts');
  return import(pathToFileURL(modulePath).href);
}

async function loadModule(modulePath) {
  return import(pathToFileURL(path.join(process.cwd(), modulePath)).href);
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

test('getSelectionFilter supports multiple selected buildings', async () => {
  const { getSelectionFilter, encodeOsmFeatureId } = await loadSelectionUtils();

  const filter = getSelectionFilter(null, [
    { osmType: 'way', osmId: 10 },
    { osmType: 'relation', osmId: 11 }
  ]);

  assert.deepEqual(filter, [
    'any',
    ['==', ['id'], encodeOsmFeatureId('way', 10)],
    ['==', ['id'], encodeOsmFeatureId('relation', 11)]
  ]);
});

test('createMapSelectionController queries part layers in the buffered building hit test', async () => {
  const { createMapSelectionController } = await loadMapSelectionController();
  const queriedCalls = [];
  const dispatches = [];
  const map = {
    getLayer(layerId) {
      return { id: layerId };
    },
    queryRenderedFeatures(geometry, options: { layers?: string[] } = {}) {
      queriedCalls.push({
        geometry,
        layers: [...(options.layers || [])]
      });
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

  assert.equal(queriedCalls.length, 2);
  assert.deepEqual(queriedCalls[0].geometry, { x: 15, y: 20 });
  assert.deepEqual(queriedCalls[1].geometry, [
    [11, 16],
    [19, 24]
  ]);
  assert.ok(queriedCalls[1].layers.includes('region-buildings-7-part-fill'));
  assert.ok(queriedCalls[1].layers.includes('region-buildings-7-part-line'));
  assert.equal(dispatches.length, 1);
  assert.equal(dispatches[0].osmType, 'way');
  assert.equal(dispatches[0].osmId, 42);
  assert.equal(dispatches[0].feature.layer.id, 'region-buildings-7-part-fill');
});

test('createMapSelectionController applies hover filters and cursor for buffered building hover', async () => {
  const { createMapSelectionController } = await loadMapSelectionController();
  const filters = [];
  const queriedCalls = [];
  const canvas = { style: { cursor: '' } };
  const map = {
    getLayer(layerId) {
      return { id: layerId };
    },
    getCanvas() {
      return canvas;
    },
    queryRenderedFeatures(geometry, options: { layers?: string[] } = {}) {
      queriedCalls.push({
        geometry,
        layers: [...(options.layers || [])]
      });
      if ((options.layers || []).length === 2) {
        return [];
      }
      return [{
        id: 248,
        layer: { id: 'region-buildings-7-line' },
        properties: {
          osm_type: 'way',
          osm_id: 42
        }
      }];
    },
    setFilter(layerId, filter) {
      filters.push({ layerId, filter });
    },
    setLayoutProperty() {},
    on() {},
    off() {},
    once() {},
    easeTo() {},
    isStyleLoaded() {
      return true;
    }
  };

  const controller = createMapSelectionController({
    getMap: () => map,
    getActiveRegions: () => [{ id: 7 }],
    recordDebugSetFilter: () => {},
    debugSelectionLog: () => {}
  });

  controller.handleMapPointerMove({
    point: { x: 30, y: 40 }
  });

  assert.equal(queriedCalls.length, 2);
  assert.deepEqual(queriedCalls[0].geometry, { x: 30, y: 40 });
  assert.deepEqual(queriedCalls[1].geometry, [
    [26, 36],
    [34, 44]
  ]);
  assert.equal(canvas.style.cursor, 'pointer');
  assert.deepEqual(filters, [
    {
      layerId: 'region-buildings-7-hover-fill',
      filter: ['==', ['id'], 84]
    },
    {
      layerId: 'overpass-buildings-source-hover-fill',
      filter: ['==', ['id'], 84]
    },
    {
      layerId: 'region-buildings-7-hover-line',
      filter: ['==', ['id'], 84]
    },
    {
      layerId: 'overpass-buildings-source-hover-line',
      filter: ['==', ['id'], 84]
    }
  ]);

  filters.length = 0;
  controller.refreshHoverFromLastPointer();

  assert.equal(canvas.style.cursor, 'pointer');
  assert.deepEqual(filters, [
    {
      layerId: 'region-buildings-7-hover-fill',
      filter: ['==', ['id'], 84]
    },
    {
      layerId: 'overpass-buildings-source-hover-fill',
      filter: ['==', ['id'], 84]
    },
    {
      layerId: 'region-buildings-7-hover-line',
      filter: ['==', ['id'], 84]
    },
    {
      layerId: 'overpass-buildings-source-hover-line',
      filter: ['==', ['id'], 84]
    }
  ]);
});

test('createMapSelectionController ignores missing overpass layers during hover hit-testing', async () => {
  const { createMapSelectionController } = await loadMapSelectionController();
  const queriedCalls = [];
  const canvas = { style: { cursor: '' } };
  const map = {
    getLayer(layerId) {
      if (String(layerId || '').startsWith('overpass-buildings-source-')) return null;
      if (String(layerId || '').startsWith('search-results-')) return null;
      return { id: layerId };
    },
    getCanvas() {
      return canvas;
    },
    queryRenderedFeatures(geometry, options: { layers?: string[] } = {}) {
      queriedCalls.push({
        geometry,
        layers: [...(options.layers || [])]
      });
      return [];
    },
    setFilter() {},
    setLayoutProperty() {},
    on() {},
    off() {},
    once() {},
    easeTo() {},
    isStyleLoaded() {
      return true;
    }
  };

  const controller = createMapSelectionController({
    getMap: () => map,
    getActiveRegions: () => [{ id: 7 }],
    recordDebugSetFilter: () => {},
    debugSelectionLog: () => {}
  });

  assert.doesNotThrow(() => {
    controller.handleMapPointerMove({
      point: { x: 30, y: 40 }
    });
  });

  assert.equal(queriedCalls.length, 1);
  assert.deepEqual(queriedCalls[0].layers, [
    'region-buildings-7-line',
    'region-buildings-7-fill',
    'region-buildings-7-part-line',
    'region-buildings-7-part-fill'
  ]);
  assert.equal(canvas.style.cursor, '');
});

test('createMapSelectionController skips zoom on shift-click and forwards feature kind', async () => {
  const { createMapSelectionController } = await loadMapSelectionController();
  const { setMapSelectionShiftKey } = await loadModule('frontend/src/lib/stores/map.ts');
  const dispatches = [];
  let easeToCalls = 0;
  const map = {
    getLayer(layerId) {
      return { id: layerId };
    },
    queryRenderedFeatures(point, options: { layers?: string[] } = {}) {
      if (Array.isArray(options.layers) && options.layers.length === 2) {
        return [];
      }
      return [{
        id: 248,
        layer: { id: 'region-buildings-7-fill' },
        properties: {
          osm_type: 'way',
          osm_id: 42,
          feature_kind: 'building_part'
        }
      }];
    },
    setFilter() {},
    setLayoutProperty() {},
    on() {},
    off() {},
    once() {},
    easeTo() {
      easeToCalls += 1;
    }
  };

  const controller = createMapSelectionController({
    getMap: () => map,
    getActiveRegions: () => [{ id: 7 }],
    recordDebugSetFilter: () => {},
    debugSelectionLog: () => {},
    dispatchBuildingClick: (payload) => dispatches.push(payload)
  });

  try {
    setMapSelectionShiftKey(false);
    controller.handleMapBuildingClick({
      originalEvent: { timeStamp: 4321, shiftKey: true },
      point: { x: 11, y: 17 },
      lngLat: { lng: 37.5, lat: 55.7 }
    });

    setMapSelectionShiftKey(true);
    controller.handleMapBuildingClick({
      originalEvent: { timeStamp: 4322, shiftKey: false },
      point: { x: 12, y: 18 },
      lngLat: { lng: 37.6, lat: 55.8 }
    });
  } finally {
    setMapSelectionShiftKey(false);
  }

  assert.equal(easeToCalls, 0);
  assert.equal(dispatches.length, 2);
  assert.equal(dispatches[0].shiftKey, true);
  assert.equal(dispatches[1].shiftKey, true);
  assert.equal(dispatches[0].featureKind, 'building_part');
  assert.equal(dispatches[1].featureKind, 'building_part');
});

test('createMapSelectionController applies selection filters for multi-selection store values', async () => {
  const { createMapSelectionController } = await loadMapSelectionController();
  const filters = [];
  const map = {
    getLayer(layerId) {
      return { id: layerId };
    },
    queryRenderedFeatures() {
      return [];
    },
    setFilter(layerId, filter) {
      filters.push({ layerId, filter });
    },
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
    debugSelectionLog: () => {}
  });

  controller.applySelectionFromStore([
    { osmType: 'way', osmId: 10 },
    { osmType: 'relation', osmId: 11 }
  ]);

  assert.ok(filters.length > 0);
  assert.deepEqual(filters[0].filter, [
    'any',
    ['==', ['id'], 20],
    ['==', ['id'], 23]
  ]);
});

