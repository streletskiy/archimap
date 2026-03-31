const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const test = require('node:test');

let importCounter = 0;

async function loadMapLayerUtils() {
  const modulePath = path.join(process.cwd(), 'frontend', 'src', 'lib', 'services', 'map', 'map-layer-utils.ts');
  return import(`${pathToFileURL(modulePath).href}?v=${importCounter += 1}`);
}

function createMapStub({ styleLoaded = true } = {}) {
  const sources = new Map();
  const layers = new Map();
  const addedLayers = [];
  const layoutCalls = [];
  const moveCalls = [];

  function setLayerOrder(entries) {
    layers.clear();
    for (const [layerId, layer] of entries) {
      layers.set(layerId, layer);
    }
  }

  return {
    addedLayers,
    layoutCalls,
    moveCalls,
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
      const nextLayers = Array.from(layers.entries()).filter(([existingLayerId]) => existingLayerId !== layer.id);
      nextLayers.push([layer.id, layer]);
      setLayerOrder(nextLayers);
      addedLayers.push(layer);
    },
    getStyle() {
      return {
        layers: Array.from(layers.values())
      };
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
      return styleLoaded;
    },
    off() {},
    on() {},
    moveLayer(layerId, beforeId) {
      const layer = layers.get(layerId);
      if (!layer) return;
      const nextLayers = Array.from(layers.entries()).filter(([existingLayerId]) => existingLayerId !== layerId);
      const beforeIndex = beforeId
        ? nextLayers.findIndex(([existingLayerId]) => existingLayerId === beforeId)
        : -1;
      if (beforeIndex >= 0) {
        nextLayers.splice(beforeIndex, 0, [layerId, layer]);
      } else {
        nextLayers.push([layerId, layer]);
      }
      setLayerOrder(nextLayers);
      moveCalls.push({ layerId, beforeId });
    }
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
  assert.equal(map.layers.get('region-buildings-7-hover-fill').paint['fill-opacity'], 0.3);
  assert.equal(map.layers.get('region-buildings-7-hover-line').paint['line-color'], '#7d7063');
  assert.equal(map.layers.get('region-buildings-7-hover-line').paint['line-width'], 1.2);
  assert.equal(map.layers.get('region-buildings-7-part-fill').layout.visibility, 'visible');
  assert.equal(map.layers.get('region-buildings-7-part-line').layout.visibility, 'visible');
  assert.equal(map.layers.get('region-buildings-7-part-filter-highlight-fill').layout.visibility, 'none');
  assert.equal(map.layers.get('region-buildings-7-part-filter-highlight-line').layout.visibility, 'none');
});

test('getBasemapBuildingLayerIds resolves provider-specific base building layers', async () => {
  const {
    getBasemapBuildingLayerIds,
    getBasemapSuppressedLayerIds
  } = await loadMapLayerUtils();

  assert.deepEqual(getBasemapBuildingLayerIds('carto'), ['building', 'building-top']);
  assert.deepEqual(getBasemapBuildingLayerIds('maptiler'), ['Building']);
  assert.deepEqual(getBasemapBuildingLayerIds('unknown'), ['building', 'building-top']);
  assert.deepEqual(getBasemapSuppressedLayerIds('carto'), []);
  assert.deepEqual(getBasemapSuppressedLayerIds('maptiler'), ['Building 3D']);
});

test('ensureOverpassBuildingSourceAndLayers applies the same selected styling as pmtiles layers', async () => {
  const { ensureOverpassBuildingSourceAndLayers } = await loadMapLayerUtils();
  const map = createMapStub();

  ensureOverpassBuildingSourceAndLayers({
    map,
    data: {
      type: 'FeatureCollection',
      features: []
    },
    buildingPaint: {
      fillColor: '#a3a3a3',
      fillOpacity: 1,
      lineColor: '#bcbcbc',
      lineWidth: 0.9,
      lineOpacity: 1
    }
  });

  assert.equal(map.layers.get('overpass-buildings-source-fill').paint['fill-color'], '#a3a3a3');
  assert.equal(map.layers.get('overpass-buildings-source-fill').paint['fill-opacity'], 1);
  assert.equal(map.layers.get('overpass-buildings-source-line').paint['line-color'], '#bcbcbc');
  assert.equal(map.layers.get('overpass-buildings-source-line').paint['line-width'], 0.9);
  assert.equal(map.layers.get('overpass-buildings-source-selected-fill').paint['fill-color'], '#6d655b');
  assert.equal(map.layers.get('overpass-buildings-source-selected-fill').paint['fill-opacity'], 0.72);
  assert.equal(map.layers.get('overpass-buildings-source-selected-line').paint['line-color'], '#3d3832');
  assert.equal(map.layers.get('overpass-buildings-source-selected-line').paint['line-width'], 2.2);
  assert.equal(map.layers.get('overpass-buildings-source-selected-line').paint['line-opacity'], 1);
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
  assert.equal(map.layers.get('region-buildings-7-hover-fill').paint['fill-opacity'], 0.3);
  assert.equal(map.layers.get('region-buildings-7-hover-line').paint['line-color'], '#d7e1ea');
  assert.equal(map.layers.get('region-buildings-7-hover-line').paint['line-width'], 1.2);
  assert.equal(map.layers.get('region-buildings-7-hover-line').paint['line-opacity'], 0.9);
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

test('applyLabelLayerVisibility hides symbol layers even when style is not reported as loaded', async () => {
  const { applyLabelLayerVisibility } = await loadMapLayerUtils();
  const map = createMapStub({ styleLoaded: false });
  map.addLayer({ id: 'waterway_label', type: 'symbol', layout: { visibility: 'visible' } });
  map.addLayer({ id: 'Food', type: 'symbol', 'source-layer': 'poi', layout: { visibility: 'none' } });
  map.addLayer({ id: 'landcover', type: 'fill', layout: { visibility: 'visible' } });
  map.addLayer({ id: 'search-results-points-layer', type: 'symbol', layout: { visibility: 'visible' } });

  applyLabelLayerVisibility(map, false);

  assert.deepEqual(map.layoutCalls, [
    { layerId: 'waterway_label', name: 'visibility', value: 'none' }
  ]);
  assert.equal(map.layers.get('waterway_label').layout.visibility, 'none');
  assert.equal(map.layers.get('Food').layout.visibility, 'none');
  assert.equal(map.layers.get('landcover').layout.visibility, 'visible');
  assert.equal(map.layers.get('search-results-points-layer').layout.visibility, 'visible');
});

test('applyLabelLayerVisibility does not force hidden MapTiler POI layers visible again', async () => {
  const { applyLabelLayerVisibility } = await loadMapLayerUtils();
  const map = createMapStub();
  map.addLayer({ id: 'Food', type: 'symbol', 'source-layer': 'poi', layout: { visibility: 'none' } });
  map.addLayer({ id: 'Road labels', type: 'symbol', 'source-layer': 'transportation_name', layout: { visibility: 'none' } });

  applyLabelLayerVisibility(map, true);

  assert.deepEqual(map.layoutCalls, [
    { layerId: 'Road labels', name: 'visibility', value: 'visible' }
  ]);
  assert.equal(map.layers.get('Food').layout.visibility, 'none');
  assert.equal(map.layers.get('Road labels').layout.visibility, 'visible');
});

test('applyLabelLayerVisibility does not force hidden ferry labels visible again', async () => {
  const { applyLabelLayerVisibility } = await loadMapLayerUtils();
  const map = createMapStub();
  map.addLayer({
    id: 'Ferry',
    type: 'symbol',
    'source-layer': 'transportation_name',
    filter: ['==', 'class', 'ferry'],
    layout: { visibility: 'none' }
  });
  map.addLayer({
    id: 'Road labels',
    type: 'symbol',
    'source-layer': 'transportation_name',
    filter: ['all', ['!in', 'class', 'ferry', 'service']],
    layout: { visibility: 'none' }
  });

  applyLabelLayerVisibility(map, true);

  assert.deepEqual(map.layoutCalls, [
    { layerId: 'Road labels', name: 'visibility', value: 'visible' }
  ]);
  assert.equal(map.layers.get('Ferry').layout.visibility, 'none');
  assert.equal(map.layers.get('Road labels').layout.visibility, 'visible');
});

test('bringBaseLabelLayersAboveCustomLayers keeps labels above building layers but below search results', async () => {
  const { bringBaseLabelLayersAboveCustomLayers } = await loadMapLayerUtils();
  const map = createMapStub();

  map.addLayer({ id: 'building', type: 'fill', paint: {} });
  map.addLayer({ id: 'waterway_label', type: 'symbol', paint: {} });
  map.addLayer({ id: 'city_label', type: 'symbol', paint: {} });
  map.addLayer({ id: 'region-buildings-7-fill', type: 'fill', paint: {} });
  map.addLayer({ id: 'overpass-buildings-source-fill', type: 'fill', paint: {} });
  map.addLayer({ id: 'search-results-clusters-layer', type: 'circle', paint: {} });
  map.addLayer({ id: 'search-results-clusters-count-layer', type: 'symbol', paint: {} });
  map.addLayer({ id: 'search-results-points-layer', type: 'circle', paint: {} });

  bringBaseLabelLayersAboveCustomLayers(map);

  assert.deepEqual(Array.from(map.layers.keys()), [
    'building',
    'region-buildings-7-fill',
    'overpass-buildings-source-fill',
    'waterway_label',
    'city_label',
    'search-results-clusters-layer',
    'search-results-clusters-count-layer',
    'search-results-points-layer'
  ]);
  assert.deepEqual(map.moveCalls, [
    { layerId: 'waterway_label', beforeId: 'search-results-clusters-layer' },
    { layerId: 'city_label', beforeId: 'search-results-clusters-layer' }
  ]);
});

test('applyBuildingPartsLayerVisibility still applies part visibility before style loaded flag flips true', async () => {
  const { applyBuildingPartsLayerVisibility } = await loadMapLayerUtils();
  const map = createMapStub({ styleLoaded: false });
  map.addLayer({ id: 'region-buildings-7-part-fill', type: 'fill', paint: {} });
  map.addLayer({ id: 'region-buildings-7-part-line', type: 'line', paint: {} });

  applyBuildingPartsLayerVisibility({
    map,
    visible: false,
    partFillLayerIds: ['region-buildings-7-part-fill'],
    partLineLayerIds: ['region-buildings-7-part-line']
  });

  assert.deepEqual(map.layoutCalls, [
    { layerId: 'region-buildings-7-part-fill', name: 'visibility', value: 'none' },
    { layerId: 'region-buildings-7-part-line', name: 'visibility', value: 'none' }
  ]);
  assert.equal(map.layers.get('region-buildings-7-part-fill').layout.visibility, 'none');
  assert.equal(map.layers.get('region-buildings-7-part-line').layout.visibility, 'none');
});

