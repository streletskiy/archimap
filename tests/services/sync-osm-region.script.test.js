const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const {
  buildRuntimeFollowupEnv,
  runRuntimeFollowups,
  shouldRunRuntimeFollowup
} = require('../../scripts/sync-osm-region');

test('shouldRunRuntimeFollowup skips pmtiles-only and managed runtime env', () => {
  assert.equal(shouldRunRuntimeFollowup({ pmtilesOnly: true, env: {} }), false);
  assert.equal(shouldRunRuntimeFollowup({
    pmtilesOnly: false,
    env: { REGION_SYNC_SKIP_RUNTIME_FOLLOWUP: 'true' }
  }), false);
  assert.equal(shouldRunRuntimeFollowup({ pmtilesOnly: false, env: {} }), true);
});

test('buildRuntimeFollowupEnv carries explicit runtime DB paths and provider config', () => {
  const env = buildRuntimeFollowupEnv({
    dbProvider: 'sqlite',
    databaseUrl: '',
    archimapDbPath: '/tmp/archimap.db',
    osmDbPath: '/tmp/osm.db',
    localEditsDbPath: '/tmp/local-edits.db'
  }, {});

  assert.equal(env.DB_PROVIDER, 'sqlite');
  assert.equal(env.ARCHIMAP_DB_PATH, '/tmp/archimap.db');
  assert.equal(env.DATABASE_PATH, '/tmp/archimap.db');
  assert.equal(env.OSM_DB_PATH, '/tmp/osm.db');
  assert.equal(env.LOCAL_EDITS_DB_PATH, '/tmp/local-edits.db');
});

test('runRuntimeFollowups executes search and filter workers for standalone sync', () => {
  const calls = [];
  const rootDir = path.join('C:', 'archimap');

  runRuntimeFollowups({
    region: { id: 42 },
    runtimeOptions: {
      dbProvider: 'postgres',
      databaseUrl: 'postgresql://archimap:archimap@db-postgres:5432/archimap',
      archimapDbPath: '/tmp/archimap.db',
      osmDbPath: '/tmp/osm.db',
      localEditsDbPath: '/tmp/local-edits.db'
    },
    env: {},
    rootDir,
    processExecPath: 'node',
    spawnSyncRef: (execPath, args, options = {}) => {
      calls.push({ execPath, args, options });
      return { status: 0 };
    }
  });

  assert.equal(calls.length, 2);
  assert.equal(calls[0].execPath, 'node');
  assert.equal(calls[0].args[0], path.join(rootDir, 'workers', 'rebuild-search-index.worker.js'));
  assert.equal(calls[0].options.env.SEARCH_REBUILD_REASON, 'region-sync:42');
  assert.equal(calls[0].options.env.DB_PROVIDER, 'postgres');
  assert.equal(calls[0].options.env.DATABASE_URL, 'postgresql://archimap:archimap@db-postgres:5432/archimap');

  assert.equal(calls[1].args[0], path.join(rootDir, 'workers', 'rebuild-filter-tag-keys-cache.worker.js'));
  assert.equal(calls[1].options.env.FILTER_TAG_KEYS_REBUILD_REASON, 'region-sync:42');
});
