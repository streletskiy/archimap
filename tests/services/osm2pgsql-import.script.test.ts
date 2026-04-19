const test = require('node:test');
const assert = require('node:assert/strict');

const { buildOsm2pgsqlArgs } = require('../../scripts/region-sync/osm2pgsql-import');

test('buildOsm2pgsqlArgs uses osm2pgsql 1.8-compatible schema and jobs flags', () => {
  const args = buildOsm2pgsqlArgs({
    databaseUrl: 'postgresql://archimap:archimap@db-postgres:5432/archimap',
    pbfPath: '/tmp/source.osm.pbf',
    stageSchema: 'region_sync_stage_r267_test',
    jobs: 4,
    cacheMb: 1024
  });

  assert.deepEqual(args.slice(0, 6), ['--create', '--slim', '--drop', '-O', 'flex', '-S']);
  assert.match(args[6], /osm2pgsql-flex\.lua$/);
  assert.equal(args[7], '--middle-schema');
  assert.equal(args[8], 'region_sync_stage_r267_test');
  assert.equal(args.includes('--schema'), false);
  assert.equal(args.includes('-j'), false);
  assert.equal(args.includes('--number-processes'), true);
  assert.equal(args.includes('--output-pgsql-schema'), false);
});
