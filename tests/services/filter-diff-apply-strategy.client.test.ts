const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const test = require('node:test');

let importCounter = 0;

async function loadFilterDiffApplyStrategy() {
  const modulePath = path.join(process.cwd(), 'frontend', 'src', 'lib', 'services', 'map', 'filter-diff-apply-strategy.ts');
  return import(`${pathToFileURL(modulePath).href}?v=${importCounter += 1}`);
}

function createMapStub() {
  const filters = new Map();
  const paintCalls = [];

  return {
    filters,
    paintCalls,
    getLayer() {
      return { id: 'stub-layer' };
    },
    setFilter(layerId, expr) {
      filters.set(layerId, expr);
    },
    setPaintProperty(layerId, name, value) {
      paintCalls.push({ layerId, name, value });
    }
  };
}

function createMarkerMapStub() {
  const sources = new Map();
  const layers = new Map();
  const addedLayers = [];
  const removedLayers = [];
  const removedSources = [];

  return {
    sources,
    layers,
    addedLayers,
    removedLayers,
    removedSources,
    getLayer(layerId) {
      return layers.get(layerId) || null;
    },
    addSource(sourceId, source) {
      const storedSource = {
        ...source,
        setData(data) {
          this.data = data;
        }
      };
      if (source?.data) {
        storedSource.data = source.data;
      }
      sources.set(sourceId, storedSource);
    },
    removeSource(sourceId) {
      removedSources.push(sourceId);
      sources.delete(sourceId);
    },
    addLayer(layer, beforeId) {
      layers.set(layer.id, {
        ...layer,
        beforeId
      });
      addedLayers.push({
        id: layer.id,
        beforeId
      });
    },
    removeLayer(layerId) {
      removedLayers.push(layerId);
      layers.delete(layerId);
    },
    setFilter(layerId, expr) {
      const layer = layers.get(layerId);
      if (layer) {
        layer.filter = expr;
      }
    },
    setPaintProperty(layerId, name, value) {
      const layer = layers.get(layerId);
      if (layer) {
        layer.paint = layer.paint || {};
        layer.paint[name] = value;
      }
    },
    setLayoutProperty(layerId, name, value) {
      const layer = layers.get(layerId);
      if (layer) {
        layer.layout = layer.layout || {};
        layer.layout[name] = value;
      }
    },
    getSource(sourceId) {
      return sources.get(sourceId) || null;
    }
  };
}

test('createFilterDiffApplyStrategy filters building parts separately and hides them from highlight overlay', async () => {
  const { createFilterDiffApplyStrategy } = await loadFilterDiffApplyStrategy();
  const map = createMapStub();
  const strategy = createFilterDiffApplyStrategy({
    resolveMap: () => map,
    resolveLayerIds: () => ({
      buildingFillLayerIds: ['building-fill'],
      buildingLineLayerIds: ['building-line'],
      buildingPartFillLayerIds: ['part-fill'],
      buildingPartLineLayerIds: ['part-line'],
      filterHighlightFillLayerIds: ['highlight-fill'],
      filterHighlightLineLayerIds: ['highlight-line'],
      buildingPartFilterHighlightFillLayerIds: ['part-highlight-fill'],
      buildingPartFilterHighlightLineLayerIds: ['part-highlight-line']
    }),
    getBuildingPartsVisible: () => false,
    getLatestFilterToken: () => 1,
    patchState: () => {},
    debugFilterLog: () => {},
    recordFilterTelemetry: () => {},
    updateFilterRuntimeStatus: () => {},
    updateFilterDebugHook: () => {},
    getCurrentPhase: () => 'apply',
    highlightMode: 'layer'
  });

  await strategy.applyFilteredFeaturePaintGroups([
    { color: '#ff0000', ids: [202] }
  ], 1, {
    matchedFeatureIds: [202],
    buildingPartsVisible: false
  });

  assert.equal(map.filters.has('building-fill'), false);
  assert.equal(map.filters.has('building-line'), false);
  assert.deepEqual(map.filters.get('part-fill'), [
    'all',
    ['==', ['coalesce', ['get', 'feature_kind'], 'building'], 'building_part'],
    ['in', ['id'], ['literal', [202]]]
  ]);
  assert.deepEqual(map.filters.get('highlight-fill'), [
    'all',
    ['!=', ['coalesce', ['get', 'feature_kind'], 'building'], 'building_part'],
    ['in', ['id'], ['literal', [202]]]
  ]);
  assert.deepEqual(map.filters.get('part-highlight-fill'), [
    'all',
    ['==', ['coalesce', ['get', 'feature_kind'], 'building'], 'building_part'],
    ['in', ['id'], ['literal', [202]]]
  ]);
});

test('createFilterDiffApplyStrategy renders clustered fallback markers below zoom 13', async () => {
  const { createFilterDiffApplyStrategy } = await loadFilterDiffApplyStrategy();
  const map = createMarkerMapStub();
  const strategy = createFilterDiffApplyStrategy({
    resolveMap: () => map,
    resolveLayerIds: () => ({
      buildingFillLayerIds: [],
      buildingLineLayerIds: [],
      buildingPartFillLayerIds: [],
      buildingPartLineLayerIds: [],
      filterHighlightFillLayerIds: ['highlight-fill'],
      filterHighlightLineLayerIds: ['highlight-line'],
      buildingPartFilterHighlightFillLayerIds: [],
      buildingPartFilterHighlightLineLayerIds: []
    }),
    getBuildingPartsVisible: () => true,
    getLatestFilterToken: () => 1,
    patchState: () => {},
    debugFilterLog: () => {},
    recordFilterTelemetry: () => {},
    updateFilterRuntimeStatus: () => {},
    updateFilterDebugHook: () => {},
    getCurrentPhase: () => 'apply',
    highlightMode: 'layer'
  });

  await strategy.applyFilteredFeaturePaintGroups([
    {
      color: '#ff0000',
      ids: [202],
      points: [
        { id: 202, lon: 37.62, lat: 55.76, count: 4, osmKey: 'way/101' }
      ]
    }
  ], 1, {
    matchedFeatureIds: [202],
    matchedCount: 4,
    renderMode: 'markers'
  });

  assert.ok(map.sources.has('filter-fallback-points-ff0000'));
  assert.deepEqual(map.addedLayers.map((entry) => entry.id), [
    'filter-fallback-points-ff0000-clusters',
    'filter-fallback-points-ff0000-counts',
    'filter-fallback-points-ff0000-points'
  ]);
  assert.equal(map.getSource('filter-fallback-points-ff0000').data.features.length, 1);
  assert.equal(map.getSource('filter-fallback-points-ff0000').data.features[0].properties.filter_color, '#ff0000');
  assert.equal(map.getSource('filter-fallback-points-ff0000').data.features[0].properties.match_count, 4);
});

