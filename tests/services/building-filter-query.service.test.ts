const test = require('node:test');
const assert = require('node:assert/strict');

const { mapFilterDataRow } = require('../../src/lib/server/services/building-filter-query.service');
const { buildFilterMatchBatchResults } = require('../../src/lib/server/http/buildings.route');

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

  const results = buildFilterMatchBatchResults([item], [
    {
      id: 'levels-4-plus',
      rulesHash: 'hash-levels',
      maxResults: 100,
      rules: [
        { key: 'levels', op: 'greater_or_equals', value: '4', valueNormalized: '4', numericValue: 4 },
        { key: 'levels', op: 'less_than', value: '5', valueNormalized: '5', numericValue: 5 }
      ]
    }
  ]);

  assert.equal(item.levels, '4');
  assert.equal(item.renderHeightMeters, 18.5);
  assert.equal(item.renderMinHeightMeters, 5.5);
  assert.deepEqual(results[0].matchedKeys, ['relation/203']);
});
