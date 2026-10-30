const test = require('node:test');
const assert = require('node:assert/strict');

const { mapFilterDataRow } = require('../../src/lib/server/services/building-filter-query.service');
const { buildFilterMatchBatchResults } = require('../../src/lib/server/http/buildings.route');
const { createBuildingFiltersService } = require('../../src/lib/server/services/building-filters.service');

function createFilterFixture(provider = 'sqlite') {
  const queries = [];
  const rows = [1, 2, 3].map((levels) => ({
    osm_type: 'way', osm_id: levels, tags_json: JSON.stringify({ 'building:levels': String(levels) }),
    min_lon: 44, max_lon: 44.01, min_lat: 56, max_lat: 56.01, info_osm_id: null
  }));
  const service = createBuildingFiltersService({
    db: { provider, prepare: (sql) => ({ all: async () => { queries.push(sql); return rows; } }) },
    applyPersonalEditsToFilterItems: async (items) => items
  });
  const request = { bbox: { west: 44, south: 56, east: 44.02, north: 56.02 },
    rules: [{ key: 'building:levels', op: 'equals', value: '2' }], maxResults: 10 };
  return { service, queries, request };
}

test('filter cache uses validated rules, rebinds batch IDs and isolates actors', async () => {
  const { service, queries, request } = createFilterFixture();
  const first = await service.getBatchFilterMatches({ ...request, requests: [{ ...request, id: 'first', rulesHash: 'shared' }] });
  const second = await service.getBatchFilterMatches({ ...request, requests: [{ ...request, id: 'second', rulesHash: 'new-hash' }] });
  assert.equal(queries.length, 1);
  assert.equal(second.payload.meta.cacheHit, true);
  assert.equal(second.payload.items[0].id, 'second');
  assert.equal(second.payload.items[0].meta.rulesHash, 'new-hash');
  assert.deepEqual(second.payload.items[0].matchedKeys, first.payload.items[0].matchedKeys);
  const different = { ...request, rules: [{ key: 'building:levels', op: 'equals', value: '3' }], rulesHash: 'shared' };
  const changed = await service.getBatchFilterMatches({ ...request, requests: [{ ...different, id: 'first' }] });
  assert.deepEqual(changed.payload.items[0].matchedKeys, ['way/3']);
  await service.getBatchFilterMatches({ ...request, requests: [{ ...request, id: 'first' }] }, 'user:1');
  assert.equal(queries.length, 3);
  const single = await service.getFilterMatches({ ...request, rulesHash: 'shared' });
  const other = await service.getFilterMatches(different);
  assert.deepEqual(single.payload.matchedKeys, ['way/2']);
  assert.deepEqual(other.payload.matchedKeys, ['way/3']);
});

test('contour requests can omit locations without affecting matches or marker-mode caching', async () => {
  const { service, request } = createFilterFixture();
  const compact = await service.getFilterMatches({ ...request, includeLocations: false });
  const full = await service.getFilterMatches(request);
  const marker = await service.getBatchFilterMatches({ ...request, includeLocations: false, renderMode: 'markers', zoom: 10, requests: [request] });
  assert.deepEqual(compact.payload.matchedKeys, full.payload.matchedKeys);
  assert.deepEqual(compact.payload.matchedLocations, []);
  assert.equal(full.payload.matchedLocations.length, 1);
  assert.equal(marker.payload.items[0].matchedLocations.length, 1);
});

test('exact match limit is complete and only additional matches trigger truncation', async () => {
  const { service, request } = createFilterFixture();
  const exact = await service.getFilterMatches({ ...request, maxResults: 1 });
  const overflow = await service.getFilterMatches({ ...request, maxResults: 1, rules: [{ key: 'building:levels', op: 'exists' }] });
  assert.equal(exact.payload.meta.truncated, false);
  assert.equal(overflow.payload.meta.truncated, true);
  assert.equal(overflow.payload.matchedCount, 1);
});

test('Postgres level filters retain derived values and architectural overrides in single and batch paths', async () => {
  const { service, queries, request } = createFilterFixture('postgres');
  await service.getFilterMatches(request);
  await service.getBatchFilterMatches({ ...request, requests: [request] });
  assert.match(queries[0], /LEFT JOIN local\.architectural_info/);
  assert.match(queries[0], /ai\.levels/);
  assert.match(queries[0], /WHERE \(TRUE\)/);
  assert.match(queries[1], /LEFT JOIN local\.architectural_info/);
});

test('server filter rows derive levels from explicit height tags for level filters', () => {
  const item = mapFilterDataRow({
    osm_type: 'relation',
    osm_id: 203,
    tags_json: JSON.stringify({
      'building:part': 'yes',
      height: '18.5',
      min_height: '5.5'
    }),
    min_lon: 30,
    min_lat: 60,
    max_lon: 30.01,
    max_lat: 60.01,
    info_osm_id: null
  });

  const results = buildFilterMatchBatchResults(
    [item],
    [
      {
        id: 'levels-4-plus',
        rulesHash: 'hash-levels',
        maxResults: 100,
        rules: [
          { key: 'levels', op: 'greater_or_equals', value: '4', valueNormalized: '4', numericValue: 4 },
          { key: 'levels', op: 'less_than', value: '5', valueNormalized: '5', numericValue: 5 }
        ]
      }
    ]
  );

  assert.equal(item.levels, '4');
  assert.equal(item.renderHeightMeters, 18.5);
  assert.equal(item.renderMinHeightMeters, 5.5);
  assert.deepEqual(results[0].matchedKeys, ['relation/203']);
});
