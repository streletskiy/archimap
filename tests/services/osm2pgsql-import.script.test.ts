const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildOsm2pgsqlArgs,
  ensureOsm2pgsqlContainerFlexConfig
} = require('../../scripts/region-sync/osm2pgsql-import');

test('buildOsm2pgsqlArgs uses osm2pgsql 1.8-compatible schema and jobs flags', () => {
  const args = buildOsm2pgsqlArgs({
    databaseUrl: 'postgresql://archimap:archimap@db-postgres:5432/archimap',
    pbfPath: '/tmp/source.osm.pbf',
    stageSchema: 'region_sync_stage_r267_test',
    flexConfigPath: '/tmp/osm2pgsql-flex.lua',
    jobs: 4,
    cacheMb: 1024
  });

  assert.deepEqual(args.slice(0, 6), ['--create', '--slim', '--drop', '-O', 'flex', '-S']);
  assert.equal(args[6], '/tmp/osm2pgsql-flex.lua');
  assert.equal(args[7], '--middle-schema');
  assert.equal(args[8], 'region_sync_stage_r267_test');
  assert.equal(args.includes('--schema'), false);
  assert.equal(args.includes('-j'), false);
  assert.equal(args.includes('--number-processes'), true);
  assert.equal(args.includes('--output-pgsql-schema'), false);
});

test('ensureOsm2pgsqlContainerFlexConfig copies the flex config into the container temp path', () => {
  const calls = [];

  const containerPath = ensureOsm2pgsqlContainerFlexConfig(
    'archimap-osm2pgsql',
    {},
    (execPath, args, options = {}) => {
      calls.push({ execPath, args, options });
      return { status: 0 };
    }
  );

  assert.equal(containerPath, '/tmp/archimap-osm2pgsql-flex.lua');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].execPath, 'docker');
  assert.equal(calls[0].args[0], 'cp');
  assert.match(calls[0].args[1], /osm2pgsql-flex\.lua$/);
  assert.equal(calls[0].args[2], 'archimap-osm2pgsql:/tmp/archimap-osm2pgsql-flex.lua');
  assert.equal(calls[0].options.shell, false);
});
