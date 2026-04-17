const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  buildApplyStageDetail,
  buildExtractorEnv,
  buildRuntimeFollowupEnv,
  isProcessAlive,
  readExportSummary,
  resolveParentWatchdogPid,
  resolveImporterDbGeometryMode,
  runRuntimeFollowups,
  startParentWatchdog,
  shouldUseLowMemoryPipeline,
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
      dbProvider: 'sqlite',
      databaseUrl: '',
      archimapDbPath: '/tmp/archimap.db',
      osmDbPath: '/tmp/osm.db',
      localEditsDbPath: '/tmp/local-edits.db'
    },
    {}
  );

  assert.equal(env.DB_PROVIDER, 'sqlite');
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
  assert.equal(resolveImporterDbGeometryMode({ dbProvider: 'postgres' }), 'wkb_hex');
  assert.equal(resolveImporterDbGeometryMode({ dbProvider: 'sqlite' }), 'geojson');
});

test('buildApplyStageDetail includes feature totals when known', () => {
  assert.equal(buildApplyStageDetail(123), 'importing 123 features into database');
  assert.equal(buildApplyStageDetail(null), 'applying region import to database');
});

test('shouldUseLowMemoryPipeline only enables apply-first mode for postgres', () => {
  assert.equal(shouldUseLowMemoryPipeline({ dbProvider: 'postgres' }, {}), false);
  assert.equal(
    shouldUseLowMemoryPipeline(
      {
        dbProvider: 'postgres'
      },
      {
        REGION_SYNC_LOW_MEMORY_PIPELINE: 'true'
      }
    ),
    true
  );
  assert.equal(
    shouldUseLowMemoryPipeline(
      {
        dbProvider: 'sqlite'
      },
      {
        REGION_SYNC_LOW_MEMORY_PIPELINE: 'true'
      }
    ),
    false
  );
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
    }
  });

  assert.equal(timers.length, 1);
  assert.equal(timers[0].ms, 5_000);
  timers[0].fn();

  assert.deepEqual(exitCalls, [131]);
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

test('readExportSummary returns normalized summary for valid exporter metadata', () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'archimap-export-summary-'));
  const summaryPath = path.join(workspace, 'region-export-summary.json');

  try {
    fs.writeFileSync(
      summaryPath,
      JSON.stringify({
        importedFeatureCount: 123,
        bounds: {
          west: 37.5,
          south: 55.5,
          east: 37.7,
          north: 55.7
        }
      })
    );

    assert.deepEqual(readExportSummary(summaryPath), {
      importedFeatureCount: 123,
      bounds: {
        west: 37.5,
        south: 55.5,
        east: 37.7,
        north: 55.7
      }
    });
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('readExportSummary returns null for missing or malformed exporter metadata', () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'archimap-export-summary-'));
  const missingPath = path.join(workspace, 'missing.json');
  const invalidPath = path.join(workspace, 'invalid.json');

  try {
    fs.writeFileSync(
      invalidPath,
      JSON.stringify({
        importedFeatureCount: 'NaN',
        bounds: {
          west: 37.5,
          south: 55.5,
          east: 'bad',
          north: 55.7
        }
      })
    );

    assert.equal(readExportSummary(missingPath), null);
    assert.equal(readExportSummary(invalidPath), null);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});
