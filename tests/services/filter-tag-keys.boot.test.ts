const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const { createFilterTagKeysBoot } = require('../../src/lib/server/boot/filter-tag-keys.boot');

function createDbStub() {
  return {
    prepare() {
      return {
        all() {
          return [];
        }
      };
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

test('filter tag key rebuild worker is spawned through tsx', () => {
  const spawnCalls = [];
  const boot = createFilterTagKeysBoot({
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
    filterTagKeysRebuildScriptPath: 'workers/rebuild-filter-tag-keys-cache.worker.ts',
    env: {},
    sqlite: {
      dbPath: '/tmp/archimap.db',
      osmDbPath: '/tmp/osm.db'
    },
    getEffectiveFilterTagAllowlist: () => ({ allowlistSet: new Set() }),
    normalizeFilterTagKey: (key) => String(key || '').trim()
  });

  boot.scheduleFilterTagKeysCacheRebuild('manual');

  assert.equal(spawnCalls.length, 1);
  assert.deepEqual(spawnCalls[0].args, ['--import', 'tsx', 'workers/rebuild-filter-tag-keys-cache.worker.ts']);
});

test('empty filter tag cache triggers a cold-start rebuild on first read', async () => {
  const spawnCalls = [];
  const boot = createFilterTagKeysBoot({
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
    filterTagKeysRebuildScriptPath: 'workers/rebuild-filter-tag-keys-cache.worker.ts',
    env: {},
    sqlite: {
      dbPath: '/tmp/archimap.db',
      osmDbPath: '/tmp/osm.db'
    },
    getEffectiveFilterTagAllowlist: () => ({ allowlistSet: new Set() }),
    normalizeFilterTagKey: (key) => String(key || '').trim()
  });

  const keys = await boot.getAllFilterTagKeysCached();

  assert.deepEqual(keys, []);
  assert.equal(spawnCalls.length, 1);
  assert.deepEqual(spawnCalls[0].args, ['--import', 'tsx', 'workers/rebuild-filter-tag-keys-cache.worker.ts']);
});
