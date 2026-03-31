const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const test = require('node:test');

async function loadFilterRequestPlanner() {
  const modulePath = path.join(process.cwd(), 'frontend', 'src', 'lib', 'services', 'map', 'filter-request-planner.ts');
  return import(pathToFileURL(modulePath).href);
}

test('buildFilterRequestSpecs splits combined and standalone layers into stable request specs', async () => {
  const { buildFilterRequestSpecs } = await loadFilterRequestPlanner();

  const prepared = buildFilterRequestSpecs([
    {
      id: 'and-layer',
      mode: 'and',
      priority: 0,
      color: '#111111',
      rules: [{ key: 'name', op: 'contains', value: 'alpha' }]
    },
    {
      id: 'or-layer',
      mode: 'or',
      priority: 1,
      color: '#222222',
      rules: [{ key: 'style', op: 'equals', value: 'modern' }]
    },
    {
      id: 'standalone-layer',
      mode: 'layer',
      priority: 2,
      color: '#333333',
      rules: [{ key: 'levels', op: 'greater_or_equals', value: '5' }]
    }
  ]);

  assert.equal(prepared.combinedGroup?.id, 'combined-group');
  assert.equal(prepared.combinedGroup?.color, '#111111');
  assert.deepEqual(
    prepared.requestSpecs.map((spec) => spec.id),
    ['combined-and', 'combined-or:or-layer', 'layer:standalone-layer']
  );
});

test('buildFilterRequestCacheKey separates contour and marker render modes', async () => {
  const { buildFilterRequestCacheKey } = await loadFilterRequestPlanner();

  const contourKey = buildFilterRequestCacheKey({
    id: 'layer:example',
    rulesHash: 'fnv1a-test'
  }, 'coverage-test', 12.5, 'contours', 0);
  const markerKey = buildFilterRequestCacheKey({
    id: 'layer:example',
    rulesHash: 'fnv1a-test'
  }, 'coverage-test', 12.5, 'markers', 0);
  const overpassKey = buildFilterRequestCacheKey({
    id: 'layer:example',
    rulesHash: 'fnv1a-test'
  }, 'coverage-test', 12.5, 'contours', 9);

  assert.notEqual(contourKey, markerKey);
  assert.equal(contourKey.endsWith(':contours:0'), true);
  assert.equal(markerKey.endsWith(':markers:0'), true);
  assert.notEqual(contourKey, overpassKey);
  assert.equal(overpassKey.endsWith(':contours:9'), true);
});

test('prepareFilterRequestPlan builds a worker-ready request plan', async () => {
  const { prepareFilterRequestPlan } = await loadFilterRequestPlanner();
  const prepared = prepareFilterRequestPlan([
    {
      id: 'and-layer',
      mode: 'and',
      priority: 0,
      color: '#111111',
      rules: [{ key: 'name', op: 'contains', value: 'alpha' }]
    },
    {
      id: 'standalone-layer',
      mode: 'layer',
      priority: 1,
      color: '#333333',
      rules: [{ key: 'levels', op: 'greater_or_equals', value: '5' }]
    }
  ]);

  assert.equal(prepared.ok, true);
  assert.equal(prepared.rulesHash.startsWith('fnv1a-'), true);
  assert.equal(prepared.heavy, true);
  assert.deepEqual(
    prepared.requestSpecs.map((spec) => spec.id),
    ['combined-and', 'layer:standalone-layer']
  );
});

test('buildResolvedLayerPayload combines AND/OR group intersections with standalone highlights', async () => {
  const {
    buildFilterRequestSpecs,
    buildResolvedLayerPayload
  } = await loadFilterRequestPlanner();

  const prepared = buildFilterRequestSpecs([
    {
      id: 'and-layer',
      mode: 'and',
      priority: 0,
      color: '#111111',
      rules: [{ key: 'name', op: 'contains', value: 'alpha' }]
    },
    {
      id: 'or-layer',
      mode: 'or',
      priority: 1,
      color: '#222222',
      rules: [{ key: 'style', op: 'equals', value: 'modern' }]
    },
    {
      id: 'standalone-layer',
      mode: 'layer',
      priority: 2,
      color: '#333333',
      rules: [{ key: 'levels', op: 'greater_or_equals', value: '5' }]
    }
  ]);

  const payloadsByRequestId = new Map([
    ['combined-and', {
      matchedFeatureIds: [2, 4],
      matchedKeys: [],
      matchedLocations: [
        { id: 2, lon: 37.61, lat: 55.75, osmKey: 'way/1' },
        { id: 4, lon: 37.62, lat: 55.76, osmKey: 'way/2' }
      ],
      meta: { elapsedMs: 7 }
    }],
    ['combined-or:or-layer', {
      matchedFeatureIds: [2],
      matchedKeys: [],
      matchedLocations: [
        { id: 2, lon: 37.61, lat: 55.75, osmKey: 'way/1' }
      ],
      meta: { elapsedMs: 5 }
    }],
    ['layer:standalone-layer', {
      matchedFeatureIds: [6],
      matchedKeys: [],
      matchedLocations: [
        { id: 6, lon: 37.63, lat: 55.77, osmKey: 'way/3' }
      ],
      meta: { elapsedMs: 3 }
    }]
  ]);

  const resolved = buildResolvedLayerPayload({
    prepared: {
      ...prepared,
      rulesHash: 'fnv1a-test'
    },
    payloadsByRequestId,
    cacheHit: true
  });

  assert.equal(resolved.matchedCount, 2);
  assert.equal(resolved.meta.cacheHit, true);
  assert.equal(resolved.meta.elapsedMs, 15);
  assert.deepEqual(resolved.highlightColorGroups, [
    {
      color: '#111111',
      ids: [2],
      points: [
        { id: 2, lon: 37.61, lat: 55.75, osmKey: 'way/1' }
      ]
    },
    {
      color: '#333333',
      ids: [6],
      points: [
        { id: 6, lon: 37.63, lat: 55.77, osmKey: 'way/3' }
      ]
    }
  ]);
});

test('buildResolvedLayerPayload preserves marker aggregation counts', async () => {
  const {
    buildFilterRequestSpecs,
    buildResolvedLayerPayload
  } = await loadFilterRequestPlanner();

  const prepared = buildFilterRequestSpecs([
    {
      id: 'marker-layer',
      mode: 'layer',
      priority: 0,
      color: '#111111',
      rules: [{ key: 'name', op: 'contains', value: 'alpha' }]
    }
  ]);

  const payloadsByRequestId = new Map([
    ['layer:marker-layer', {
      matchedFeatureIds: [9001],
      matchedKeys: ['cell:18:1:1'],
      matchedLocations: [
        { id: 9001, lon: 37.61, lat: 55.75, count: 4, osmKey: 'cell:18:1:1' }
      ],
      meta: { elapsedMs: 9 }
    }]
  ]);

  const resolved = buildResolvedLayerPayload({
    prepared: {
      ...prepared,
      renderMode: 'markers',
      rulesHash: 'fnv1a-marker'
    },
    payloadsByRequestId,
    cacheHit: false
  });

  assert.equal(resolved.matchedCount, 4);
  assert.deepEqual(resolved.highlightColorGroups, [
    {
      color: '#111111',
      ids: [9001],
      points: [
        { id: 9001, lon: 37.61, lat: 55.75, count: 4, osmKey: 'cell:18:1:1' }
      ]
    }
  ]);
});

