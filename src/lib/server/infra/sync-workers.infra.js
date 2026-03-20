const MAX_NODE_TIMER_MS = 2_147_483_647;

function initManagedSyncWorkers(options = {}) {
  const {
    spawn,
    processExecPath,
    syncRegionScriptPath,
    cwd,
    env,
    dataSettingsService,
    isShuttingDown,
    onSyncSuccess,
    log = console
  } = options;

  const queue = [];
  const queuedRegionIds = new Set();
  const enqueueLocksByRegionId = new Map();
  const regionTimers = new Map();
  let currentRun = null;
  let currentSyncChild = null;
  let deferredSyncSuccessPayload = null;
  let initialized = false;
  let draining = false;

  function clearRegionTimers() {
    for (const timer of regionTimers.values()) {
      clearTimeout(timer);
    }
    regionTimers.clear();
  }

  function scheduleTimer(region) {
    if (!region?.enabled || !region?.autoSyncEnabled || !region?.nextSyncAt) {
      return;
    }
    const targetTs = Date.parse(String(region.nextSyncAt || ''));
    if (!Number.isFinite(targetTs)) {
      return;
    }
    if (queuedRegionIds.has(region.id) || currentRun?.regionId === region.id) {
      return;
    }
    if (targetTs <= Date.now()) {
      requestRegionSync(region.id, {
        triggerReason: 'scheduled',
        requestedBy: 'system'
      }).catch((error) => {
        log.error(`[region-sync] failed to enqueue scheduled sync for region ${region.id}: ${String(error?.message || error)}`);
      });
      return;
    }

    const remaining = Math.max(0, targetTs - Date.now());
    const delay = Math.min(remaining, MAX_NODE_TIMER_MS);
    const timer = setTimeout(() => {
      regionTimers.delete(region.id);
      if (Date.now() >= targetTs) {
        requestRegionSync(region.id, {
          triggerReason: 'scheduled',
          requestedBy: 'system'
        }).catch((error) => {
          log.error(`[region-sync] failed to enqueue scheduled sync for region ${region.id}: ${String(error?.message || error)}`);
        });
        return;
      }
      scheduleTimer(region);
    }, delay);
    if (typeof timer.unref === 'function') {
      timer.unref();
    }
    regionTimers.set(region.id, timer);
  }

  async function reloadSchedules() {
    clearRegionTimers();
    const regions = await dataSettingsService.refreshAllNextSyncAt();
    for (const region of regions) {
      scheduleTimer(region);
    }
  }

  function buildFailureMessage({ code, signal, outputTail, error }) {
    if (error) {
      return String(error?.message || error);
    }
    if (outputTail) {
      return outputTail.slice(-4000);
    }
    if (signal) {
      return `Sync stopped by signal ${signal}`;
    }
    return `Sync failed with exit code ${code}`;
  }

  async function flushDeferredSyncSuccess() {
    if (typeof onSyncSuccess !== 'function') {
      deferredSyncSuccessPayload = null;
      return;
    }
    if (currentSyncChild || queue.length > 0 || !deferredSyncSuccessPayload) {
      return;
    }

    const payload = deferredSyncSuccessPayload;
    deferredSyncSuccessPayload = null;
    await Promise.resolve(onSyncSuccess(payload));
  }

  async function finalizeRun(runId, result) {
    try {
      if (result.success) {
        const saved = await dataSettingsService.markRunSucceeded(runId, result.summary || {});
        const successPayload = {
          region: saved.region,
          run: saved.run,
          summary: result.summary || {}
        };
        if (typeof onSyncSuccess === 'function') {
          if (queue.length > 0) {
            deferredSyncSuccessPayload = successPayload;
          } else {
            deferredSyncSuccessPayload = null;
            await Promise.resolve(onSyncSuccess(successPayload));
          }
        }
      } else {
        await dataSettingsService.markRunFailed(runId, result.error || 'Sync failed', {
          status: result.status || 'failed'
        });
      }
    } finally {
      await reloadSchedules();
      try {
        await flushDeferredSyncSuccess();
      } finally {
        void drainQueue();
      }
    }
  }

  function startChildForRun(run, region) {
    let stdoutBuffer = '';
    let stderrBuffer = '';
    let outputTail = '';
    let parsedSummary = null;

    const child = spawn(processExecPath, [syncRegionScriptPath, `--region-id=${region.id}`], {
      cwd,
      env: {
        ...env,
        REGION_SYNC_SKIP_RUNTIME_FOLLOWUP: 'true'
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    currentSyncChild = child;

    function appendOutput(chunkText, isError = false) {
      const text = String(chunkText || '');
      outputTail = `${outputTail}${text}`.slice(-8000);
      const lines = text.split(/\r?\n/);
      for (const line of lines) {
        const trimmed = String(line || '').trim();
        if (!trimmed) continue;
        if (trimmed.startsWith('SYNC_RESULT_JSON=')) {
          try {
            parsedSummary = JSON.parse(trimmed.slice('SYNC_RESULT_JSON='.length));
          } catch {
            // ignore malformed summary line
          }
          continue;
        }
        if (isError) {
          log.error(`[region-sync:${region.id}] ${trimmed}`);
        } else {
          log.log(`[region-sync:${region.id}] ${trimmed}`);
        }
      }
    }

    child.stdout.on('data', (chunk) => {
      stdoutBuffer += chunk.toString();
      appendOutput(chunk, false);
    });
    child.stderr.on('data', (chunk) => {
      stderrBuffer += chunk.toString();
      appendOutput(chunk, true);
    });

    child.on('error', (error) => {
      currentSyncChild = null;
      currentRun = null;
      finalizeRun(run.id, {
        success: false,
        error: buildFailureMessage({
          outputTail: `${stdoutBuffer}\n${stderrBuffer}`,
          error
        })
      }).catch(() => {});
    });

    child.on('close', (code, signal) => {
      currentSyncChild = null;
      currentRun = null;
      if (isShuttingDown() && (signal === 'SIGTERM' || signal === 'SIGINT')) {
        finalizeRun(run.id, {
          success: false,
          status: 'abandoned',
          error: 'Sync interrupted by shutdown'
        }).catch(() => {});
        return;
      }
      if (code === 0 && parsedSummary) {
        finalizeRun(run.id, {
          success: true,
          summary: parsedSummary
        }).catch(() => {});
        return;
      }
      finalizeRun(run.id, {
        success: false,
        error: buildFailureMessage({
          code,
          signal,
          outputTail: `${stdoutBuffer}\n${stderrBuffer}`
        })
      }).catch(() => {});
    });
  }

  async function drainQueue() {
    if (draining || currentSyncChild || queue.length === 0) {
      return;
    }
    draining = true;
    try {
      if (currentSyncChild || queue.length === 0) return;
      const next = queue.shift();
      queuedRegionIds.delete(next.regionId);
      currentRun = next;
      const run = await dataSettingsService.markRunStarted(next.runId);
      const region = await dataSettingsService.getRegionById(next.regionId);
      if (!region) {
        await finalizeRun(run.id, {
          success: false,
          error: 'Region not found before sync start'
        });
        return;
      }
      startChildForRun(run, region);
    } finally {
      draining = false;
    }
  }

  async function requestRegionSync(regionId, options = {}) {
    const numericRegionId = Number(regionId);
    const previousLock = enqueueLocksByRegionId.get(numericRegionId) || Promise.resolve();
    let releaseLock;
    const lockWait = new Promise((resolve) => {
      releaseLock = resolve;
    });
    const lockRef = previousLock.then(() => lockWait);
    enqueueLocksByRegionId.set(numericRegionId, lockRef);

    await previousLock;
    try {
      const region = await dataSettingsService.getRegionById(numericRegionId);
      if (!region) {
        throw new Error('Region not found');
      }
      if (!region.enabled) {
        throw new Error('Sync is only available for enabled regions');
      }

      if (currentRun?.regionId === numericRegionId) {
        return {
          queued: false,
          run: await dataSettingsService.getRunById(currentRun.runId),
          region: await dataSettingsService.getRegionById(numericRegionId)
        };
      }
      if (queuedRegionIds.has(numericRegionId)) {
        const runs = await dataSettingsService.getRecentRuns(numericRegionId, 5);
        const queuedRun = runs.find((item) => item.status === 'queued');
        return {
          queued: true,
          run: queuedRun || null,
          region: await dataSettingsService.getRegionById(numericRegionId)
        };
      }

      const recentRuns = await dataSettingsService.getRecentRuns(numericRegionId, 10);
      const activeRun = recentRuns.find((item) => item.status === 'queued' || item.status === 'running');
      if (activeRun) {
        return {
          queued: activeRun.status === 'queued',
          run: activeRun,
          region: await dataSettingsService.getRegionById(numericRegionId)
        };
      }

      const run = await dataSettingsService.createQueuedRun(
        numericRegionId,
        options.triggerReason || 'manual',
        options.requestedBy || null
      );
      queue.push({
        runId: run.id,
        regionId: numericRegionId
      });
      queuedRegionIds.add(numericRegionId);
      await reloadSchedules();
      await drainQueue();
      return {
        queued: true,
        run: await dataSettingsService.getRunById(run.id),
        region: await dataSettingsService.getRegionById(numericRegionId)
      };
    } finally {
      releaseLock();
      if (enqueueLocksByRegionId.get(numericRegionId) === lockRef) {
        enqueueLocksByRegionId.delete(numericRegionId);
      }
    }
  }

  async function initAutoSync() {
    if (initialized) return;
    initialized = true;

    await dataSettingsService.bootstrapFromEnvIfNeeded('startup');
    const recoveredRuns = await dataSettingsService.recoverInterruptedRuns();
    const recoveredRegionIds = new Set(
      (Array.isArray(recoveredRuns) ? recoveredRuns : [])
        .map((run) => Number(run?.regionId || 0))
        .filter((regionId) => Number.isInteger(regionId) && regionId > 0)
    );
    const regions = await dataSettingsService.listRegions({ includeDisabled: false });

    for (const regionId of recoveredRegionIds) {
      await requestRegionSync(regionId, {
        triggerReason: 'startup',
        requestedBy: 'system'
      });
    }

    for (const region of regions) {
      if (!region.enabled) continue;
      const dueNow = Boolean(region.autoSyncEnabled && region.nextSyncAt && Date.parse(String(region.nextSyncAt || '')) <= Date.now());
      const shouldRunOnStart = Boolean(region.autoSyncOnStart);
      if (!dueNow && !shouldRunOnStart) continue;
      await requestRegionSync(region.id, {
        triggerReason: shouldRunOnStart ? 'startup' : 'scheduled',
        requestedBy: 'system'
      });
    }
    await reloadSchedules();
  }

  function stop() {
    clearRegionTimers();
    queue.length = 0;
    queuedRegionIds.clear();
    if (currentSyncChild && !currentSyncChild.killed) {
      try {
        currentSyncChild.kill('SIGTERM');
      } catch {
        // ignore
      }
    }
  }

  return {
    initAutoSync,
    requestRegionSync,
    reloadSchedules,
    stop,
    isSyncInProgress: () => Boolean(currentSyncChild)
  };
}

function initSyncWorkersInfra(options = {}) {
  const {
    dataSettingsService,
    syncRegionScriptPath
  } = options;

  if (!dataSettingsService || !syncRegionScriptPath) {
    return {
      initAutoSync: async () => {},
      requestRegionSync: async () => {
        throw new Error('DB-backed region sync is not configured in the current runtime mode');
      },
      reloadSchedules: async () => {},
      stop() {},
      isSyncInProgress: () => false
    };
  }

  const managedWorkers = initManagedSyncWorkers(options);
  let resolvedMode = null;

  async function resolveMode(force = false) {
    if (force) {
      resolvedMode = null;
    }
    if (resolvedMode) return resolvedMode;
    try {
      await dataSettingsService.bootstrapFromEnvIfNeeded('startup');
      const regions = await dataSettingsService.listRegions();
      resolvedMode = regions.length > 0 ? 'managed' : 'none';
    } catch {
      resolvedMode = 'none';
    }
    return resolvedMode;
  }

  return {
    async initAutoSync() {
      const mode = await resolveMode(true);
      if (mode === 'managed') {
        return managedWorkers.initAutoSync();
      }
    },
    async requestRegionSync(regionId, options = {}) {
      let mode = await resolveMode();
      if (mode !== 'managed') {
        mode = await resolveMode(true);
      }
      if (mode !== 'managed') {
        throw new Error('DB-backed region sync is not configured in the current runtime mode');
      }
      return managedWorkers.requestRegionSync(regionId, options);
    },
    async reloadSchedules() {
      const mode = await resolveMode(true);
      if (mode === 'managed') {
        return managedWorkers.reloadSchedules();
      }
    },
    stop() {
      managedWorkers.stop();
    },
    isSyncInProgress() {
      return managedWorkers.isSyncInProgress();
    }
  };
}

module.exports = {
  initSyncWorkersInfra
};
