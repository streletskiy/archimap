const test = require('node:test');
const assert = require('node:assert/strict');

const { runPostDbStartupTasks, runPostSyncTasks } = require('../../src/lib/server/boot/server-runtime.boot');

function createDeferredPromise() {
  let resolve;
  let reject;
  const promise = new Promise((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return {
    promise,
    resolve,
    reject
  };
}

function waitForTick() {
  return new Promise((resolve) => setImmediate(resolve));
}

test('runPostDbStartupTasks defers startup search rebuild while sync is already running', async () => {
  const events = [];
  const logs = [];
  const runtime = {
    refreshRuntimeSettings() {
      events.push('refresh');
    },
    scheduleFilterTagKeysCacheRebuild(reason) {
      events.push(`filter:${reason}`);
    },
    refreshDesignRefSuggestionsCache(reason) {
      events.push(`design-ref:${reason}`);
      return Promise.resolve();
    },
    rebuildSearchIndex(reason) {
      events.push(`search:${reason}`);
      return Promise.resolve();
    },
    scheduleBuildingContoursRtreeRebuild(reason) {
      events.push(`rtree:${reason}`);
    },
    rtreeState: { ready: true },
    syncWorkers: {
      running: false,
      async initAutoSync() {
        events.push('sync:init');
        this.running = true;
      },
      isSyncInProgress() {
        return this.running;
      }
    },
    logger: {
      info(code, payload) {
        logs.push({ level: 'info', code, payload });
      },
      error(code, payload) {
        logs.push({ level: 'error', code, payload });
      }
    }
  };

  await runPostDbStartupTasks(runtime);

  assert.deepEqual(events, ['refresh', 'design-ref:startup', 'sync:init']);
  assert.equal(
    logs.some((item) => item.code === 'search_rebuild_startup_deferred'),
    true
  );
  assert.equal(
    logs.some((item) => item.code === 'auto_sync_init_failed'),
    false
  );
});

test('runPostDbStartupTasks starts startup search rebuild when sync is idle', async () => {
  const events = [];
  const logs = [];
  const runtime = {
    refreshRuntimeSettings() {
      events.push('refresh');
    },
    scheduleFilterTagKeysCacheRebuild(reason) {
      events.push(`filter:${reason}`);
    },
    refreshDesignRefSuggestionsCache(reason) {
      events.push(`design-ref:${reason}`);
      return Promise.resolve();
    },
    rebuildSearchIndex(reason) {
      events.push(`search:${reason}`);
      return Promise.resolve();
    },
    scheduleBuildingContoursRtreeRebuild(reason) {
      events.push(`rtree:${reason}`);
    },
    rtreeState: { ready: false },
    syncWorkers: {
      async initAutoSync() {
        events.push('sync:init');
      },
      isSyncInProgress() {
        return false;
      }
    },
    logger: {
      info(code, payload) {
        logs.push({ level: 'info', code, payload });
      },
      error(code, payload) {
        logs.push({ level: 'error', code, payload });
      }
    }
  };

  await runPostDbStartupTasks(runtime);
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(events, ['refresh', 'design-ref:startup', 'sync:init', 'search:startup', 'rtree:startup']);
  assert.equal(
    logs.some((item) => item.code === 'search_rebuild_startup_deferred'),
    false
  );
  assert.equal(
    logs.some((item) => item.code === 'search_rebuild_startup_failed'),
    false
  );
});

test('runPostSyncTasks schedules filter-tag rebuild only after design ref refresh settles', async () => {
  const events = [];
  const refreshGate = createDeferredPromise();
  const runtime = {
    logger: {
      info() {},
      error() {}
    },
    rebuildSearchIndex(reason) {
      events.push(`search:${reason}`);
      return Promise.resolve();
    },
    resetFilterTagKeysCache() {
      events.push('filter-reset');
    },
    scheduleFilterTagKeysCacheRebuild(reason) {
      events.push(`filter:${reason}`);
    },
    refreshDesignRefSuggestionsCache(reason) {
      events.push(`design-start:${reason}`);
      return refreshGate.promise.then(() => {
        events.push(`design-finish:${reason}`);
      });
    }
  };

  const maintenancePromise = runPostSyncTasks(runtime, { region: { id: 71 } });
  await waitForTick();

  assert.deepEqual(events, [
    'search:region-sync:71',
    'filter-reset',
    'design-start:region-sync:71'
  ]);
  assert.equal(events.some((entry) => String(entry).startsWith('filter:region-sync:71')), false);

  refreshGate.resolve();
  await maintenancePromise;

  assert.deepEqual(events, [
    'search:region-sync:71',
    'filter-reset',
    'design-start:region-sync:71',
    'design-finish:region-sync:71',
    'filter:region-sync:71'
  ]);
});
