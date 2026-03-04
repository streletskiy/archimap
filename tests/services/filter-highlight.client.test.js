const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const test = require('node:test');

async function loadFilterHighlightUtils() {
  const modulePath = path.join(process.cwd(), 'frontend', 'src', 'lib', 'components', 'map', 'filter-highlight-utils.js');
  return import(pathToFileURL(modulePath).href);
}

test('buildFilterHighlightExpression creates deterministic id expression', async () => {
  const { buildFilterHighlightExpression } = await loadFilterHighlightUtils();
  const result = buildFilterHighlightExpression({ encodedIds: [44, 44, 45, 'bad', -1], osmIds: [22, 22, 23] });
  assert.deepEqual(result.expr, [
    'any',
    ['match', ['id'], ['literal', [44, 45]], true, false],
    ['match', ['to-number', ['coalesce', ['get', 'osm_id'], -1]], ['literal', [22, 23]], true, false]
  ]);
  assert.equal(result.count, 2);
});

test('buildFilterHighlightExpression returns empty filter when criteria has no ids', async () => {
  const { buildFilterHighlightExpression, EMPTY_LAYER_FILTER } = await loadFilterHighlightUtils();
  assert.deepEqual(buildFilterHighlightExpression([]).expr, EMPTY_LAYER_FILTER);
  assert.deepEqual(buildFilterHighlightExpression(null).expr, EMPTY_LAYER_FILTER);
});

test('applyFilterHighlight only applies setFilter to highlight layers, not base building layers', async () => {
  const { applyFilterHighlight } = await loadFilterHighlightUtils();
  const calls = [];
  const map = {
    getLayer(layerId) {
      return {
        id: layerId
      };
    },
    setFilter(layerId, expr) {
      calls.push({ type: 'setFilter', layerId, expr });
    },
    setLayoutProperty(layerId, name, value) {
      calls.push({ type: 'setLayoutProperty', layerId, name, value });
    }
  };

  const result = applyFilterHighlight({
    map,
    matched: { encodedIds: [101, 102], osmIds: [50, 51] },
    fillLayerId: 'buildings-filter-highlight-fill',
    lineLayerId: 'buildings-filter-highlight-outline'
  });

  const filteredLayers = calls.filter((entry) => entry.type === 'setFilter').map((entry) => entry.layerId);
  assert.deepEqual(filteredLayers, ['buildings-filter-highlight-fill', 'buildings-filter-highlight-outline']);
  assert.equal(filteredLayers.includes('local-buildings-fill'), false);
  assert.equal(filteredLayers.includes('local-buildings-line'), false);
  assert.equal(result.active, true);
  assert.equal(result.count, 2);
});
