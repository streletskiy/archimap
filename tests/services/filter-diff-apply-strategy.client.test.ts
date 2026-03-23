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

