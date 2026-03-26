const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeSearchSourceRow,
  normalizeSearchSourceRows
} = require('../../src/lib/server/services/search-index-source.service');

test('normalizeSearchSourceRow safely parses tags JSON and builds fallback fields', () => {
  const row = normalizeSearchSourceRow({
    osm_type: 'way',
    osm_id: 42,
    tags_json: JSON.stringify({
      'name:ru': 'Дом Мельникова',
      'addr:postcode': '119002',
      'addr:city': 'Москва',
      'addr:street': 'Кривоарбатский переулок',
      'addr:housenumber': '10',
      architecture: 'авангард',
      architect_name: 'Константин Мельников',
      'design:ref': '1-447С-43'
    }),
    local_name: null,
    local_address: null,
    local_style: null,
    local_architect: null,
    local_design_ref: null,
    local_priority: 0,
    center_lon: 37.588,
    center_lat: 55.748
  });

  assert.deepEqual(row, {
    osm_key: 'way/42',
    osm_type: 'way',
    osm_id: 42,
    name: 'Дом Мельникова',
    address: '119002, Москва, Кривоарбатский переулок, 10',
    style: 'авангард',
    architect: 'Константин Мельников',
    design_ref: '1-447С-43',
    local_priority: 0,
    center_lon: 37.588,
    center_lat: 55.748
  });
});

test('normalizeSearchSourceRow prefers local architectural info over OSM tags', () => {
  const row = normalizeSearchSourceRow({
    osm_type: 'relation',
    osm_id: 7,
    tags_json: JSON.stringify({
      name: 'OSM name',
      'addr:full': 'OSM address',
      style: 'OSM style',
      architect: 'OSM architect'
    }),
    local_name: 'Local name',
    local_address: 'Local address',
    local_style: 'Local style',
    local_architect: 'Local architect',
    local_priority: 1,
    center_lon: 10,
    center_lat: 20
  });

  assert.equal(row.name, 'Local name');
  assert.equal(row.address, 'Local address');
  assert.equal(row.style, 'Local style');
  assert.equal(row.architect, 'Local architect');
  assert.equal(row.local_priority, 1);
});

test('normalizeSearchSourceRow keeps design ref only buildings searchable', () => {
  const row = normalizeSearchSourceRow({
    osm_type: 'relation',
    osm_id: 8,
    tags_json: JSON.stringify({
      'design:ref': 'II-18-01'
    }),
    local_name: null,
    local_address: null,
    local_style: null,
    local_architect: null,
    local_design_ref: null,
    local_priority: 0,
    center_lon: 10,
    center_lat: 20
  });

  assert.ok(row);
  assert.equal(row.design_ref, 'II-18-01');
});

test('normalizeSearchSourceRows filters malformed rows without throwing', () => {
  const rows = normalizeSearchSourceRows([
    {
      osm_type: 'way',
      osm_id: 1,
      tags_json: '{invalid json',
      local_name: 'Локальное имя',
      local_priority: 0,
      center_lon: 1,
      center_lat: 2
    },
    {
      osm_type: 'node',
      osm_id: 2,
      tags_json: '{}',
      local_priority: 0,
      center_lon: 1,
      center_lat: 2
    }
  ]);

  assert.equal(rows.length, 1);
  assert.equal(rows[0].osm_key, 'way/1');
  assert.equal(rows[0].name, 'Локальное имя');
});

test('normalizeSearchSourceRow drops entries without searchable text', () => {
  const row = normalizeSearchSourceRow({
    osm_type: 'way',
    osm_id: 11,
    tags_json: '{}',
    local_name: null,
    local_address: null,
    local_style: null,
    local_architect: null,
    local_priority: 0,
    center_lon: 1,
    center_lat: 2
  });

  assert.equal(row, null);
});

test('normalizeSearchSourceRow drops building parts from the search source', () => {
  const row = normalizeSearchSourceRow({
    osm_type: 'way',
    osm_id: 12,
    tags_json: JSON.stringify({
      'building:part': 'apartments',
      name: 'Part of a building'
    }),
    local_name: null,
    local_address: null,
    local_style: null,
    local_architect: null,
    local_priority: 0,
    center_lon: 1,
    center_lat: 2
  });

  assert.equal(row, null);
});

test('normalizeSearchSourceRow keeps buildings that also declare building:part', () => {
  const row = normalizeSearchSourceRow({
    osm_type: 'way',
    osm_id: 13,
    tags_json: JSON.stringify({
      building: 'yes',
      'building:part': 'apartments',
      name: 'Mixed building'
    }),
    local_name: null,
    local_address: null,
    local_style: null,
    local_architect: null,
    local_priority: 0,
    center_lon: 1,
    center_lat: 2
  });

  assert.ok(row);
  assert.equal(row.osm_key, 'way/13');
  assert.equal(row.name, 'Mixed building');
});
