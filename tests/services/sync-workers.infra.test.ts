const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');

const { initSyncWorkersInfra } = require('../../src/lib/server/infra/sync-workers.infra');

type ManagedDataSettingsOverrides = {
  refreshAllNextSyncAt?: () => Promise<Array<Record<string, unknown>>>;
} & Record<string, unknown>;

function waitForMicrotasks() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

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

function createChildProcessStub() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killed = false;
  child.kill = (signal = 'SIGTERM') => {
    child.killed = true;
    child.emit('close', null, signal);
  };
  return child;
}

function createManagedDataSettingsService(regions = [], overrides: ManagedDataSettingsOverrides = {}) {
  let nextRunId = 1;
  let managedEnabled = true;
  const regionMap = new Map(regions.map((region) => [region.id, { ...region }]));
  const runMap = new Map();
  const defaultRefreshAllNextSyncAt = async () => [...regionMap.values()].filter(() => managedEnabled).map((region) => ({ ...region }));

  return {
    setManagedEnabled(value) {
      managedEnabled = Boolean(value);
    },
    bootstrapFromEnvIfNeeded: async () => ({ imported: false }),
    recoverInterruptedRuns: async () => [],
    refreshAllNextSyncAt: overrides.refreshAllNextSyncAt || defaultRefreshAllNextSyncAt,
    listRegions: async () => [...regionMap.values()].filter(() => managedEnabled).map((region) => ({ ...region })),
    getRegionById: async (regionId) => {
      const item = regionMap.get(Number(regionId));
      return item ? { ...item } : null;
    },
    createQueuedRun: async (regionId, triggerReason, requestedBy) => {
      const run = {
        id: nextRunId += 1,
        regionId: Number(regionId),
        status: 'queued',
        triggerReason,
        requestedBy
      };
      runMap.set(run.id, { ...run });
      const region = regionMap.get(Number(regionId));
      if (region) {
        region.lastSyncStatus = 'queued';
      }
      return { ...run };
    },
    getRunById: async (runId) => {
      const run = runMap.get(Number(runId));
      return run ? { ...run } : null;
    },
    getRecentRuns: async (regionId) => {
      return [...runMap.values()]
        .filter((run) => run.regionId === Number(regionId))
        .sort((left, right) => right.id - left.id)
        .map((run) => ({ ...run }));
    },
    markRunStarted: async (runId) => {
      const run = runMap.get(Number(runId));
      run.status = 'running';
      const region = regionMap.get(run.regionId);
      if (region) {
        region.lastSyncStatus = 'running';
      }
      return { ...run };
    },
    markRunSucceeded: async (runId, summary: LooseRecord = {}) => {
      const run = runMap.get(Number(runId));
      run.status = 'success';
      run.summary = { ...summary };
      const region = regionMap.get(run.regionId);
      if (region) {
        region.lastSyncStatus = 'idle';
        region.lastFeatureCount = summary.activeFeatureCount ?? null;
      }
      return {
        run: { ...run },
        region: region ? { ...region } : null
      };
    },
    markRunFailed: async (runId, errorText) => {
      const run = runMap.get(Number(runId));
      run.status = 'failed';
      run.error = String(errorText || '');
      const region = regionMap.get(run.regionId);
      if (region) {
        region.lastSyncStatus = 'failed';
      }
      return {
        run: { ...run },
        region: region ? { ...region } : null
      };
    },
    ...overrides
  };
}

test('managed sync workers execute region jobs through a single queue', async () => {
  const children = [];
  const spawnCalls = [];
  const dataSettingsService = createManagedDataSettingsService([
    {
      id: 1,
      enabled: true,
      autoSyncEnabled: false,
      autoSyncOnStart: false,
      nextSyncAt: null,
      lastSyncStatus: 'idle'
    },
    {
      id: 2,
      enabled: true,
      autoSyncEnabled: false,
      autoSyncOnStart: false,
      nextSyncAt: null,
      lastSyncStatus: 'idle'
    }
  ]);

  const workers = initSyncWorkersInfra({
    spawn: (_execPath, args) => {
      spawnCalls.push(args);
      const child = createChildProcessStub();
      children.push(child);
      return child;
    },
    processExecPath: process.execPath,
    syncRegionScriptPath: 'managed.ts',
    cwd: process.cwd(),
    env: process.env,
    dataSettingsService,
    isShuttingDown: () => false,
    onSyncSuccess: async () => {},
    log: { log() {}, error() {} }
  });

  await workers.requestRegionSync(1, { triggerReason: 'manual', requestedBy: 'tester' });
  await workers.requestRegionSync(2, { triggerReason: 'manual', requestedBy: 'tester' });

  assert.equal(spawnCalls.length, 1);
  assert.deepEqual(spawnCalls[0], ['--import', 'tsx', 'managed.ts', '--region-id=1']);

  children[0].stdout.emit('data', Buffer.from('SYNC_RESULT_JSON={"activeFeatureCount":10,"importedFeatureCount":10,"orphanDeletedCount":0,"pmtilesBytes":100,"bounds":{"west":1,"south":1,"east":2,"north":2}}\n'));
  children[0].emit('close', 0, null);

  await waitForMicrotasks();

  assert.equal(spawnCalls.length, 2);
  assert.deepEqual(spawnCalls[1], ['--import', 'tsx', 'managed.ts', '--region-id=2']);
});

test('managed sync workers return queued responses without waiting for schedule refresh', async () => {
  const children = [];
  const refreshGate = createDeferredPromise();
  let refreshStarted = 0;
  const dataSettingsService = createManagedDataSettingsService([
    {
      id: 1,
      enabled: true,
      autoSyncEnabled: false,
      autoSyncOnStart: false,
      nextSyncAt: null,
      lastSyncStatus: 'idle'
    }
  ], {
    refreshAllNextSyncAt: async () => {
      refreshStarted += 1;
      await refreshGate.promise;
      return [];
    }
  });

  const workers = initSyncWorkersInfra({
    spawn: () => {
      const child = createChildProcessStub();
      children.push(child);
      return child;
    },
    processExecPath: process.execPath,
    syncRegionScriptPath: 'managed.ts',
    cwd: process.cwd(),
    env: process.env,
    dataSettingsService,
    isShuttingDown: () => false,
    onSyncSuccess: async () => {},
    log: { log() {}, error() {} }
  });

  const requestPromise = workers.requestRegionSync(1, { triggerReason: 'manual', requestedBy: 'tester' });
  await waitForMicrotasks();

  assert.equal(refreshStarted, 1);
  assert.equal(children.length, 1);

  const queued = await Promise.race([
    requestPromise,
    new Promise((resolve) => setTimeout(() => resolve({ timeout: true }), 50))
  ]);
  assert.equal(queued?.timeout, undefined);
  assert.equal(queued?.queued, true);

  refreshGate.resolve();
  children[0].stdout.emit('data', Buffer.from('SYNC_RESULT_JSON={"activeFeatureCount":10,"importedFeatureCount":10,"orphanDeletedCount":0,"pmtilesBytes":100,"bounds":{"west":1,"south":1,"east":2,"north":2}}\n'));
  children[0].emit('close', 0, null);

  await waitForMicrotasks();
});

test('managed sync workers defer post-sync maintenance until the queue drains', async () => {
  const children = [];
  const successEvents = [];
  const dataSettingsService = createManagedDataSettingsService([
    {
      id: 1,
      enabled: true,
      autoSyncEnabled: false,
      autoSyncOnStart: false,
      nextSyncAt: null,
      lastSyncStatus: 'idle'
    },
    {
      id: 2,
      enabled: true,
      autoSyncEnabled: false,
      autoSyncOnStart: false,
      nextSyncAt: null,
      lastSyncStatus: 'idle'
    }
  ]);

  const workers = initSyncWorkersInfra({
    spawn: () => {
      const child = createChildProcessStub();
      children.push(child);
      return child;
    },
    processExecPath: process.execPath,
    syncRegionScriptPath: 'managed.ts',
    cwd: process.cwd(),
    env: process.env,
    dataSettingsService,
    isShuttingDown: () => false,
    onSyncSuccess: async (payload) => {
      successEvents.push(payload);
    },
    log: { log() {}, error() {} }
  });

  await workers.requestRegionSync(1, { triggerReason: 'manual', requestedBy: 'tester' });
  await workers.requestRegionSync(2, { triggerReason: 'manual', requestedBy: 'tester' });

  children[0].stdout.emit('data', Buffer.from('SYNC_RESULT_JSON={"activeFeatureCount":10}\n'));
  children[0].emit('close', 0, null);
  await waitForMicrotasks();

  assert.equal(successEvents.length, 0);

  children[1].stdout.emit('data', Buffer.from('SYNC_RESULT_JSON={"activeFeatureCount":20}\n'));
  children[1].emit('close', 0, null);
  await waitForMicrotasks();

  assert.equal(successEvents.length, 1);
  assert.equal(successEvents[0]?.region?.id, 2);
  assert.equal(successEvents[0]?.summary?.activeFeatureCount, 20);
});

test('managed sync workers flush deferred maintenance after the queue drains on failure', async () => {
  const children = [];
  const successEvents = [];
  const dataSettingsService = createManagedDataSettingsService([
    {
      id: 1,
      enabled: true,
      autoSyncEnabled: false,
      autoSyncOnStart: false,
      nextSyncAt: null,
      lastSyncStatus: 'idle'
    },
    {
      id: 2,
      enabled: true,
      autoSyncEnabled: false,
      autoSyncOnStart: false,
      nextSyncAt: null,
      lastSyncStatus: 'idle'
    }
  ]);

  const workers = initSyncWorkersInfra({
    spawn: () => {
      const child = createChildProcessStub();
      children.push(child);
      return child;
    },
    processExecPath: process.execPath,
    syncRegionScriptPath: 'managed.ts',
    cwd: process.cwd(),
    env: process.env,
    dataSettingsService,
    isShuttingDown: () => false,
    onSyncSuccess: async (payload) => {
      successEvents.push(payload);
    },
    log: { log() {}, error() {} }
  });

  await workers.requestRegionSync(1, { triggerReason: 'manual', requestedBy: 'tester' });
  await workers.requestRegionSync(2, { triggerReason: 'manual', requestedBy: 'tester' });

  children[0].stdout.emit('data', Buffer.from('SYNC_RESULT_JSON={"activeFeatureCount":10}\n'));
  children[0].emit('close', 0, null);
  await waitForMicrotasks();

  assert.equal(successEvents.length, 0);

  children[1].stderr.emit('data', Buffer.from('second run failed\n'));
  children[1].emit('close', 1, null);
  await waitForMicrotasks();

  assert.equal(successEvents.length, 1);
  assert.equal(successEvents[0]?.region?.id, 1);
  assert.equal(successEvents[0]?.summary?.activeFeatureCount, 10);
});

test('sync workers can switch from none mode to managed mode after regions appear', async () => {
  const dataSettingsService = createManagedDataSettingsService([
    {
      id: 7,
      enabled: true,
      autoSyncEnabled: false,
      autoSyncOnStart: false,
      nextSyncAt: null,
      lastSyncStatus: 'idle'
    }
  ]);
  dataSettingsService.setManagedEnabled(false);

  const workers = initSyncWorkersInfra({
    spawn: () => createChildProcessStub(),
    processExecPath: process.execPath,
    syncRegionScriptPath: 'managed.ts',
    cwd: process.cwd(),
    env: process.env,
    dataSettingsService,
    isShuttingDown: () => false,
    onSyncSuccess: async () => {},
    log: { log() {}, error() {} }
  });

  await assert.rejects(
    () => workers.requestRegionSync(7, { triggerReason: 'manual', requestedBy: 'tester' }),
    /DB-backed region sync is not configured/
  );

  dataSettingsService.setManagedEnabled(true);

  const result = await workers.requestRegionSync(7, {
    triggerReason: 'manual',
    requestedBy: 'tester'
  });
  assert.equal(result.region.id, 7);
  assert.equal(result.queued, true);
});

test('managed sync workers disable standalone runtime followup in child env', async () => {
  const spawnCalls = [];
  const dataSettingsService = createManagedDataSettingsService([
    {
      id: 3,
      enabled: true,
      autoSyncEnabled: false,
      autoSyncOnStart: false,
      nextSyncAt: null,
      lastSyncStatus: 'idle'
    }
  ]);

  const workers = initSyncWorkersInfra({
    spawn: (_execPath, _args, options = {}) => {
      spawnCalls.push(options);
      return createChildProcessStub();
    },
    processExecPath: process.execPath,
    syncRegionScriptPath: 'managed.ts',
    cwd: process.cwd(),
    env: process.env,
    dataSettingsService,
    isShuttingDown: () => false,
    onSyncSuccess: async () => {},
    log: { log() {}, error() {} }
  });

  await workers.requestRegionSync(3, {
    triggerReason: 'manual',
    requestedBy: 'tester'
  });

  assert.equal(spawnCalls.length, 1);
  assert.equal(spawnCalls[0]?.env?.REGION_SYNC_SKIP_RUNTIME_FOLLOWUP, 'true');

  workers.stop();
  await waitForMicrotasks();
});
