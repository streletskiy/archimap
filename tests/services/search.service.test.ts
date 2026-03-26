const test = require('node:test');
const assert = require('node:assert/strict');

const { createSearchService } = require('../../src/lib/server/services/search.service');

function createNoopDb() {
  return {
    provider: 'sqlite',
    prepare() {
      return {
        all() {
          return [];
        }
      };
    }
  };
}

test('normalizeSearchTokens deduplicates and limits token count', () => {
  const service = createSearchService({ db: createNoopDb() });
  const tokens = service.normalizeSearchTokens('  дом дом, музей!! архитектура стиль стиль  ');
  assert.deepEqual(tokens, ['дом', 'музей', 'архитектура', 'стиль']);
});

test('buildFtsMatchQuery escapes quotes', () => {
  const service = createSearchService({ db: createNoopDb() });
  const query = service.buildFtsMatchQuery(['abc', 'd"e']);
  assert.equal(query, '"abc"* AND "d""e"*');
});

test('normalizeSearchBbox rejects invalid bounds and normalizes numeric input', () => {
  const service = createSearchService({ db: createNoopDb() });
  assert.deepEqual(service.normalizeSearchBbox({
    west: '43.9',
    south: '55.9',
    east: '44.1',
    north: '56.1'
  }), {
    west: 43.9,
    south: 55.9,
    east: 44.1,
    north: 56.1
  });
  assert.equal(service.normalizeSearchBbox({
    west: 44.1,
    south: 55.9,
    east: 43.9,
    north: 56.1
  }), null);
  assert.equal(service.normalizeSearchBbox({
    west: 43.9,
    south: Number.NaN,
    east: 44.1,
    north: 56.1
  }), null);
});

test('getBuildingSearchResults returns empty for short/empty tokens', async () => {
  const service = createSearchService({ db: createNoopDb() });
  const result = await service.getBuildingSearchResults('   ', 0, 0, 30, 0);
  assert.deepEqual(result, { items: [], total: 0, nextCursor: null, hasMore: false });
});

test('getBuildingSearchResults applies viewport bbox constraints to SQL queries', async () => {
  let capturedSql = '';
  let capturedParams = [];
  const db = {
    provider: 'sqlite',
    prepare(sql) {
      capturedSql = sql;
      return {
        all(...params) {
          capturedParams = params;
          return [];
        }
      };
    }
  };
  const service = createSearchService({ db });
  await service.getBuildingSearchResults('музей', 44, 56, 120, 0, {
    west: 43.9,
    south: 55.9,
    east: 44.1,
    north: 56.1
  });

  assert.match(capturedSql, /WHERE s\.center_lon >= \?/);
  assert.match(capturedSql, /AND s\.center_lat <= \?/);
  assert.equal(capturedParams[0], '"музей"*');
  assert.deepEqual(capturedParams.slice(5, 9), [43.9, 44.1, 55.9, 56.1]);
  assert.equal(capturedParams[9], 121);
  assert.equal(capturedParams[10], 0);
});

test('getBuildingSearchResults local fallback searches design ref values', async () => {
  let capturedSql = '';
  const returnedRows = [
    {
      osm_type: 'way',
      osm_id: 7,
      name: 'Дом',
      address: null,
      style: null,
      architect: null,
      design_ref: 'II-18-01',
      center_lon: 44,
      center_lat: 56,
      total_count: 1
    }
  ];
  const db = {
    provider: 'sqlite',
    prepare(sql) {
      capturedSql = sql;
      return {
        all() {
          return returnedRows;
        }
      };
    }
  };
  const service = createSearchService({
    db,
    isRebuildInProgress: () => true
  });

  const result = await service.getBuildingSearchResults('1-447С-43', 44, 56, 30, 0);

  assert.match(capturedSql, /design_ref/);
  assert.match(capturedSql, /json_extract\(bc\.tags_json, '\$\."design:ref"'\)/);
  assert.equal(result.items[0].designRef, 'II-18-01');
});

test('getBuildingSearchResults returns total from window count', async () => {
  const db = {
    provider: 'sqlite',
    prepare() {
      return {
        all() {
          return [
            {
              osm_type: 'way',
              osm_id: 1,
              name: 'Дом',
              address: null,
              style: null,
              architect: null,
              design_ref: '1-447С-43',
              center_lon: 44,
              center_lat: 56,
              rank: 1,
              total_count: 345
            }
          ];
        }
      };
    }
  };
  const service = createSearchService({ db });
  const result = await service.getBuildingSearchResults('дом', 44, 56, 120, 0);
  assert.equal(result.total, 345);
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].designRef, '1-447С-43');
});
