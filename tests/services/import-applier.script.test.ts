const test = require('node:test');
const assert = require('node:assert/strict');

const {
  deletePostgresStaleMemberships,
  deletePostgresStaleMembershipsFromNamedStage,
  hasPostgresRegionMemberships
} = require('../../scripts/region-sync/import-applier');

function createFakeClient() {
  const queries = [];
  return {
    queries,
    async query(sql, params) {
      queries.push({
        sql: String(sql || ''),
        params: Array.isArray(params) ? params : []
      });
      return { rowCount: 0, rows: [] };
    }
  };
}

test('hasPostgresRegionMemberships checks only for the existence of prior rows', async () => {
  const client = createFakeClient();
  client.query = async (sql, params) => {
    client.queries.push({
      sql: String(sql || ''),
      params: Array.isArray(params) ? params : []
    });
    return { rowCount: 1, rows: [{}] };
  };

  const hasMemberships = await hasPostgresRegionMemberships(client, 42);

  assert.equal(hasMemberships, true);
  assert.equal(client.queries.length, 1);
  assert.match(client.queries[0].sql, /SELECT 1[\s\S]*FROM public\.data_region_memberships/i);
  assert.match(client.queries[0].sql, /WHERE region_id = \$1/i);
  assert.match(client.queries[0].sql, /LIMIT 1/i);
  assert.deepEqual(client.queries[0].params, [42]);
});

for (const { label, runCleanup } of [
  {
    label: 'direct stage table',
    runCleanup: (client, regionId, hasExistingMemberships) =>
      deletePostgresStaleMemberships(client, regionId, { hasExistingMemberships })
  },
  {
    label: 'named stage table',
    runCleanup: (client, regionId, hasExistingMemberships) =>
      deletePostgresStaleMembershipsFromNamedStage(client, 'region_sync_stage_r42_test', 'region_import_stage', regionId, {
        hasExistingMemberships
      })
  }
]) {
  test(`deletePostgresStaleMemberships skips cleanup on first sync for ${label}`, async () => {
    const client = createFakeClient();

    const didCleanup = await runCleanup(client, 42, false);

    assert.equal(didCleanup, false);
    assert.equal(client.queries.length, 0);
  });

  test(`deletePostgresStaleMemberships runs cleanup when prior memberships exist for ${label}`, async () => {
    const client = createFakeClient();

    const didCleanup = await runCleanup(client, 42, true);

    assert.equal(didCleanup, true);
    assert.equal(client.queries.length, 2);
    assert.match(client.queries[0].sql, /TRUNCATE region_orphan_candidates_tmp/i);
    assert.match(client.queries[1].sql, /DELETE FROM public\.data_region_memberships drm/i);
    assert.match(client.queries[1].sql, /RETURNING drm\.osm_type, drm\.osm_id/i);
    assert.deepEqual(client.queries[1].params, [42]);
  });
}
