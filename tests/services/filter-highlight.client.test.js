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
    ['in', ['id'], ['literal', [44, 45]]],
    ['in', ['to-number', ['coalesce', ['get', 'osm_id'], -1]], ['literal', [22, 23]]]
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

test('buildFilterPaintExpression groups ids by color and falls back to transparent', async () => {
  const { buildFilterPaintExpression, buildFilterActiveValueExpression } = await loadFilterHighlightUtils();

  const colorResult = buildFilterPaintExpression([
    { color: '#ff0000', ids: [44, 44, 45, 'bad'] },
    { color: '#00ff00', ids: [46, -1] },
    { color: '', ids: [47] }
  ]);
  assert.deepEqual(colorResult.expr, [
    'match',
    ['id'],
    [44, 45],
    '#ff0000',
    [46],
    '#00ff00',
    'transparent'
  ]);
  assert.equal(colorResult.count, 3);

  const opacityResult = buildFilterActiveValueExpression([
    { color: '#ff0000', ids: [44, 45] },
    { color: '#00ff00', ids: [46] }
  ], 0.4, 0);
  assert.deepEqual(opacityResult.expr, [
    'match',
    ['id'],
    [44, 45, 46],
    0.4,
    0
  ]);
});

test('applyFilterPaintHighlight updates only highlight paint properties and resets to transparent', async () => {
  const { applyFilterPaintHighlight } = await loadFilterHighlightUtils();
  const calls = [];
  const map = {
    getLayer(layerId) {
      return { id: layerId };
    },
    setFilter(layerId, expr) {
      calls.push({ type: 'setFilter', layerId, expr });
    },
    setPaintProperty(layerId, name, value) {
      calls.push({ type: 'setPaintProperty', layerId, name, value });
    }
  };

  const applied = applyFilterPaintHighlight({
    map,
    colorGroups: [
      { color: '#ff0000', ids: [101, 102] },
      { color: '#00ff00', ids: [203] }
    ],
    fillLayerIds: ['buildings-filter-highlight-fill'],
    lineLayerIds: ['buildings-filter-highlight-outline']
  });
  assert.equal(applied.active, true);
  assert.equal(applied.count, 3);
  assert.equal(applied.paintPropertyCalls, 5);
  assert.deepEqual(calls[0], {
    type: 'setFilter',
    layerId: 'buildings-filter-highlight-fill',
    expr: ['in', ['id'], ['literal', [101, 102, 203]]]
  });
  assert.deepEqual(calls[1], {
    type: 'setPaintProperty',
    layerId: 'buildings-filter-highlight-fill',
    name: 'fill-color',
    value: [
      'match',
      ['id'],
      [101, 102],
      '#ff0000',
      [203],
      '#00ff00',
      'transparent'
    ]
  });
  assert.deepEqual(calls[2], {
    type: 'setPaintProperty',
    layerId: 'buildings-filter-highlight-fill',
    name: 'fill-opacity',
    value: 0.4
  });
  assert.deepEqual(calls[3], {
    type: 'setFilter',
    layerId: 'buildings-filter-highlight-outline',
    expr: ['in', ['id'], ['literal', [101, 102, 203]]]
  });
  assert.deepEqual(calls[4], {
    type: 'setPaintProperty',
    layerId: 'buildings-filter-highlight-outline',
    name: 'line-color',
    value: [
      'match',
      ['id'],
      [101, 102],
      '#ff0000',
      [203],
      '#00ff00',
      'transparent'
    ]
  });
  assert.deepEqual(calls[5], {
    type: 'setPaintProperty',
    layerId: 'buildings-filter-highlight-outline',
    name: 'line-width',
    value: 1.8
  });
  assert.deepEqual(calls[6], {
    type: 'setPaintProperty',
    layerId: 'buildings-filter-highlight-outline',
    name: 'line-opacity',
    value: 0.95
  });

  calls.length = 0;
  const cleared = applyFilterPaintHighlight({
    map,
    colorGroups: [],
    fillLayerIds: ['buildings-filter-highlight-fill'],
    lineLayerIds: ['buildings-filter-highlight-outline']
  });
  assert.equal(cleared.active, false);
  assert.equal(cleared.count, 0);
  assert.deepEqual(calls, [
    {
      type: 'setFilter',
      layerId: 'buildings-filter-highlight-fill',
      expr: ['==', ['id'], -1]
    },
    {
      type: 'setPaintProperty',
      layerId: 'buildings-filter-highlight-fill',
      name: 'fill-color',
      value: 'transparent'
    },
    {
      type: 'setPaintProperty',
      layerId: 'buildings-filter-highlight-fill',
      name: 'fill-opacity',
      value: 0
    },
    {
      type: 'setFilter',
      layerId: 'buildings-filter-highlight-outline',
      expr: ['==', ['id'], -1]
    },
    {
      type: 'setPaintProperty',
      layerId: 'buildings-filter-highlight-outline',
      name: 'line-color',
      value: 'transparent'
    },
    {
      type: 'setPaintProperty',
      layerId: 'buildings-filter-highlight-outline',
      name: 'line-width',
      value: 0
    },
    {
      type: 'setPaintProperty',
      layerId: 'buildings-filter-highlight-outline',
      name: 'line-opacity',
      value: 0
    }
  ]);
});

test('applyFilterPaintHighlight uses constant color for a single normalized color group', async () => {
  const { applyFilterPaintHighlight } = await loadFilterHighlightUtils();
  const calls = [];
  const map = {
    getLayer(layerId) {
      return { id: layerId };
    },
    setFilter(layerId, expr) {
      calls.push({ type: 'setFilter', layerId, expr });
    },
    setPaintProperty(layerId, name, value) {
      calls.push({ type: 'setPaintProperty', layerId, name, value });
    }
  };

  const applied = applyFilterPaintHighlight({
    map,
    normalizedColorGroups: [
      { color: '#f59e0b', ids: [11, 12, 13] }
    ],
    fillLayerIds: ['buildings-filter-highlight-fill'],
    lineLayerIds: ['buildings-filter-highlight-outline']
  });

  assert.equal(applied.active, true);
  assert.equal(applied.count, 3);
  assert.equal(applied.colorExpression, '#f59e0b');
  assert.deepEqual(applied.filterExpression, ['in', ['id'], ['literal', [11, 12, 13]]]);
  assert.deepEqual(calls, [
    {
      type: 'setFilter',
      layerId: 'buildings-filter-highlight-fill',
      expr: ['in', ['id'], ['literal', [11, 12, 13]]]
    },
    {
      type: 'setPaintProperty',
      layerId: 'buildings-filter-highlight-fill',
      name: 'fill-color',
      value: '#f59e0b'
    },
    {
      type: 'setPaintProperty',
      layerId: 'buildings-filter-highlight-fill',
      name: 'fill-opacity',
      value: 0.4
    },
    {
      type: 'setFilter',
      layerId: 'buildings-filter-highlight-outline',
      expr: ['in', ['id'], ['literal', [11, 12, 13]]]
    },
    {
      type: 'setPaintProperty',
      layerId: 'buildings-filter-highlight-outline',
      name: 'line-color',
      value: '#f59e0b'
    },
    {
      type: 'setPaintProperty',
      layerId: 'buildings-filter-highlight-outline',
      name: 'line-width',
      value: 1.8
    },
    {
      type: 'setPaintProperty',
      layerId: 'buildings-filter-highlight-outline',
      name: 'line-opacity',
      value: 0.95
    }
  ]);
});

test('applyFilterPaintHighlight skips static paint properties when highlight stays active on same layers', async () => {
  const { applyFilterPaintHighlight } = await loadFilterHighlightUtils();
  const calls = [];
  const map = {
    getLayer(layerId) {
      return { id: layerId };
    },
    setFilter(layerId, expr) {
      calls.push({ type: 'setFilter', layerId, expr });
    },
    setPaintProperty(layerId, name, value) {
      calls.push({ type: 'setPaintProperty', layerId, name, value });
    }
  };

  const applied = applyFilterPaintHighlight({
    map,
    previousActive: true,
    normalizedColorGroups: [
      { color: '#f59e0b', ids: [11, 12, 13] }
    ],
    fillLayerIds: ['buildings-filter-highlight-fill'],
    lineLayerIds: ['buildings-filter-highlight-outline']
  });

  assert.equal(applied.active, true);
  assert.equal(applied.count, 3);
  assert.equal(applied.paintPropertyCalls, 2);
  assert.deepEqual(calls, [
    {
      type: 'setFilter',
      layerId: 'buildings-filter-highlight-fill',
      expr: ['in', ['id'], ['literal', [11, 12, 13]]]
    },
    {
      type: 'setPaintProperty',
      layerId: 'buildings-filter-highlight-fill',
      name: 'fill-color',
      value: '#f59e0b'
    },
    {
      type: 'setFilter',
      layerId: 'buildings-filter-highlight-outline',
      expr: ['in', ['id'], ['literal', [11, 12, 13]]]
    },
    {
      type: 'setPaintProperty',
      layerId: 'buildings-filter-highlight-outline',
      name: 'line-color',
      value: '#f59e0b'
    }
  ]);
});
