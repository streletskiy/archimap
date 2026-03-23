const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const { createSearchIndexBoot } = require('../../src/lib/server/boot/search-index.boot');

function createDbStub() {
  const statement = {
    get() {
      return {
        search_source_count: 0,
        search_fts_count: 0,
        searchable_rows_expected: false,
        search_tsv_index_present: true
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
