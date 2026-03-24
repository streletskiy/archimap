const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const test = require('node:test');

let importCounter = 0;

async function loadMapLayerUtils() {
  const modulePath = path.join(process.cwd(), 'frontend', 'src', 'lib', 'services', 'map', 'map-layer-utils.ts');
  return import(`${pathToFileURL(modulePath).href}?v=${importCounter += 1}`);
}

function createMapStub() {
  const sources = new Map();
  const layers = new Map();
  const addedLayers = [];
  const layoutCalls = [];

  return {
    addedLayers,
    layoutCalls,
    layers,
    sources,
    getSource(sourceId) {
      return sources.get(sourceId) || null;
    },
    addSource(sourceId, source) {
      sources.set(sourceId, source);
    },
    getLayer(layerId) {
      return layers.get(layerId) || null;
    },
    addLayer(layer) {
      layers.set(layer.id, layer);
      addedLayers.push(layer);
    },
    removeLayer(layerId) {
      layers.delete(layerId);
    },
    removeSource(sourceId) {
      sources.delete(sourceId);
    },
    setPaintProperty(layerId, name, value) {
      const layer = layers.get(layerId);
      if (layer) {
        layer.paint = layer.paint || {};
        layer.paint[name] = value;
      }
    },
    setLayoutProperty(layerId, name, value) {
      layoutCalls.push({ layerId, name, value });
      const layer = layers.get(layerId);
      if (layer) {
        layer.layout = layer.layout || {};
        layer.layout[name] = value;
      }
    },
    isStyleLoaded() {
      return true;
    },
    off() {},
    on() {},
    moveLayer() {}
  };
}

test('ensureRegionBuildingSourceAndLayers adds building and part layers in stable order', async () => {
  const { ensureRegionBuildingSourceAndLayers } = await loadMapLayerUtils();
  const map = createMapStub();

  ensureRegionBuildingSourceAndLayers({
    map,
    region: {
      id: 7,
      url: '/regions/demo.pmtiles',
      sourceLayer: 'buildings'
    },
    buildingPaint: {
      fillColor: '#a3a3a3',
      fillOpacity: 1,
      lineColor: '#bcbcbc',
      lineWidth: 0.9,
      lineOpacity: 1
    },
    origin: 'http://localhost'
  });

  assert.deepEqual(map.addedLayers.map((layer) => layer.id), [
    'region-buildings-7-fill',
    'region-buildings-7-line',
    'region-buildings-7-part-fill',
    'region-buildings-7-part-line',
    'region-buildings-7-filter-highlight-fill',
    'region-buildings-7-filter-highlight-line',
    'region-buildings-7-part-filter-highlight-fill',
    'region-buildings-7-part-filter-highlight-line',
    'region-buildings-7-hover-fill',
    'region-buildings-7-hover-line',
    'region-buildings-7-selected-fill',
    'region-buildings-7-selected-line'
  ]);
  assert.deepEqual(map.layers.get('region-buildings-7-fill').filter, [
    '!=',
    ['coalesce', ['get', 'feature_kind'], 'building'],
    'building_part'
  ]);
  assert.deepEqual(map.layers.get('region-buildings-7-part-fill').filter, [
    '==',
    ['coalesce', ['get', 'feature_kind'], 'building'],
    'building_part'
  ]);
  assert.equal(map.layers.get('region-buildings-7-fill').paint['fill-opacity'], 1);
  assert.equal(map.layers.get('region-buildings-7-line').paint['line-opacity'], 1);
  assert.equal(map.layers.get('region-buildings-7-part-fill').paint['fill-opacity'], 1);
  assert.equal(map.layers.get('region-buildings-7-part-line').paint['line-opacity'], 1);
  assert.equal(map.layers.get('region-buildings-7-part-filter-highlight-fill').paint['fill-opacity'], 0);
  assert.equal(map.layers.get('region-buildings-7-part-filter-highlight-line').paint['line-opacity'], 0);
  assert.equal(map.layers.get('region-buildings-7-hover-fill').paint['fill-color'], '#c8bcae');
  assert.equal(map.layers.get('region-buildings-7-hover-fill').paint['fill-opacity'], 0.44);
  assert.equal(map.layers.get('region-buildings-7-hover-line').paint['line-color'], '#7d7063');
  assert.equal(map.layers.get('region-buildings-7-hover-line').paint['line-width'], 1.9);
  assert.equal(map.layers.get('region-buildings-7-part-fill').layout.visibility, 'visible');
  assert.equal(map.layers.get('region-buildings-7-part-line').layout.visibility, 'visible');
  assert.equal(map.layers.get('region-buildings-7-part-filter-highlight-fill').layout.visibility, 'none');
  assert.equal(map.layers.get('region-buildings-7-part-filter-highlight-line').layout.visibility, 'none');
});

test('applyBuildingThemePaint updates hover layers with hover theme paint', async () => {
  const { applyBuildingThemePaint } = await loadMapLayerUtils();
  const map = createMapStub();
  map.addLayer({ id: 'region-buildings-7-hover-fill', type: 'fill', paint: {} });
  map.addLayer({ id: 'region-buildings-7-hover-line', type: 'line', paint: {} });

  applyBuildingThemePaint({
    map,
    theme: 'dark',
    hoverFillLayerIds: ['region-buildings-7-hover-fill'],
    hoverLineLayerIds: ['region-buildings-7-hover-line']
  });

  assert.equal(map.layers.get('region-buildings-7-hover-fill').paint['fill-color'], '#7189a4');
  assert.equal(map.layers.get('region-buildings-7-hover-fill').paint['fill-opacity'], 0.44);
  assert.equal(map.layers.get('region-buildings-7-hover-line').paint['line-color'], '#d7e1ea');
  assert.equal(map.layers.get('region-buildings-7-hover-line').paint['line-width'], 1.9);
  assert.equal(map.layers.get('region-buildings-7-hover-line').paint['line-opacity'], 1);
});

test('ensureRegionBuildingSourceAndLayers applies initial hidden state for building parts', async () => {
  const { ensureRegionBuildingSourceAndLayers } = await loadMapLayerUtils();
  const map = createMapStub();

  ensureRegionBuildingSourceAndLayers({
    map,
    region: {
      id: 9,
      url: '/regions/demo.pmtiles',
      sourceLayer: 'buildings'
    },
    buildingPaint: {
      fillColor: '#a3a3a3',
      fillOpacity: 1,
      lineColor: '#bcbcbc',
      lineWidth: 0.9,
      lineOpacity: 1
    },
    origin: 'http://localhost',
    buildingPartsVisible: false,
    buildingPartHighlightVisible: false
  });

  assert.equal(map.layers.get('region-buildings-9-part-fill').layout.visibility, 'none');
  assert.equal(map.layers.get('region-buildings-9-part-line').layout.visibility, 'none');
  assert.equal(map.layers.get('region-buildings-9-part-filter-highlight-fill').layout.visibility, 'none');
  assert.equal(map.layers.get('region-buildings-9-part-filter-highlight-line').layout.visibility, 'none');
});

test('buildRegionBuildingHighlightFilterExpression excludes building parts when hidden', async () => {
  const { buildRegionBuildingHighlightFilterExpression } = await loadMapLayerUtils();

  assert.deepEqual(buildRegionBuildingHighlightFilterExpression({
    featureIds: [11],
    showBuildingParts: false
  }), [
    'all',
    ['!=', ['coalesce', ['get', 'feature_kind'], 'building'], 'building_part'],
    ['in', ['id'], ['literal', [11]]]
  ]);
});

test('applyBuildingPartsLayerVisibility toggles part layer visibility together', async () => {
  const { applyBuildingPartsLayerVisibility } = await loadMapLayerUtils();
  const map = createMapStub();
  map.addLayer({ id: 'region-buildings-7-part-fill', type: 'fill', paint: {} });
  map.addLayer({ id: 'region-buildings-7-part-line', type: 'line', paint: {} });
  map.addLayer({ id: 'region-buildings-7-part-filter-highlight-fill', type: 'fill', paint: {} });
  map.addLayer({ id: 'region-buildings-7-part-filter-highlight-line', type: 'line', paint: {} });

  applyBuildingPartsLayerVisibility({
    map,
    visible: false,
    partFillLayerIds: ['region-buildings-7-part-fill'],
    partLineLayerIds: ['region-buildings-7-part-line'],
    partFilterHighlightFillLayerIds: ['region-buildings-7-part-filter-highlight-fill'],
    partFilterHighlightLineLayerIds: ['region-buildings-7-part-filter-highlight-line']
  });

  assert.deepEqual(map.layoutCalls, [
    { layerId: 'region-buildings-7-part-fill', name: 'visibility', value: 'none' },
    { layerId: 'region-buildings-7-part-line', name: 'visibility', value: 'none' },
    { layerId: 'region-buildings-7-part-filter-highlight-fill', name: 'visibility', value: 'none' },
    { layerId: 'region-buildings-7-part-filter-highlight-line', name: 'visibility', value: 'none' }
  ]);
});

test('applyBuildingPartsLayerVisibility keeps part highlight layers visible for active filters', async () => {
  const { applyBuildingPartsLayerVisibility } = await loadMapLayerUtils();
  const map = createMapStub();
  map.addLayer({ id: 'region-buildings-7-part-fill', type: 'fill', paint: {} });
  map.addLayer({ id: 'region-buildings-7-part-line', type: 'line', paint: {} });
  map.addLayer({ id: 'region-buildings-7-part-filter-highlight-fill', type: 'fill', paint: {} });
  map.addLayer({ id: 'region-buildings-7-part-filter-highlight-line', type: 'line', paint: {} });

  applyBuildingPartsLayerVisibility({
    map,
    visible: false,
    forceHighlightVisible: true,
    partFillLayerIds: ['region-buildings-7-part-fill'],
    partLineLayerIds: ['region-buildings-7-part-line'],
    partFilterHighlightFillLayerIds: ['region-buildings-7-part-filter-highlight-fill'],
    partFilterHighlightLineLayerIds: ['region-buildings-7-part-filter-highlight-line']
  });

  assert.deepEqual(map.layoutCalls, [
    { layerId: 'region-buildings-7-part-fill', name: 'visibility', value: 'none' },
    { layerId: 'region-buildings-7-part-line', name: 'visibility', value: 'none' },
    { layerId: 'region-buildings-7-part-filter-highlight-fill', name: 'visibility', value: 'visible' },
    { layerId: 'region-buildings-7-part-filter-highlight-line', name: 'visibility', value: 'visible' }
  ]);
});

