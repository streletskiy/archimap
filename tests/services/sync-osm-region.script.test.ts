const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const {
  buildApplyStageDetail,
  buildExtractorEnv,
  buildRuntimeFollowupEnv,
  isProcessAlive,
  resolveParentWatchdogPid,
  resolveImporterDbGeometryMode,
  runRuntimeFollowups,
  startParentWatchdog,
  shouldRunRuntimeFollowup
} = require('../../scripts/sync-osm-region');

test('shouldRunRuntimeFollowup skips pmtiles-only and managed runtime env', () => {
  assert.equal(shouldRunRuntimeFollowup({ pmtilesOnly: true, env: {} }), false);
  assert.equal(
    shouldRunRuntimeFollowup({
      pmtilesOnly: false,
      env: { REGION_SYNC_SKIP_RUNTIME_FOLLOWUP: 'true' }
    }),
    false
  );
  assert.equal(shouldRunRuntimeFollowup({ pmtilesOnly: false, env: {} }), true);
});

test('buildRuntimeFollowupEnv carries explicit runtime DB paths and provider config', () => {
  const env = buildRuntimeFollowupEnv(
    {
      dbProvider: 'postgres',
      databaseUrl: 'postgresql://archimap:archimap@db-postgres:5432/archimap',
      archimapDbPath: '/tmp/archimap.db',
      osmDbPath: '/tmp/osm.db',
      localEditsDbPath: '/tmp/local-edits.db'
    },
    {}
  );

  assert.equal(env.DB_PROVIDER, 'postgres');
  assert.equal(env.DATABASE_URL, 'postgresql://archimap:archimap@db-postgres:5432/archimap');
  assert.equal(env.ARCHIMAP_DB_PATH, '/tmp/archimap.db');
  assert.equal(env.DATABASE_PATH, '/tmp/archimap.db');
  assert.equal(env.OSM_DB_PATH, '/tmp/osm.db');
  assert.equal(env.LOCAL_EDITS_DB_PATH, '/tmp/local-edits.db');
});

test('buildExtractorEnv rewrites parent pid for nested importer subprocesses', () => {
  const env = buildExtractorEnv({
    REGION_SYNC_PARENT_PID: '999',
    CUSTOM_FLAG: 'true'
  });

  assert.equal(env.CUSTOM_FLAG, 'true');
  assert.equal(env.REGION_SYNC_PARENT_PID, String(process.pid));
});

test('resolveImporterDbGeometryMode matches DB provider needs', () => {
  assert.equal(resolveImporterDbGeometryMode({ dbProvider: 'postgres', databaseUrl: 'postgresql://example/app' }), 'postgres_stage');
  assert.throws(() => resolveImporterDbGeometryMode({ dbProvider: 'sqlite' }), /DB_PROVIDER=postgres/);
});

test('buildApplyStageDetail includes feature totals when known', () => {
  assert.equal(buildApplyStageDetail(123), 'merging 123 staging rows into canonical tables');
  assert.equal(buildApplyStageDetail(null), 'merging staging rows into canonical tables');
});

test('resolveParentWatchdogPid reads valid external parent pid only', () => {
  assert.equal(resolveParentWatchdogPid({}), null);
  assert.equal(resolveParentWatchdogPid({ REGION_SYNC_PARENT_PID: String(process.pid) }), null);
  assert.equal(resolveParentWatchdogPid({ REGION_SYNC_PARENT_PID: '4321' }), 4321);
});

test('isProcessAlive interprets ESRCH and EPERM correctly', () => {
  assert.equal(
    isProcessAlive(123, () => {}),
    true
  );
  assert.equal(
    isProcessAlive(123, () => {
      const error = new Error('missing');
      error.code = 'ESRCH';
      throw error;
    }),
    false
  );
  assert.equal(
    isProcessAlive(123, () => {
      const error = new Error('forbidden');
      error.code = 'EPERM';
      throw error;
    }),
    true
  );
});

test('startParentWatchdog exits when the configured parent disappears', () => {
  const timers = [];
  const exitCalls = [];
  const stderrWrites = [];
  const cleanupReasons = [];

  const stop = startParentWatchdog({
    env: { REGION_SYNC_PARENT_PID: '555' },
    setIntervalRef: (fn, ms) => {
      const timer = { fn, ms, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearIntervalRef: () => {},
    killRef: () => {
      const error = new Error('gone');
      error.code = 'ESRCH';
      throw error;
    },
    exitRef: (code) => {
      exitCalls.push(code);
    },
    stderr: {
      write(message) {
        stderrWrites.push(String(message));
      }
    },
    onBeforeExit: (reason) => cleanupReasons.push(reason)
  });

  assert.equal(timers.length, 1);
  assert.equal(timers[0].ms, 5_000);
  timers[0].fn();

  assert.deepEqual(exitCalls, [131]);
  assert.deepEqual(cleanupReasons, ['parent process 555 disappeared']);
  assert.equal(stderrWrites.length, 1);

  stop();
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
  assert.equal(calls[0].args[0], '--import');
  assert.equal(calls[0].args[1], 'tsx');
  assert.equal(calls[0].args[2], path.join(rootDir, 'workers', 'rebuild-search-index.worker.ts'));
  assert.equal(calls[0].options.env.SEARCH_REBUILD_REASON, 'region-sync:42');
  assert.equal(calls[0].options.env.DB_PROVIDER, 'postgres');
  assert.equal(calls[0].options.env.DATABASE_URL, 'postgresql://archimap:archimap@db-postgres:5432/archimap');

  assert.equal(calls[1].args[0], '--import');
  assert.equal(calls[1].args[1], 'tsx');
  assert.equal(calls[1].args[2], path.join(rootDir, 'workers', 'rebuild-filter-tag-keys-cache.worker.ts'));
  assert.equal(calls[1].options.env.FILTER_TAG_KEYS_REBUILD_REASON, 'region-sync:42');
});
