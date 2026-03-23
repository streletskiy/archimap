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
    ['combined-and', { matchedFeatureIds: [2, 4], matchedKeys: [], meta: { elapsedMs: 7 } }],
    ['combined-or:or-layer', { matchedFeatureIds: [2], matchedKeys: [], meta: { elapsedMs: 5 } }],
    ['layer:standalone-layer', { matchedFeatureIds: [6], matchedKeys: [], meta: { elapsedMs: 3 } }]
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
    { color: '#111111', ids: [2] },
    { color: '#333333', ids: [6] }
  ]);
});

