const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');

const { initSyncWorkersInfra, _test_ } = require('../../src/lib/server/infra/sync-workers.infra');

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
    getRegionUpstreamState: async (regionOrId) => {
      const region = typeof regionOrId === 'object' && regionOrId
        ? regionOrId
        : regionMap.get(Number(regionOrId));
      return region ? { ...region } : null;
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
    markRunFailed: async (runId, errorText, options: LooseRecord = {}) => {
      const run = runMap.get(Number(runId));
      run.status = String(options?.status || 'failed');
      run.error = String(errorText || '');
      const region = regionMap.get(run.regionId);
      if (region) {
        region.lastSyncStatus = run.status;
      }
      return {
        run: { ...run },
        region: region ? { ...region } : null
      };
    },
    updateRunStage: async (runId, stage, progress = null, detail = null) => {
      const run = runMap.get(Number(runId));
      if (!run) return null;
      run.stage = stage || null;
      run.stageProgress = Number.isFinite(Number(progress)) ? Number(progress) : null;
      run.stageDetail = detail || null;
      return { ...run };
    },
    markRunCancelRequested: async (runId) => {
      const run = runMap.get(Number(runId));
      if (!run) return null;
      run.cancelRequested = true;
      run.stage = 'cancelling';
      return { ...run };
    },
    rescheduleRegionAfterSkippedSync: async (regionId) => {
      const region = regionMap.get(Number(regionId));
      if (region) {
        region.nextSyncAt = 'rescheduled';
      }
      return region ? { ...region } : null;
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

test('managed sync workers reject manual sync when upstream data is already up to date', async () => {
  let spawnCalls = 0;
  const dataSettingsService = createManagedDataSettingsService([
    {
      id: 11,
      enabled: true,
      autoSyncEnabled: false,
      autoSyncOnStart: false,
      nextSyncAt: null,
      lastSyncStatus: 'idle',
      lastSuccessfulSyncAt: '2026-04-01T00:00:00.000Z'
    }
  ], {
    getRegionUpstreamState: async (regionOrId) => {
      const region = typeof regionOrId === 'object' && regionOrId
        ? regionOrId
        : await dataSettingsService.getRegionById(regionOrId);
      return {
        ...region,
        upstreamStatus: 'up_to_date',
        latestSourceDataUpdatedAt: '2026-04-01T00:00:00.000Z'
      };
    }
  });

  const workers = initSyncWorkersInfra({
    spawn: () => {
      spawnCalls += 1;
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

  await assert.rejects(
    () => workers.requestRegionSync(11, { triggerReason: 'manual', requestedBy: 'tester' }),
    /No upstream update is available/
  );
  assert.equal(spawnCalls, 0);
});

test('managed sync workers skip scheduled sync when upstream data is already up to date', async () => {
  let spawnCalls = 0;
  let rescheduled = 0;
  const dataSettingsService = createManagedDataSettingsService([
    {
      id: 12,
      enabled: true,
      autoSyncEnabled: true,
      autoSyncOnStart: false,
      nextSyncAt: '2026-04-08T00:00:00.000Z',
      lastSyncStatus: 'idle',
      lastSuccessfulSyncAt: '2026-04-01T00:00:00.000Z'
    }
  ], {
    getRegionUpstreamState: async (regionOrId) => {
      const region = typeof regionOrId === 'object' && regionOrId
        ? regionOrId
        : await dataSettingsService.getRegionById(regionOrId);
      return {
        ...region,
        upstreamStatus: 'up_to_date',
        latestSourceDataUpdatedAt: '2026-04-01T00:00:00.000Z'
      };
    },
    rescheduleRegionAfterSkippedSync: async (regionId) => {
      rescheduled += 1;
      return dataSettingsService.getRegionById(regionId);
    }
  });

  const workers = initSyncWorkersInfra({
    spawn: () => {
      spawnCalls += 1;
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

  const result = await workers.requestRegionSync(12, {
    triggerReason: 'scheduled',
    requestedBy: 'system'
  });

  assert.equal(result.queued, false);
  assert.equal(result.skipped, true);
  assert.equal(spawnCalls, 0);
  assert.equal(rescheduled, 1);
});

test('managed sync workers pass imported source version marker to successful runs', async () => {
  const children = [];
  const dataSettingsService = createManagedDataSettingsService([
    {
      id: 13,
      enabled: true,
      autoSyncEnabled: false,
      autoSyncOnStart: false,
      nextSyncAt: null,
      lastSyncStatus: 'idle'
    }
  ], {
    getRegionUpstreamState: async (regionOrId) => {
      const region = typeof regionOrId === 'object' && regionOrId
        ? regionOrId
        : await dataSettingsService.getRegionById(regionOrId);
      return {
        ...region,
        latestSourceDataUpdatedAt: '2026-04-07T23:15:47.000Z'
      };
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

  const queued = await workers.requestRegionSync(13, {
    triggerReason: 'manual',
    requestedBy: 'tester'
  });
  assert.ok(queued?.run?.id);

  children[0].stdout.emit('data', Buffer.from('SYNC_RESULT_JSON={"activeFeatureCount":5}\n'));
  children[0].emit('close', 0, null);
  await waitForMicrotasks();

  const savedRun = await dataSettingsService.getRunById(queued.run.id);
  assert.equal(savedRun?.summary?.sourceDataUpdatedAt, '2026-04-07T23:15:47.000Z');
});

test('initAutoSync requeues recovered interrupted runs without waiting for upstream refresh', async () => {
  const children = [];
  let upstreamChecks = 0;
  const dataSettingsService = createManagedDataSettingsService([
    {
      id: 14,
      enabled: true,
      autoSyncEnabled: false,
      autoSyncOnStart: false,
      nextSyncAt: null,
      lastSyncStatus: 'abandoned',
      lastSyncError: 'Sync interrupted by process restart'
    }
  ], {
    recoverInterruptedRuns: async () => [{ id: 91, regionId: 14, status: 'abandoned' }],
    getRegionUpstreamState: async () => {
      upstreamChecks += 1;
      throw new Error('recovery should bypass upstream refresh');
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

  await workers.initAutoSync();

  assert.equal(upstreamChecks, 0);
  assert.equal(children.length, 1);
  const region = await dataSettingsService.getRegionById(14);
  assert.equal(region?.lastSyncStatus, 'running');
});

test('managed sync workers parse SYNC_STAGE_JSON markers and persist stage updates', async () => {
  const stageCalls = [];
  const children = [];
  const dataSettingsService = createManagedDataSettingsService([
    {
      id: 21,
      enabled: true,
      autoSyncEnabled: false,
      autoSyncOnStart: false,
      nextSyncAt: null,
      lastSyncStatus: 'idle'
    }
  ]);
  const baseUpdateRunStage = dataSettingsService.updateRunStage;
  dataSettingsService.updateRunStage = async (runId, stage, progress, detail) => {
    stageCalls.push({ runId, stage, progress, detail });
    return baseUpdateRunStage(runId, stage, progress, detail);
  };

  const workers = initSyncWorkersInfra({
    spawn: (_execPath, _args, spawnOptions = {}) => {
      const child = createChildProcessStub();
      child.spawnOptions = spawnOptions;
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

  const queued = await workers.requestRegionSync(21, { triggerReason: 'manual', requestedBy: 'tester' });
  assert.ok(queued?.run?.id);

  // Ensure the child is spawned with the stage-emission env flag
  assert.equal(children[0].spawnOptions?.env?.REGION_SYNC_EMIT_STAGE_JSON, 'true');

  // First stage: extract (no progress). Second stage: build with progress. Third: done (terminal, forced).
  children[0].stdout.emit('data', Buffer.from('SYNC_STAGE_JSON={"stage":"extract","detail":"downloading"}\n'));
  // Same stage again within the throttle window — must be ignored
  children[0].stdout.emit('data', Buffer.from('SYNC_STAGE_JSON={"stage":"extract","detail":"downloading"}\n'));
  children[0].stdout.emit('data', Buffer.from('SYNC_STAGE_JSON={"stage":"build","progress":42,"detail":"shard 1/3"}\n'));
  children[0].stdout.emit('data', Buffer.from('SYNC_RESULT_JSON={"activeFeatureCount":10,"importedFeatureCount":10,"orphanDeletedCount":0,"pmtilesBytes":100,"bounds":{"west":1,"south":1,"east":2,"north":2}}\n'));
  children[0].emit('close', 0, null);
  await waitForMicrotasks();
  // Let pending stage promises settle
  await waitForMicrotasks();

  const stagesSeen = stageCalls.map((entry) => entry.stage);
  assert.ok(stagesSeen.includes('extract'), `expected extract stage, got ${stagesSeen.join(',')}`);
  assert.ok(stagesSeen.includes('build'), `expected build stage, got ${stagesSeen.join(',')}`);
  // Duplicate extract entry within throttle window must have been suppressed
  assert.equal(stagesSeen.filter((value) => value === 'extract').length, 1);
  const buildEntry = stageCalls.find((entry) => entry.stage === 'build');
  assert.equal(buildEntry?.progress, 42);
  assert.equal(buildEntry?.detail, 'shard 1/3');
});

test('managed sync workers cancel a running sync and finalize it as abandoned', async () => {
  const cancelMarks = [];
  const children = [];
  const killedPids = [];
  const dataSettingsService = createManagedDataSettingsService([
    {
      id: 31,
      enabled: true,
      autoSyncEnabled: false,
      autoSyncOnStart: false,
      nextSyncAt: null,
      lastSyncStatus: 'idle'
    }
  ]);
  const baseMarkCancel = dataSettingsService.markRunCancelRequested;
  dataSettingsService.markRunCancelRequested = async (runId) => {
    cancelMarks.push(runId);
    return baseMarkCancel(runId);
  };

  const workers = initSyncWorkersInfra({
    spawn: () => {
      const child = createChildProcessStub();
      child.pid = 12345;
      const originalKill = child.kill.bind(child);
      child.kill = (signal = 'SIGTERM') => {
        killedPids.push({ pid: child.pid, signal });
        originalKill(signal);
      };
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

  const queued = await workers.requestRegionSync(31, { triggerReason: 'manual', requestedBy: 'tester' });
  assert.equal(children.length, 1);

  const result = await workers.requestRegionSyncCancel(31);
  assert.equal(result.cancelled, true);
  assert.equal(result.target, 'running');
  assert.deepEqual(cancelMarks, [queued.run.id]);

  // On non-Windows platforms the worker uses child.kill('SIGTERM').
  // On Windows it delegates to taskkill without calling child.kill — so
  // killedPids may be empty. The test must tolerate both.
  if (process.platform !== 'win32') {
    assert.ok(killedPids.length >= 1);
  }

  // The child then emits close (which createChildProcessStub already did
  // synchronously via child.kill on non-Windows). For Windows, emit manually:
  if (process.platform === 'win32') {
    children[0].emit('close', null, 'SIGTERM');
  }
  await waitForMicrotasks();
  await waitForMicrotasks();

  const finalRun = await dataSettingsService.getRunById(queued.run.id);
  assert.equal(finalRun?.status, 'abandoned');
});

test('signalProcessTree targets the detached POSIX process group', () => {
  const killCalls = [];
  const child = createChildProcessStub();
  child.pid = 4242;
  child.kill = () => {
    throw new Error('child.kill fallback should not be used when group signalling succeeds');
  };

  const result = _test_.signalProcessTree(child, 'SIGTERM', { error() {} }, {
    platform: 'linux',
    killRef: (pid, signal) => {
      killCalls.push({ pid, signal });
    }
  });

  assert.equal(result, true);
  assert.deepEqual(killCalls, [{ pid: -4242, signal: 'SIGTERM' }]);
});

test('managed sync workers cancel a queued sync by removing it from the queue', async () => {
  const children = [];
  const dataSettingsService = createManagedDataSettingsService([
    {
      id: 41,
      enabled: true,
      autoSyncEnabled: false,
      autoSyncOnStart: false,
      nextSyncAt: null,
      lastSyncStatus: 'idle'
    },
    {
      id: 42,
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
    onSyncSuccess: async () => {},
    log: { log() {}, error() {} }
  });

  const firstQueued = await workers.requestRegionSync(41, { triggerReason: 'manual', requestedBy: 'tester' });
  const secondQueued = await workers.requestRegionSync(42, { triggerReason: 'manual', requestedBy: 'tester' });
  assert.equal(children.length, 1); // only first drained

  const result = await workers.requestRegionSyncCancel(42);
  assert.equal(result.cancelled, true);
  assert.equal(result.target, 'queued');

  const cancelledRun = await dataSettingsService.getRunById(secondQueued.run.id);
  assert.equal(cancelledRun?.status, 'abandoned');

  // Finish the first to avoid dangling child
  children[0].stdout.emit('data', Buffer.from('SYNC_RESULT_JSON={"activeFeatureCount":1}\n'));
  children[0].emit('close', 0, null);
  await waitForMicrotasks();
  // First one must still be success, not touched by cancel
  const firstRun = await dataSettingsService.getRunById(firstQueued.run.id);
  assert.equal(firstRun?.status, 'success');
});

test('requestRegionSyncCancel returns no-op when region has no active sync', async () => {
  const dataSettingsService = createManagedDataSettingsService([
    {
      id: 51,
      enabled: true,
      autoSyncEnabled: false,
      autoSyncOnStart: false,
      nextSyncAt: null,
      lastSyncStatus: 'idle'
    }
  ]);

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

  const result = await workers.requestRegionSyncCancel(51);
  assert.equal(result.cancelled, false);
  assert.equal(result.target, 'none');
});
