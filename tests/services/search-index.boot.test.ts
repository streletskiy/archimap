const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const { createSearchIndexBoot } = require('../../src/lib/server/boot/search-index.boot');

function createDbStub(snapshot = {}) {
  const statement = {
    get() {
      return {
        search_source_count: 0,
        search_fts_count: 0,
        searchable_rows_expected: false,
        search_tsv_index_present: true,
        ...snapshot
      };
    },
    run() {},
    all() {
      return [];
    }
  };

  return {
    prepare() {
      return statement;
    }
  };
}

function createSearchIndexRefreshDbStub() {
  const metrics = {
    rawGets: [],
    upsertRuns: 0,
    deleteSourceRuns: 0,
    deleteFtsRuns: 0,
    insertFtsRuns: 0,
    lastUpsert: null
  };

  function createGenericStatement() {
    return {
      get() {
        return null;
      },
      run() {
        return { changes: 0, lastInsertRowid: 0 };
      },
      all() {
        return [];
      }
    };
  }

  function createCountsStatement() {
    return {
      get() {
        return {
          search_source_count: 0,
          search_fts_count: 0,
          searchable_rows_expected: false,
          search_tsv_index_present: true
        };
      },
      run() {
        return { changes: 0, lastInsertRowid: 0 };
      },
      all() {
        return [];
      }
    };
  }

  function createRawSearchSourceStatement() {
    return {
      get(osmType, osmId) {
        metrics.rawGets.push([osmType, osmId]);
        return {
          osm_type: osmType,
          osm_id: osmId,
          tags_json: JSON.stringify({
            name: `Building ${osmId}`
          }),
          local_name: `Building ${osmId}`,
          local_address: `Address ${osmId}`,
          local_style: 'style',
          local_architect: 'architect',
          local_design_ref: `DR-${osmId}`,
          local_priority: 1,
          center_lon: 10,
          center_lat: 20
        };
      },
      run() {
        return { changes: 0, lastInsertRowid: 0 };
      },
      all() {
        return [];
      }
    };
  }

  function createUpsertStatement() {
    return {
      get() {
        return null;
      },
      run(sourceRow) {
        metrics.upsertRuns += 1;
        metrics.lastUpsert = sourceRow;
        return { changes: 1, lastInsertRowid: 0 };
      },
      all() {
        return [];
      }
    };
  }

  function createDeleteStatement(counterKey) {
    return {
      get() {
        return null;
      },
      run() {
        metrics[counterKey] += 1;
        return { changes: 1, lastInsertRowid: 0 };
      },
      all() {
        return [];
      }
    };
  }

  return {
    db: {
      provider: 'sqlite',
      prepare(sql) {
        const text = String(sql || '');
        if (text.includes('search_source_count') && text.includes('search_fts_count')) {
          return createCountsStatement();
        }
        if (text.includes('bc.osm_type = ? AND bc.osm_id = ?')) {
          return createRawSearchSourceStatement();
        }
        if (text.includes('INSERT INTO building_search_source')) {
          return createUpsertStatement();
        }
        if (text.includes('DELETE FROM building_search_source')) {
          return createDeleteStatement('deleteSourceRuns');
        }
        if (text.includes('DELETE FROM building_search_fts')) {
          return createDeleteStatement('deleteFtsRuns');
        }
        if (text.includes('INSERT INTO building_search_fts')) {
          return createDeleteStatement('insertFtsRuns');
        }
        return createGenericStatement();
      }
    },
    metrics
  };
}

async function waitFor(predicate, timeoutMs = 1000) {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(`Timed out after ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

async function withTimeout(promise, timeoutMs = 1000) {
  let timeoutId = null;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error(`Timed out after ${timeoutMs}ms`)), timeoutMs);
      })
    ]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

function createChildProcessStub() {
  const child = new EventEmitter();
  child.killed = false;
  child.kill = () => {
    child.killed = true;
  };
  return child;
}

test('search index rebuild worker is spawned through tsx', async () => {
  const spawnCalls = [];
  const boot = createSearchIndexBoot({
    db: createDbStub(),
    dbProvider: 'sqlite',
    logger: { info() {}, error() {} },
    spawn: (_execPath, args, options) => {
      const child = createChildProcessStub();
      spawnCalls.push({ args, options });
      return child;
    },
    processExecPath: 'node',
    rootDir: '/app',
    searchRebuildScriptPath: 'scripts/rebuild-search-index.ts',
    batchSize: 100,
    env: {},
    sqlite: {
      dbPath: '/tmp/archimap.db',
      osmDbPath: '/tmp/osm.db',
      localEditsDbPath: '/tmp/local-edits.db'
    },
    isShuttingDown: () => false
  });

  await boot.rebuildSearchIndex('manual', { force: true });

  assert.equal(spawnCalls.length, 1);
  assert.deepEqual(spawnCalls[0].args, ['--import', 'tsx', 'scripts/rebuild-search-index.ts']);
});

test('search index rebuild starts again when PostgreSQL source index is missing', async () => {
  const spawnCalls = [];
  const boot = createSearchIndexBoot({
    db: createDbStub({
      search_source_count: 128,
      searchable_rows_expected: true,
      search_tsv_index_present: false
    }),
    dbProvider: 'postgres',
    logger: { info() {}, error() {} },
    spawn: (_execPath, args, options) => {
      const child = createChildProcessStub();
      spawnCalls.push({ args, options });
      return child;
    },
    processExecPath: 'node',
    rootDir: '/app',
    searchRebuildScriptPath: 'scripts/rebuild-search-index.ts',
    batchSize: 100,
    env: {},
    sqlite: {
      dbPath: '/tmp/archimap.db',
      osmDbPath: '/tmp/osm.db',
      localEditsDbPath: '/tmp/local-edits.db'
    },
    isShuttingDown: () => false
  });

  await boot.rebuildSearchIndex('startup');

  assert.equal(spawnCalls.length, 1);
});

test('search index refresh queue deduplicates repeated requests for the same building', async () => {
  const { db, metrics } = createSearchIndexRefreshDbStub();
  const boot = createSearchIndexBoot({
    db,
    dbProvider: 'sqlite',
    logger: { info() {}, error() {} },
    spawn: () => {
      throw new Error('rebuild worker should not be spawned');
    },
    processExecPath: 'node',
    rootDir: '/app',
    searchRebuildScriptPath: 'scripts/rebuild-search-index.ts',
    batchSize: 100,
    env: {},
    sqlite: {
      dbPath: '/tmp/archimap.db',
      osmDbPath: '/tmp/osm.db',
      localEditsDbPath: '/tmp/local-edits.db'
    },
    isShuttingDown: () => false
  });

  boot.enqueueSearchIndexRefresh('way', 1);
  boot.enqueueSearchIndexRefresh('way', 1);
  boot.enqueueSearchIndexRefresh('way', 1);

  await waitFor(() => metrics.rawGets.length === 1);

  assert.equal(metrics.rawGets.length, 1);
  assert.deepEqual(metrics.rawGets[0], ['way', 1]);
  assert.equal(metrics.upsertRuns, 1);
  assert.equal(metrics.deleteSourceRuns, 0);
  assert.equal(metrics.deleteFtsRuns, 1);
  assert.equal(metrics.insertFtsRuns, 1);
});

test('search index refresh queue processes distinct buildings in one batch', async () => {
  const { db, metrics } = createSearchIndexRefreshDbStub();
  const boot = createSearchIndexBoot({
    db,
    dbProvider: 'sqlite',
    logger: { info() {}, error() {} },
    spawn: () => {
      throw new Error('rebuild worker should not be spawned');
    },
    processExecPath: 'node',
    rootDir: '/app',
    searchRebuildScriptPath: 'scripts/rebuild-search-index.ts',
    batchSize: 100,
    env: {},
    sqlite: {
      dbPath: '/tmp/archimap.db',
      osmDbPath: '/tmp/osm.db',
      localEditsDbPath: '/tmp/local-edits.db'
    },
    isShuttingDown: () => false
  });

  boot.enqueueSearchIndexRefresh('way', 1);
  boot.enqueueSearchIndexRefresh('relation', 2);

  await waitFor(() => metrics.rawGets.length === 2);

  assert.deepEqual(metrics.rawGets, [
    ['way', 1],
    ['relation', 2]
  ]);
  assert.equal(metrics.upsertRuns, 2);
  assert.equal(metrics.deleteSourceRuns, 0);
  assert.equal(metrics.deleteFtsRuns, 2);
  assert.equal(metrics.insertFtsRuns, 2);
});

test('search index refresh dispatches to the worker in fire-and-forget mode', async () => {
  const { db, metrics } = createSearchIndexRefreshDbStub();
  const spawnCalls = [];
  const sentMessages = [];
  const child = createChildProcessStub();
  child.send = (message) => {
    sentMessages.push(message);
    return true;
  };

  const boot = createSearchIndexBoot({
    db,
    dbProvider: 'sqlite',
    logger: { info() {}, error() {} },
    spawn: (_execPath, args, options) => {
      spawnCalls.push({ args, options });
      return child;
    },
    processExecPath: 'node',
    rootDir: '/app',
    searchRebuildScriptPath: 'scripts/rebuild-search-index.ts',
    searchRefreshWorkerScriptPath: 'workers/refresh-search-index.worker.ts',
    batchSize: 100,
    env: {},
    sqlite: {
      dbPath: '/tmp/archimap.db',
      osmDbPath: '/tmp/osm.db',
      localEditsDbPath: '/tmp/local-edits.db'
    },
    isShuttingDown: () => false
  });

  await withTimeout(boot.refreshSearchIndexForBuilding('way', 1));

  assert.equal(spawnCalls.length, 1);
  assert.deepEqual(spawnCalls[0].args, ['--import', 'tsx', 'workers/refresh-search-index.worker.ts']);
  assert.equal(sentMessages.length, 1);
  assert.equal(sentMessages[0].type, 'refresh');
  assert.equal(metrics.rawGets.length, 0);
});
