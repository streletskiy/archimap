const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');

const { initSyncWorkersInfra } = require('../../src/lib/server/infra/sync-workers.infra');

function waitForMicrotasks() {
  return new Promise((resolve) => setTimeout(resolve, 0));
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

function createManagedDataSettingsService(regions = []) {
  let nextRunId = 1;
  let managedEnabled = true;
  const regionMap = new Map(regions.map((region) => [region.id, { ...region }]));
  const runMap = new Map();

  return {
    setManagedEnabled(value) {
      managedEnabled = Boolean(value);
    },
    bootstrapFromEnvIfNeeded: async () => ({ imported: false }),
    recoverInterruptedRuns: async () => [],
    refreshAllNextSyncAt: async () => [...regionMap.values()].filter(() => managedEnabled).map((region) => ({ ...region })),
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
    markRunSucceeded: async (runId, summary = {}) => {
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
    }
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
    syncRegionScriptPath: 'managed.js',
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
  assert.deepEqual(spawnCalls[0], ['managed.js', '--region-id=1']);

  children[0].stdout.emit('data', Buffer.from('SYNC_RESULT_JSON={"activeFeatureCount":10,"importedFeatureCount":10,"orphanDeletedCount":0,"pmtilesBytes":100,"bounds":{"west":1,"south":1,"east":2,"north":2}}\n'));
  children[0].emit('close', 0, null);

  await waitForMicrotasks();

  assert.equal(spawnCalls.length, 2);
  assert.deepEqual(spawnCalls[1], ['managed.js', '--region-id=2']);
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
    syncRegionScriptPath: 'managed.js',
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
    syncRegionScriptPath: 'managed.js',
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
    syncRegionScriptPath: 'managed.js',
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
