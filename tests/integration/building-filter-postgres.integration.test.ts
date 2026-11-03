const test = require('node:test');
const assert = require('node:assert/strict');
const { Client } = require('pg');
const { _test_: { createPostgresCompatDb } } = require('../../src/lib/server/infra/db-runtime.infra');
const { createBuildingFiltersService, normalizeFilterRule, matchesFilterRule } = require('../../src/lib/server/services/building-filters.service');
const { createBuildingFilterQueryService } = require('../../src/lib/server/services/building-filter-query.service');
const { createBuildingEditsContext } = require('../../src/lib/server/services/building-edits/shared');
const { createBuildingEditPersonalOverlaysService } = require('../../src/lib/server/services/building-edits/personal-overlays');
const { normalizeUserEditStatus } = require('../../src/lib/server/services/edits.service');
const { advanceBuildingDataRevision } = require('../../src/lib/server/infra/building-data-revision.infra');

// Explicit opt-in to a disposable migrated database; never inherit the app DATABASE_URL.
const connectionString = process.env.PG_FILTER_TEST_DATABASE_URL;
test('PostGIS filters match JS semantics before limits, including personal additions and removals', {
  skip: !connectionString
}, async () => {
  const client = new Client({ connectionString });
  await client.connect();
  await client.query('BEGIN');
  try {
    const db = createPostgresCompatDb(client);
    const queries = createBuildingFilterQueryService({ db });
    const overlays = createBuildingEditPersonalOverlaysService(createBuildingEditsContext({ db, normalizeUserEditStatus }));
    const service = createBuildingFiltersService({ db, applyPersonalEditsToFilterItems: overlays.applyPersonalEditsToFilterItems });
    const tags = [
      { foo: '', prefix: 'a%b', style: 'Raw Style', 'building:levels': '4' },
      { foo: ' ', prefix: 'axb', 'building:levels': '3', colour: 'red' },
      { foo: 'MiXeD', prefix: 'a_b', 'building:levels': '4.5' },
      { foo: null, prefix: 'acb', height: '18.5 m', min_height: '5.5' },
      { prefix: 'a\\b', height: '9.6', min_level: '1', 'design:ref': 'X', design_ref: 'Y' },
      { foo: ['one', 'two'], prefix: 'ab', 'building:colour': null, colour: 'blue' },
      { foo: true, number: ' 2,5 ', 'roof:shape': '', roof_shape: 'gabled' },
      { foo: false, number: '1e2', 'building:material': 'concrete', 'building:material:concrete': 'blocks' },
      { foo: '\t\u00a0', number: '003.0', 'building:architecture': 'Gothic' },
      { foo: 'ÄБ', number: 'NaN', levels: '5', 'building:levels': 'bad' },
      { foo: '0', number: '-1', height: '7.99', 'building:min_height': '2' },
      { foo: 'rare', number: '12m', height: '12', 'building:levels': '400' },
      { foo: [[1, 2], 3], height: [12, 8], min_height: '3.2' },
      { foo: [[], null, { nested: true }, ['x', null]] },
      { height: { ignored: 99 }, levels: [2, 0] }
    ];
    const ids = tags.map((_, index) => 870000000000 + index);
    for (let index = 0; index < tags.length; index += 1) {
      await client.query(`INSERT INTO osm.building_contours
        (osm_type, osm_id, tags_json, min_lon, min_lat, max_lon, max_lat, geom)
        VALUES ('way', $1, $2, 179.91, -80.01, 179.92, -80, ST_Multi(ST_MakeEnvelope(179.91, -80.01, 179.92, -80, 4326)))`,
      [ids[index], JSON.stringify({ building: 'yes', ...tags[index] })]);
    }
    await client.query(`INSERT INTO local.architectural_info (osm_type, osm_id, name, style, material, material_concrete, description, archimap_description, levels)
      VALUES ('way', $1, '', 'Local Style', 'Concrete_Panels', NULL, 'old desc', 'new desc', 7),
             ('way', $2, 'Local Name', '', '', NULL, '', '', NULL)`, [ids[0], ids[1]]);
    await client.query(`INSERT INTO user_edits.building_user_edits
      (osm_type, osm_id, created_by, status, edited_fields_json, style, levels, archimap_description)
      VALUES ('way', $1, 'USER:PARITY', 'pending', '["style","levels","description"]', 'Personal', NULL, 'mine'),
             ('way', $2, 'user:parity', 'rejected', '["style"]', 'Personal', NULL, NULL),
             ('way', $3, 'other', 'pending', '["style"]', 'Personal', NULL, NULL)`, [ids[0], ids[1], ids[2]]);
    await client.query(`INSERT INTO user_edits.building_user_edits
      (osm_type, osm_id, created_by, status, edited_fields_json, style)
      VALUES ('way', $1, 'user:parity', 'accepted', '["style"]', 'Ignored accepted'),
             ('way', $2, 'user:parity', 'pending', '["style"]', 'Earlier'),
             ('way', $2, 'user:parity', 'rejected', '["style"]', 'Latest')`, [ids[0], ids[3]]);
    const bbox = { west: 179.9, south: -80.02, east: 179.93, north: -79.99 };
    const rowData = await queries.selectFilterRowsByBbox(bbox.west, bbox.south, bbox.east, bbox.north, 1000);
    const anonymousItems = rowData.map(queries.mapFilterDataRow);
    const personalItems = await overlays.applyPersonalEditsToFilterItems(anonymousItems, 'user:parity');
    const rules = [
      ...['foo', 'prefix', 'colour', 'name', 'style', 'archi.style', 'building:architecture',
        'material', 'material_concrete', 'roof:shape', 'description', 'archimap_description',
        'design_ref', 'levels', 'building:levels'].flatMap((key) => [
        { key, op: 'exists' }, { key, op: 'not_exists' }, { key, op: 'equals', value: '' },
        { key, op: 'not_equals', value: '' }, { key, op: 'contains', value: '' }
      ]),
      { key: 'prefix', op: 'starts_with', value: 'a%' },
      { key: 'prefix', op: 'starts_with', value: 'a_' },
      { key: 'prefix', op: 'starts_with', value: 'a\\' },
      { key: 'foo', op: 'equals', value: 'äб' },
      { key: 'foo', op: 'equals', value: 'one;two' },
      { key: 'foo', op: 'equals', value: '1,2;3' },
      { key: 'foo', op: 'equals', value: ';;[object Object];x,' },
      { key: 'style', op: 'equals', value: 'Personal' },
      { key: 'style', op: 'equals', value: 'Local Style' },
      { key: 'style', op: 'equals', value: 'Earlier' },
      { key: 'style', op: 'equals', value: 'Latest' },
      { key: 'style', op: 'equals', value: 'Ignored accepted' },
      ...['number', 'levels', 'building:levels'].flatMap((key) => [
        { key, op: 'greater_or_equals', value: '2,5' }, { key, op: 'less_than', value: '4' }
      ])
    ];
    for (const [actor, oracleItems] of [[null, anonymousItems], ['user:parity', personalItems]]) {
      for (let start = 0; start < rules.length; start += 16) {
        const batchRules = rules.slice(start, start + 16);
        const requests = batchRules.map((rule, index) => ({ id: String(index), rules: [rule], maxResults: 100 }));
        const batch = await service.getBatchFilterMatches({ bbox, requests }, actor);
        for (let index = 0; index < batchRules.length; index += 1) {
          const rule = batchRules[index];
          const normalized = normalizeFilterRule(rule).value;
          const expected = oracleItems.filter((item) => matchesFilterRule(item, normalized)).map((item) => item.osmKey).sort();
          assert.deepEqual(batch.payload.items[index].matchedKeys.sort(), expected, JSON.stringify({ actor, rule }));
          const single = await service.getFilterMatches({ bbox, rules: [rule], maxResults: 100 }, actor);
          assert.deepEqual(single.payload.matchedKeys.sort(), expected, JSON.stringify({ actor, rule, single: true }));
        }
      }
    }
    const rare = await service.getFilterMatches({ bbox, rules: [{ key: 'foo', op: 'equals', value: 'rare' }], maxResults: 1 });
    assert.deepEqual(rare.payload.matchedKeys, [`way/${ids[11]}`]);
    assert.equal(rare.payload.meta.truncated, false);
    const aggregate = await service.getBatchFilterMatches({
      bbox, renderMode: 'markers', zoom: 4,
      requests: [{ id: 'all', rules: [{ key: 'building', op: 'exists' }], maxResults: 1 }]
    });
    assert.equal(aggregate.payload.items[0].matchedCount, tags.length);
    assert.equal(aggregate.payload.items[0].matchedLocations.reduce((sum, cell) => sum + cell.count, 0), tags.length);
    assert.equal(aggregate.payload.items[0].meta.truncated, false);
    const emptyBatch = await service.getBatchFilterMatches({ bbox, requests: [{ rules: [], maxResults: 100 }] });
    assert.equal(emptyBatch.payload.items[0].matchedCount, tags.length);
    const emptySingle = await service.getFilterMatches({ bbox, rules: [] });
    assert.equal(emptySingle.payload.matchedCount, 0);
    // Matches after the former 50k candidate boundary must survive in every path.
    await client.query(`INSERT INTO osm.building_contours
      (osm_type, osm_id, tags_json, min_lon, min_lat, max_lon, max_lat, geom)
      SELECT 'way', 880000000000 + n, '{"building":"yes","foo":"ordinary"}',
        179.91, -80.01, 179.92, -80, ST_Multi(ST_MakeEnvelope(179.91, -80.01, 179.92, -80, 4326))
      FROM generate_series(1, 50001) AS n`);
    const lastId = 880000050002;
    await client.query(`INSERT INTO osm.building_contours
      (osm_type, osm_id, tags_json, min_lon, min_lat, max_lon, max_lat, geom)
      VALUES ('way', $1, '{"building":"yes","foo":"last-match"}',
        179.91, -80.01, 179.92, -80, ST_Multi(ST_MakeEnvelope(179.91, -80.01, 179.92, -80, 4326)))`, [lastId]);
    await client.query(`INSERT INTO user_edits.building_user_edits
      (osm_type, osm_id, created_by, status, edited_fields_json, style)
      VALUES ('way', $1, 'user:parity', 'pending', '["style"]', 'Late personal')`, [lastId]);
    advanceBuildingDataRevision();
    for (const [actor, rule] of [
      [null, { key: 'foo', op: 'equals', value: 'last-match' }],
      ['user:parity', { key: 'style', op: 'equals', value: 'Late personal' }]
    ]) {
      const single = await service.getFilterMatches({ bbox, rules: [rule], maxResults: 1 }, actor);
      const batch = await service.getBatchFilterMatches({ bbox, requests: [{ rules: [rule], maxResults: 1 }] }, actor);
      assert.deepEqual(single.payload.matchedKeys, [`way/${lastId}`]);
      assert.deepEqual(batch.payload.items[0].matchedKeys, [`way/${lastId}`]);
      assert.equal(single.payload.meta.truncated, false);
      assert.equal(batch.payload.items[0].meta.truncated, false);
    }
    const complete = await service.getFilterMatches({ bbox, renderMode: 'markers', zoom: 4,
      rules: [{ key: 'building', op: 'exists' }], maxResults: 1 });
    assert.equal(complete.payload.matchedCount, 50002 + tags.length);
    assert.equal(complete.payload.matchedLocations.reduce((sum, cell) => sum + cell.count, 0), 50002 + tags.length);
    assert.equal(complete.payload.meta.truncated, false);
    advanceBuildingDataRevision();
  } finally {
    await client.query('ROLLBACK');
    await client.end();
  }
});
