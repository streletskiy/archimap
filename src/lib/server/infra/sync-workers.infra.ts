const MAX_NODE_TIMER_MS = 2_147_483_647;
const STAGE_UPDATE_MIN_INTERVAL_MS = 250;
const CANCEL_FORCE_KILL_MS = 10_000;
const DEFAULT_RUN_HEARTBEAT_INTERVAL_MS = 5_000;
const DEFAULT_INTERRUPTED_RUN_STALE_MS = 30_000;
const DEFAULT_RECOVERY_SWEEP_INTERVAL_MS = 10_000;

function signalProcessTree(child, signal = 'SIGTERM', log = console, options: LooseRecord = {}) {
  const platform = String(options.platform || process.platform);
  const killRef = typeof options.killRef === 'function' ? options.killRef : process.kill.bind(process);

  if (!child || typeof child !== 'object' || child.killed) {
    return false;
  }
  if (platform === 'win32' && Number.isInteger(child.pid) && child.pid > 0) {
    try {
      const spawnRef = typeof options.spawnRef === 'function' ? options.spawnRef : require('child_process').spawn;
      const killer = spawnRef('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
        stdio: 'ignore',
        shell: false
      });
      killer.on('error', (error) => {
        log?.error?.(`[region-sync] taskkill failed: ${String(error?.message || error)}`);
      });
      return true;
    } catch (error) {
      log?.error?.(`[region-sync] taskkill spawn threw: ${String(error?.message || error)}`);
    }
  }
  if (Number.isInteger(child.pid) && child.pid > 0) {
    try {
      // The managed sync child is spawned detached on POSIX, making it the
      // leader of its own process group. Signalling `-pid` stops the whole
      // group, including `osm2pgsql`, `planetiler`, and any other sync subprocesses.
      killRef(-child.pid, signal);
      return true;
    } catch {
      // Fall back to the direct child kill below if process-group signalling
      // is unavailable for some reason.
    }
  }
  try {
    child.kill(signal);
    return true;
  } catch {
    // ignore
  }
  return false;
}

function initManagedSyncWorkers(options: LooseRecord = {}) {
  const {
    spawn,
    processExecPath,
    syncRegionScriptPath,
    cwd,
    env,
    dataSettingsService,
    isShuttingDown,
    onSyncSuccess,
    log = console,
    setIntervalRef = setInterval,
    clearIntervalRef = clearInterval,
    runHeartbeatIntervalMs = DEFAULT_RUN_HEARTBEAT_INTERVAL_MS,
    interruptedRunStaleMs = DEFAULT_INTERRUPTED_RUN_STALE_MS,
    recoverySweepIntervalMs = DEFAULT_RECOVERY_SWEEP_INTERVAL_MS
  } = options;

  const queue = [];
  const queuedRegionIds = new Set();
  const enqueueLocksByRegionId = new Map();
  const regionTimers = new Map();
  let currentRun = null;
  let currentSyncChild = null;
  let currentSyncCancelRequested = false;
  let currentSyncForceKillTimer = null;
  let deferredSyncSuccessPayload = null;
  let initialized = false;
  let draining = false;
  let reloadSchedulesPromise = null;
  let reloadSchedulesRequested = false;
  let runHeartbeatTimer = null;
  let recoverySweepTimer = null;
  let heartbeatInFlight = Promise.resolve();
  let recoveryInFlight = Promise.resolve();

  function clearRegionTimers() {
    for (const timer of regionTimers.values()) {
      clearTimeout(timer);
    }
    regionTimers.clear();
  }

  function clearRunMaintenanceTimers() {
    if (runHeartbeatTimer) {
      clearIntervalRef(runHeartbeatTimer);
      runHeartbeatTimer = null;
    }
    if (recoverySweepTimer) {
      clearIntervalRef(recoverySweepTimer);
      recoverySweepTimer = null;
    }
  }

  function getOwnedRunIds() {
    const runIds = new Set();
    if (Number.isInteger(Number(currentRun?.runId)) && Number(currentRun.runId) > 0) {
      runIds.add(Number(currentRun.runId));
    }
    for (const entry of queue) {
      const runId = Number(entry?.runId);
      if (Number.isInteger(runId) && runId > 0) {
        runIds.add(runId);
      }
    }
    return [...runIds];
  }

  function scheduleRunHeartbeatTick() {
    if (typeof dataSettingsService.touchRunHeartbeat !== 'function') {
      return;
    }
    const ownedRunIds = getOwnedRunIds();
    if (ownedRunIds.length === 0) {
      return;
    }
    heartbeatInFlight = heartbeatInFlight
      .then(async () => {
        for (const runId of ownedRunIds) {
          await dataSettingsService.touchRunHeartbeat(runId);
        }
      })
      .catch((error) => {
        log.error(`[region-sync] failed to persist run heartbeat: ${String(error?.message || error)}`);
      });
  }

  async function recoverInterruptedRunsAndRequeue(reason = 'Sync interrupted by process restart') {
    const numericStaleMs = Number(interruptedRunStaleMs);
    const staleMs = Number.isFinite(numericStaleMs)
      ? Math.max(0, Math.trunc(numericStaleMs))
      : DEFAULT_INTERRUPTED_RUN_STALE_MS;
    const recoveredRuns = await dataSettingsService.recoverInterruptedRuns(reason, { staleMs });
    const recoveredRegionIds = new Set(
      (Array.isArray(recoveredRuns) ? recoveredRuns : [])
        .map((run) => Number(run?.regionId || 0))
        .filter((regionId) => Number.isInteger(regionId) && regionId > 0)
    );

    for (const regionId of recoveredRegionIds) {
      await requestRegionSync(regionId, {
        triggerReason: 'startup',
        requestedBy: 'system',
        skipUpstreamCheck: true
      });
    }

    return recoveredRuns;
  }

  function scheduleRecoverySweepTick() {
    recoveryInFlight = recoveryInFlight
      .then(() => recoverInterruptedRunsAndRequeue())
      .catch((error) => {
        log.error(`[region-sync] failed to recover interrupted runs: ${String(error?.message || error)}`);
      });
  }

  function ensureRunMaintenanceTimers() {
    const numericHeartbeatMs = Number(runHeartbeatIntervalMs);
    const heartbeatMs = Number.isFinite(numericHeartbeatMs)
      ? Math.max(1_000, Math.trunc(numericHeartbeatMs))
      : DEFAULT_RUN_HEARTBEAT_INTERVAL_MS;
    const numericRecoveryMs = Number(recoverySweepIntervalMs);
    const recoveryMs = Number.isFinite(numericRecoveryMs)
      ? Math.max(1_000, Math.trunc(numericRecoveryMs))
      : DEFAULT_RECOVERY_SWEEP_INTERVAL_MS;

    if (!runHeartbeatTimer) {
      runHeartbeatTimer = setIntervalRef(() => {
        scheduleRunHeartbeatTick();
      }, heartbeatMs);
      if (typeof runHeartbeatTimer?.unref === 'function') {
        runHeartbeatTimer.unref();
      }
    }
    if (!recoverySweepTimer) {
      recoverySweepTimer = setIntervalRef(() => {
        scheduleRecoverySweepTick();
      }, recoveryMs);
      if (typeof recoverySweepTimer?.unref === 'function') {
        recoverySweepTimer.unref();
      }
    }
  }

  function scheduleTimer(region: LooseRecord) {
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
        log.error(
          `[region-sync] failed to enqueue scheduled sync for region ${region.id}: ${String(error?.message || error)}`
        );
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
          log.error(
            `[region-sync] failed to enqueue scheduled sync for region ${region.id}: ${String(error?.message || error)}`
          );
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

  async function refreshSchedulesOnce() {
    clearRegionTimers();
    const regions = await dataSettingsService.refreshAllNextSyncAt();
    for (const region of regions) {
      scheduleTimer(region);
    }
  }

  function reloadSchedules() {
    reloadSchedulesRequested = true;
    if (reloadSchedulesPromise) return reloadSchedulesPromise;

    reloadSchedulesPromise = (async () => {
      try {
        while (reloadSchedulesRequested) {
          reloadSchedulesRequested = false;
          await refreshSchedulesOnce();
        }
      } finally {
        reloadSchedulesPromise = null;
        reloadSchedulesRequested = false;
      }
    })();

    return reloadSchedulesPromise;
  }

  function reloadSchedulesInBackground(reason = 'manual') {
    void reloadSchedules().catch((error) => {
      log.error(
        `[region-sync] failed to reload schedules${reason ? ` after ${reason}` : ''}: ${String(error?.message || error)}`
      );
    });
  }

  function buildFailureMessage({ code, signal, outputTail, error }: LooseRecord) {
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

  function shouldSkipSyncBecauseUpToDate(region: LooseRecord = {}) {
    const lastSyncStatus = String(region?.lastSyncStatus || '')
      .trim()
      .toLowerCase();
    return Boolean(
      region?.lastSuccessfulSyncAt && lastSyncStatus !== 'failed' && region?.upstreamStatus === 'up_to_date'
    );
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

  async function finalizeRun(runId, result: LooseRecord) {
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

  function startChildForRun(run: LooseRecord, region: LooseRecord, queueEntry: LooseRecord = {}) {
    let stdoutBuffer = '';
    let stderrBuffer = '';
    let outputTail = '';
    let parsedSummary = null;
    let pendingStagePromise: Promise<unknown> = Promise.resolve();
    const sourceDataUpdatedAtPromise = (() => {
      if (queueEntry && typeof queueEntry.sourceDataUpdatedAtPromise?.then === 'function') {
        return queueEntry.sourceDataUpdatedAtPromise.catch(() => null);
      }
      return Promise.resolve(String(queueEntry?.sourceDataUpdatedAt || '').trim() || null);
    })();
    let lastStagePersistTs = 0;
    let lastStageSignature = '';

    const child = spawn(processExecPath, ['--import', 'tsx', syncRegionScriptPath, `--region-id=${region.id}`], {
      cwd,
      env: {
        ...env,
        REGION_SYNC_SKIP_RUNTIME_FOLLOWUP: 'true',
        REGION_SYNC_EMIT_STAGE_JSON: 'true',
        REGION_SYNC_PARENT_PID: String(process.pid)
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32'
    });
    currentSyncChild = child;
    currentSyncCancelRequested = false;

    function persistStage(stage, progress, detail, subregionInfo: LooseRecord | null = null, { force = false } = {}) {
      if (typeof dataSettingsService.updateRunStage !== 'function') {
        return;
      }
      const subregionSignature = subregionInfo
        ? `${subregionInfo.subregionIndex ?? ''}|${subregionInfo.subregionTotal ?? ''}|${subregionInfo.subregionId ?? ''}|${subregionInfo.subregionName ?? ''}`
        : '';
      const signature = `${stage}|${progress ?? ''}|${detail ?? ''}|${subregionSignature}`;
      if (!force && signature === lastStageSignature) {
        return;
      }
      const nowMs = Date.now();
      const isTerminalStage = stage === 'done' || stage === 'cancelling' || stage === 'cancelled';
      const previousStage = lastStageSignature ? String(lastStageSignature).split('|')[0] : '';
      const isStageTransition = previousStage !== stage;
      if (
        !force &&
        !isTerminalStage &&
        !isStageTransition &&
        nowMs - lastStagePersistTs < STAGE_UPDATE_MIN_INTERVAL_MS
      ) {
        return;
      }
      lastStagePersistTs = nowMs;
      lastStageSignature = signature;
      pendingStagePromise = pendingStagePromise
        .then(() => dataSettingsService.updateRunStage(run.id, stage, progress, detail, subregionInfo))
        .catch((error) => {
          log.error(`[region-sync:${region.id}] failed to persist stage: ${String(error?.message || error)}`);
        });
    }

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
        if (trimmed.startsWith('SYNC_STAGE_JSON=')) {
          try {
            const payload = JSON.parse(trimmed.slice('SYNC_STAGE_JSON='.length));
            const stageName = String(payload?.stage || '').trim();
            if (!stageName) continue;
            const progressValue = Number.isFinite(Number(payload?.progress)) ? Number(payload.progress) : null;
            const detailText = typeof payload?.detail === 'string' ? payload.detail : null;
            const subregionInfo =
              payload &&
              (payload.subregionIndex != null || payload.subregionTotal != null || payload.subregionId != null)
                ? {
                    subregionIndex: Number.isFinite(Number(payload.subregionIndex))
                      ? Number(payload.subregionIndex)
                      : null,
                    subregionTotal: Number.isFinite(Number(payload.subregionTotal))
                      ? Number(payload.subregionTotal)
                      : null,
                    subregionId: Number.isFinite(Number(payload.subregionId)) ? Number(payload.subregionId) : null,
                    subregionName:
                      typeof payload.subregionName === 'string' && payload.subregionName.trim()
                        ? payload.subregionName.trim()
                        : null
                  }
                : null;
            persistStage(stageName, progressValue, detailText, subregionInfo);
          } catch {
            // ignore malformed stage line
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

    function clearForceKillTimer() {
      if (currentSyncForceKillTimer) {
        clearTimeout(currentSyncForceKillTimer);
        currentSyncForceKillTimer = null;
      }
    }

    function waitForPendingStage() {
      return pendingStagePromise.catch(() => {});
    }

    function waitForSourceDataUpdatedAt() {
      return sourceDataUpdatedAtPromise.catch(() => null);
    }

    async function finalizeSuccess(summary = {}) {
      const sourceDataUpdatedAt = await waitForSourceDataUpdatedAt();
      await finalizeRun(run.id, {
        success: true,
        summary: {
          ...summary,
          sourceDataUpdatedAt: sourceDataUpdatedAt || null
        }
      });
    }

    child.on('error', (error) => {
      currentSyncChild = null;
      currentRun = null;
      const wasCancelled = currentSyncCancelRequested;
      currentSyncCancelRequested = false;
      clearForceKillTimer();
      const finalization = waitForPendingStage().then(() =>
        finalizeRun(run.id, {
          success: false,
          status: wasCancelled ? 'abandoned' : 'failed',
          error: wasCancelled
            ? 'Sync cancelled by user'
            : buildFailureMessage({
                outputTail: `${stdoutBuffer}\n${stderrBuffer}`,
                error
              })
        })
      );
      finalization.catch(() => {});
    });

    child.on('close', (code, signal) => {
      currentSyncChild = null;
      currentRun = null;
      const wasCancelled = currentSyncCancelRequested;
      currentSyncCancelRequested = false;
      clearForceKillTimer();
      const finalize = (payload) => waitForPendingStage().then(() => finalizeRun(run.id, payload));

      if (wasCancelled) {
        finalize({
          success: false,
          status: 'abandoned',
          error: 'Sync cancelled by user'
        }).catch(() => {});
        return;
      }
      if (isShuttingDown() && (signal === 'SIGTERM' || signal === 'SIGINT')) {
        finalize({
          success: false,
          status: 'abandoned',
          error: 'Sync interrupted by shutdown'
        }).catch(() => {});
        return;
      }
      if (code === 0 && parsedSummary) {
        waitForPendingStage()
          .then(() => finalizeSuccess(parsedSummary))
          .catch(() => {});
        return;
      }
      finalize({
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
      if (queue.length === 0) return;
      const next = queue.shift();
      queuedRegionIds.delete(next.regionId);
      currentRun = next;
      const run = await dataSettingsService.markRunStarted(next.runId);
      if (!run || run.status !== 'running') {
        currentRun = null;
        void drainQueue();
        return;
      }
      const region = await dataSettingsService.getRegionById(next.regionId);
      if (!region) {
        await finalizeRun(run.id, {
          success: false,
          error: 'Region not found before sync start'
        });
        return;
      }
      startChildForRun(run, region, next);
    } finally {
      draining = false;
    }
  }

  async function requestRegionSync(regionId, options: LooseRecord = {}) {
    ensureRunMaintenanceTimers();
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

      const skipUpstreamCheck = options.skipUpstreamCheck === true;
      const lastSyncStatus = String(region?.lastSyncStatus || '')
        .trim()
        .toLowerCase();
      const shouldProbeUpstreamBeforeQueue =
        !skipUpstreamCheck &&
        String(options.triggerReason || '')
          .trim()
          .toLowerCase() !== 'manual' &&
        Boolean(region?.lastSuccessfulSyncAt) &&
        lastSyncStatus !== 'failed' &&
        typeof dataSettingsService.getRegionUpstreamState === 'function';

      let sourceDataUpdatedAt = null;
      let sourceDataUpdatedAtPromise = null;
      if (shouldProbeUpstreamBeforeQueue) {
        let upstreamRegion;
        try {
          upstreamRegion =
            (await dataSettingsService.getRegionUpstreamState(region, {
              forceRefresh: true
            })) || region;
        } catch {
          upstreamRegion = region;
        }
        if (shouldSkipSyncBecauseUpToDate(upstreamRegion)) {
          if (options.triggerReason === 'manual') {
            throw new Error('No upstream update is available for this region');
          }
          if (typeof dataSettingsService.rescheduleRegionAfterSkippedSync === 'function') {
            await dataSettingsService.rescheduleRegionAfterSkippedSync(numericRegionId);
          }
          return {
            queued: false,
            skipped: true,
            run: null,
            region: await dataSettingsService.getRegionById(numericRegionId)
          };
        }
        sourceDataUpdatedAt = String(upstreamRegion?.latestSourceDataUpdatedAt || '').trim() || null;
      } else if (!skipUpstreamCheck && typeof dataSettingsService.getRegionUpstreamState === 'function') {
        sourceDataUpdatedAtPromise = Promise.resolve()
          .then(() =>
            dataSettingsService.getRegionUpstreamState(region, {
              forceRefresh: false
            })
          )
          .then((value) => String(value?.latestSourceDataUpdatedAt || '').trim() || null)
          .catch(() => null);
      }

      const run = await dataSettingsService.createQueuedRun(
        numericRegionId,
        options.triggerReason || 'manual',
        options.requestedBy || null
      );
      queue.push({
        runId: run.id,
        regionId: numericRegionId,
        sourceDataUpdatedAt,
        sourceDataUpdatedAtPromise
      });
      queuedRegionIds.add(numericRegionId);
      reloadSchedulesInBackground(`enqueue:${numericRegionId}`);
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
    ensureRunMaintenanceTimers();

    await dataSettingsService.bootstrapFromEnvIfNeeded('startup');
    await recoverInterruptedRunsAndRequeue();
    const regions = await dataSettingsService.listRegions({ includeDisabled: false });

    for (const region of regions) {
      if (!region.enabled) continue;
      const dueNow = Boolean(
        region.autoSyncEnabled && region.nextSyncAt && Date.parse(String(region.nextSyncAt || '')) <= Date.now()
      );
      const shouldRunOnStart = Boolean(region.autoSyncOnStart);
      if (!dueNow && !shouldRunOnStart) continue;
      await requestRegionSync(region.id, {
        triggerReason: shouldRunOnStart ? 'startup' : 'scheduled',
        requestedBy: 'system'
      });
    }
    await reloadSchedules();
  }

  async function requestRegionSyncCancel(regionId) {
    const numericRegionId = Number(regionId);
    if (!Number.isInteger(numericRegionId) || numericRegionId <= 0) {
      throw new Error('Invalid region id');
    }

    if (currentRun?.regionId === numericRegionId && currentSyncChild) {
      currentSyncCancelRequested = true;
      try {
        if (typeof dataSettingsService.markRunCancelRequested === 'function') {
          await dataSettingsService.markRunCancelRequested(currentRun.runId);
        }
      } catch (error) {
        log.error(`[region-sync] failed to mark cancel requested: ${String(error?.message || error)}`);
      }
      signalProcessTree(currentSyncChild, 'SIGTERM', log);
      if (currentSyncForceKillTimer) {
        clearTimeout(currentSyncForceKillTimer);
      }
      currentSyncForceKillTimer = setTimeout(() => {
        if (currentSyncChild && !currentSyncChild.killed) {
          signalProcessTree(currentSyncChild, 'SIGKILL', log);
        }
      }, CANCEL_FORCE_KILL_MS);
      if (typeof currentSyncForceKillTimer?.unref === 'function') {
        currentSyncForceKillTimer.unref();
      }
      return {
        cancelled: true,
        target: 'running',
        regionId: numericRegionId
      };
    }

    if (queuedRegionIds.has(numericRegionId)) {
      const removedIndex = queue.findIndex((entry) => entry.regionId === numericRegionId);
      let removedEntry = null;
      if (removedIndex >= 0) {
        removedEntry = queue[removedIndex];
        queue.splice(removedIndex, 1);
      }
      queuedRegionIds.delete(numericRegionId);
      if (removedEntry?.runId) {
        try {
          await dataSettingsService.markRunFailed(removedEntry.runId, 'Sync cancelled by user', {
            status: 'abandoned'
          });
        } catch (error) {
          log.error(`[region-sync] failed to mark queued run cancelled: ${String(error?.message || error)}`);
        }
      }
      reloadSchedulesInBackground(`cancel-queued:${numericRegionId}`);
      return {
        cancelled: true,
        target: 'queued',
        regionId: numericRegionId
      };
    }

    if (typeof dataSettingsService.abandonActiveRunsForRegion === 'function') {
      try {
        const abandoned = await dataSettingsService.abandonActiveRunsForRegion(
          numericRegionId,
          'Sync cancelled by user',
          {
            status: 'abandoned',
            staleMs: interruptedRunStaleMs,
            repairRegionState: true
          }
        );
        if (Array.isArray(abandoned?.runs) && abandoned.runs.length > 0) {
          reloadSchedulesInBackground(`cancel-stale:${numericRegionId}`);
          return {
            cancelled: true,
            target: 'stale',
            regionId: numericRegionId
          };
        }
        if (abandoned?.repairedRegionState) {
          reloadSchedulesInBackground(`cancel-repair:${numericRegionId}`);
          return {
            cancelled: true,
            target: 'stale',
            regionId: numericRegionId
          };
        }
      } catch (error) {
        log.error(
          `[region-sync] failed to abandon stale run for region ${numericRegionId}: ${String(error?.message || error)}`
        );
      }
    }

    return {
      cancelled: false,
      target: 'none',
      regionId: numericRegionId
    };
  }

  function stop() {
    clearRegionTimers();
    clearRunMaintenanceTimers();
    queue.length = 0;
    queuedRegionIds.clear();
    if (currentSyncChild && !currentSyncChild.killed) {
      signalProcessTree(currentSyncChild, 'SIGTERM', log);
    }
  }

  return {
    initAutoSync,
    requestRegionSync,
    requestRegionSyncCancel,
    reloadSchedules,
    stop,
    isSyncInProgress: () => Boolean(currentSyncChild)
  };
}

function initSyncWorkersInfra(options: LooseRecord = {}) {
  const { dataSettingsService, syncRegionScriptPath } = options;

  if (!dataSettingsService || !syncRegionScriptPath) {
    return {
      initAutoSync: async () => {},
      requestRegionSync: async () => {
        throw new Error('DB-backed region sync is not configured in the current runtime mode');
      },
      requestRegionSyncCancel: async () => {
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
    async requestRegionSyncCancel(regionId) {
      let mode = await resolveMode();
      if (mode !== 'managed') {
        mode = await resolveMode(true);
      }
      if (mode !== 'managed') {
        throw new Error('DB-backed region sync is not configured in the current runtime mode');
      }
      return managedWorkers.requestRegionSyncCancel(regionId);
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
  initSyncWorkersInfra,
  _test_: {
    signalProcessTree
  }
};
