const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const test = require('node:test');

let importCounter = 0;

async function loadBuildingRendererMapLibre() {
  const modulePath = path.join(process.cwd(), 'frontend', 'src', 'lib', 'services', 'map', 'building-renderer-maplibre.ts');
  return import(`${pathToFileURL(modulePath).href}?v=${(importCounter += 1)}`);
}

function createMapStub() {
  const sources = new Map();
  const layers = new Map();
  const layoutCalls = [];

  function setLayerOrder(entries) {
    layers.clear();
    for (const [layerId, layer] of entries) {
      layers.set(layerId, layer);
    }
  }

  return {
    sources,
    layers,
    layoutCalls,
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
    },
    removeLayer(layerId) {
      layers.delete(layerId);
    },
    removeSource(sourceId) {
      sources.delete(sourceId);
    },
    setPaintProperty(layerId, name, value) {
      const layer = layers.get(layerId);
      if (!layer) return;
      layer.paint = layer.paint || {};
      layer.paint[name] = value;
    },
    setLayoutProperty(layerId, name, value) {
      layoutCalls.push({ layerId, name, value });
      const layer = layers.get(layerId);
      if (!layer) return;
      layer.layout = layer.layout || {};
      layer.layout[name] = value;
    },
    setFilter(layerId, filter) {
      const layer = layers.get(layerId);
      if (!layer) return;
      layer.filter = filter;
    },
    getStyle() {
      return {
        layers: Array.from(layers.values())
      };
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
    }
  };
}

test('building-renderer-maplibre adds region layers through the backend contract', async () => {
  const { BUILDING_RENDERER_KIND, getMapLibreBuildingRenderer } = await loadBuildingRendererMapLibre();
  const renderer = getMapLibreBuildingRenderer();
  const map = createMapStub();

  assert.equal(BUILDING_RENDERER_KIND, 'maplibre-extrusion');
  assert.equal(renderer.kind, 'maplibre-extrusion');

  renderer.ensureRegionBuildingSourceAndLayers({
    map,
    region: {
      id: 7,
      url: '/regions/demo.pmtiles',
      sourceLayer: 'buildings'
    },
    buildingPaint: {
      fillColor: '#d3d3d1',
      fillOpacity: 1,
      lineColor: '#a9a9a9',
      lineWidth: 0.9,
      lineOpacity: 1
    },
    origin: 'http://localhost',
    buildings3dEnabled: true,
    buildingPartsVisible: true
  });

  assert.deepEqual(map.getSource('region-buildings-7'), {
    type: 'vector',
    url: 'pmtiles://http://localhost/regions/demo.pmtiles'
  });
  assert.equal(map.getLayer('region-buildings-7-extrusion').layout.visibility, 'visible');
  assert.equal(map.getLayer('region-buildings-7-fill').layout.visibility, 'none');
  assert.equal(map.getLayer('region-buildings-7-part-extrusion').layout.visibility, 'visible');
  assert.equal(map.getLayer('region-buildings-7-part-fill').layout.visibility, 'none');
  assert.deepEqual(map.getLayer('region-buildings-7-extrusion').paint, {
    'fill-extrusion-color': '#d3d3d1',
    'fill-extrusion-opacity': 1,
    'fill-extrusion-base': ['coalesce', ['to-number', ['get', 'render_min_height_m']], 0],
    'fill-extrusion-height': ['coalesce', ['to-number', ['get', 'render_height_m']], 0],
    'fill-extrusion-vertical-gradient': false
  });
});

test('building-renderer-maplibre switches building overlays in 3d mode', async () => {
  const { getMapLibreBuildingRenderer } = await loadBuildingRendererMapLibre();
  const renderer = getMapLibreBuildingRenderer();
  const map = createMapStub();
  map.addLayer({ id: 'region-buildings-7-fill', type: 'fill', paint: {} });
  map.addLayer({ id: 'region-buildings-7-extrusion', type: 'fill-extrusion', paint: {} });
  map.addLayer({ id: 'region-buildings-7-line', type: 'line', paint: {} });
  map.addLayer({ id: 'region-buildings-7-filter-highlight-extrusion', type: 'fill-extrusion', paint: {} });
  map.addLayer({ id: 'region-buildings-7-filter-highlight-fill', type: 'fill', paint: {} });
  map.addLayer({ id: 'region-buildings-7-filter-highlight-line', type: 'line', paint: {} });
  map.addLayer({ id: 'region-buildings-7-part-fill', type: 'fill', paint: {} });
  map.addLayer({ id: 'region-buildings-7-part-extrusion', type: 'fill-extrusion', paint: {} });
  map.addLayer({ id: 'region-buildings-7-part-line', type: 'line', paint: {} });
  map.addLayer({ id: 'region-buildings-7-part-filter-highlight-extrusion', type: 'fill-extrusion', paint: {} });
  map.addLayer({ id: 'region-buildings-7-part-filter-highlight-fill', type: 'fill', paint: {} });
  map.addLayer({ id: 'region-buildings-7-part-filter-highlight-line', type: 'line', paint: {} });
  map.addLayer({ id: 'region-buildings-7-hover-extrusion', type: 'fill-extrusion', paint: {} });
  map.addLayer({ id: 'region-buildings-7-hover-fill', type: 'fill', paint: {} });
  map.addLayer({ id: 'region-buildings-7-hover-line', type: 'line', paint: {} });
  map.addLayer({ id: 'region-buildings-7-selected-extrusion', type: 'fill-extrusion', paint: {} });
  map.addLayer({ id: 'region-buildings-7-selected-fill', type: 'fill', paint: {} });
  map.addLayer({ id: 'region-buildings-7-selected-line', type: 'line', paint: {} });

  renderer.applyBuildingPartsLayerVisibility({
    map,
    buildings3dEnabled: true,
    fillLayerIds: ['region-buildings-7-fill'],
    extrusionLayerIds: ['region-buildings-7-extrusion'],
    lineLayerIds: ['region-buildings-7-line'],
    filterHighlightExtrusionLayerIds: ['region-buildings-7-filter-highlight-extrusion'],
    filterHighlightFillLayerIds: ['region-buildings-7-filter-highlight-fill'],
    filterHighlightLineLayerIds: ['region-buildings-7-filter-highlight-line'],
    partFillLayerIds: ['region-buildings-7-part-fill'],
    partExtrusionLayerIds: ['region-buildings-7-part-extrusion'],
    partLineLayerIds: ['region-buildings-7-part-line'],
    partFilterHighlightExtrusionLayerIds: ['region-buildings-7-part-filter-highlight-extrusion'],
    partFilterHighlightFillLayerIds: ['region-buildings-7-part-filter-highlight-fill'],
    partFilterHighlightLineLayerIds: ['region-buildings-7-part-filter-highlight-line'],
    hoverExtrusionLayerIds: ['region-buildings-7-hover-extrusion'],
    hoverFillLayerIds: ['region-buildings-7-hover-fill'],
    hoverLineLayerIds: ['region-buildings-7-hover-line'],
    selectedExtrusionLayerIds: ['region-buildings-7-selected-extrusion'],
    selectedFillLayerIds: ['region-buildings-7-selected-fill'],
    selectedLineLayerIds: ['region-buildings-7-selected-line']
  });

  assert.equal(map.getLayer('region-buildings-7-extrusion').layout.visibility, 'visible');
  assert.equal(map.getLayer('region-buildings-7-fill').layout.visibility, 'none');
  assert.equal(map.getLayer('region-buildings-7-part-extrusion').layout.visibility, 'visible');
  assert.equal(map.getLayer('region-buildings-7-part-fill').layout.visibility, 'none');
  assert.equal(map.getLayer('region-buildings-7-hover-extrusion').layout.visibility, 'visible');
  assert.equal(map.getLayer('region-buildings-7-hover-fill').layout.visibility, 'none');
  assert.equal(map.getLayer('region-buildings-7-selected-extrusion').layout.visibility, 'visible');
  assert.equal(map.getLayer('region-buildings-7-selected-fill').layout.visibility, 'none');
});
