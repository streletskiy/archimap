const test = require('node:test');
const assert = require('node:assert/strict');

const regionDbPath = require.resolve('../../scripts/region-sync/region-db');
const pgPath = require.resolve('pg');

/**
 * @param {any} exportsObject
 * @returns {NodeJS.Module}
 */
function createModuleMock(exportsObject) {
  return {
    id: pgPath,
    filename: pgPath,
    loaded: true,
    exports: exportsObject,
    children: [],
    isPreloading: false,
    parent: null,
    path: '',
    paths: [],
    require
  };
}

test('loadRegion postgres query selects region hierarchy columns for country aggregates', async (t) => {
  const originalRegionDbCache = require.cache[regionDbPath];
  const originalPgCache = require.cache[pgPath];
  const queries = [];

  class FakeClient {
    async connect() {}

    async query(sql, params) {
      queries.push({
        sql: String(sql || ''),
        params: Array.isArray(params) ? params : []
      });
      return {
        rows: [
          {
            id: 77,
            slug: 'pl-poland',
            name: 'PL Poland',
            source_type: 'extract',
            source_value: 'PL Poland',
            extract_source: 'geofabrik',
            extract_id: 'poland',
            extract_label: 'PL Poland',
            extract_resolution_status: 'resolved',
            extract_resolution_error: null,
            enabled: 1,
            auto_sync_enabled: 0,
            auto_sync_on_start: 0,
            auto_sync_interval_hours: 0,
            pmtiles_min_zoom: 10,
            pmtiles_max_zoom: 14,
            source_layer: 'buildings',
            bounds_west: null,
            bounds_south: null,
            bounds_east: null,
            bounds_north: null,
            region_kind: 'country_aggregate',
            parent_region_id: null,
            order_in_parent: null
          }
        ]
      };
    }

    async end() {}
  }

  require.cache[pgPath] = createModuleMock({ Client: FakeClient });
  delete require.cache[regionDbPath];

  t.after(() => {
    if (originalRegionDbCache) {
      require.cache[regionDbPath] = originalRegionDbCache;
    } else {
      delete require.cache[regionDbPath];
    }

    if (originalPgCache) {
      require.cache[pgPath] = originalPgCache;
    } else {
      delete require.cache[pgPath];
    }
  });

  const { loadRegion } = require(regionDbPath);
  const region = await loadRegion(
    {
      dbProvider: 'postgres',
      databaseUrl: 'postgres://archimap:test@localhost:5432/archimap'
    },
    77
  );

  assert.equal(region.regionKind, 'country_aggregate');
  assert.equal(region.extractId, 'poland');
  assert.equal(region.parentRegionId, null);

  assert.equal(queries.length, 1);
  assert.match(queries[0].sql, /\bregion_kind\b/i);
  assert.match(queries[0].sql, /\bparent_region_id\b/i);
  assert.match(queries[0].sql, /\border_in_parent\b/i);
  assert.deepEqual(queries[0].params, [77]);
});
