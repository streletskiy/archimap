const { advanceBuildingDataRevision } = require('../infra/building-data-revision.infra');

function createSearchIndexRefreshDispatcher(options: LooseRecord = {}) {
  const {
    db,
    logger = console,
    spawn,
    processExecPath,
    rootDir,
    searchRefreshWorkerScriptPath,
    env = process.env,
    sqlite = {},
    isShuttingDown = () => false,
    refreshSearchIndexForBuildingFallback,
    setTimeoutFn = setTimeout,
    clearTimeoutFn = clearTimeout
  } = options;

  const canSpawnWorker = Boolean(spawn && processExecPath && rootDir && searchRefreshWorkerScriptPath);
  let currentWorker = null;
  let currentWorkerReady = false;
  let isStopping = false;
  let restartTimer = null;
  let restartAttempt = 0;
  let readyAt = 0;

  function scheduleRestart() {
    if (String(db?.provider || env.DB_PROVIDER) !== 'postgres' || !canSpawnWorker ||
      isStopping || isShuttingDown() || restartTimer || currentWorker) return;
    if (readyAt && Date.now() - readyAt > 30000) restartAttempt = 0;
    const delay = Math.min(60000, 1000 * (2 ** Math.min(restartAttempt++, 6)));
    restartTimer = setTimeoutFn(() => {
      restartTimer = null;
      if (isStopping || isShuttingDown() || currentWorker) return;
      try { spawnWorker(); } catch (error) {
        logWorkerFailure('search_refresh_worker_restart_failed', { error: String(error?.message || error) });
        scheduleRestart();
      }
    }, delay);
    restartTimer?.unref?.();
  }

  function clearWorkerState() {
    currentWorker = null;
    currentWorkerReady = false;
  }

  function logWorkerFailure(eventName, details) {
    if (isShuttingDown() || isStopping) return;
    logger.error(eventName, details);
  }

  function handleWorkerExit(child, code, signal) {
    if (currentWorker !== child) return;
    logWorkerFailure('search_refresh_worker_stopped', {
      code,
      signal
    });
    clearWorkerState();
    scheduleRestart();
  }

  function handleWorkerError(child, error) {
    if (currentWorker !== child) return;
    logWorkerFailure('search_refresh_worker_error', {
      error: String(error?.message || error)
    });
    try { if (!child.killed) child.kill('SIGTERM'); } catch { /* process may already be gone */ }
    clearWorkerState();
    scheduleRestart();
  }

  function spawnWorker() {
    if (isStopping || isShuttingDown()) return null;
    if (!canSpawnWorker) {
      return null;
    }
    if (currentWorker) {
      return currentWorker;
    }
    if (restartTimer) clearTimeoutFn(restartTimer);
    restartTimer = null;

    let child;
    try {
      child = spawn(processExecPath, ['--import', 'tsx', searchRefreshWorkerScriptPath], {
        cwd: rootDir,
        env: {
          ...env,
          DB_PROVIDER: String(db?.provider || env.DB_PROVIDER || 'sqlite').trim() || 'sqlite',
          ...(db?.provider === 'sqlite'
            ? {
                ARCHIMAP_DB_PATH: sqlite.dbPath,
                OSM_DB_PATH: sqlite.osmDbPath,
                LOCAL_EDITS_DB_PATH: sqlite.localEditsDbPath
              }
            : {})
        },
        stdio: ['ignore', 'inherit', 'inherit', 'ipc']
      });
    } catch (error) {
      clearWorkerState();
      throw error;
    }

    currentWorker = child;
    currentWorkerReady = false;
    readyAt = 0;

    const onMessage = (message) => {
      if (currentWorker !== child || isStopping || isShuttingDown()) return;
      const type = message?.type;
      if (type === 'ready') {
        currentWorkerReady = true;
        readyAt = Date.now();
        return;
      }
      if ((type === 'drained' || type === 'refreshed') &&
        Number.isSafeInteger(message.processed) && message.processed > 0) {
        // The worker reports only committed writes. Requests cached before the
        // projection changed must use a new revision in this parent process.
        advanceBuildingDataRevision();
      }
    };

    child.on('message', onMessage);
    child.once('error', (error) => handleWorkerError(child, error));
    child.once('exit', (code, signal) => handleWorkerExit(child, code, signal));

    return child;
  }

  async function dispatchRefreshTask(osmType, osmId) {
    if (!canSpawnWorker) {
      if (typeof refreshSearchIndexForBuildingFallback === 'function') {
        try {
          void Promise.resolve(refreshSearchIndexForBuildingFallback(osmType, osmId)).catch((error) => {
            logger.error('search_refresh_worker_fallback_failed', {
              osmType,
              osmId,
              error: String(error?.message || error)
            });
          });
        } catch (error) {
          logger.error('search_refresh_worker_fallback_failed', {
            osmType,
            osmId,
            error: String(error?.message || error)
          });
        }
      }
      return null;
    }

    try {
      const worker = spawnWorker();
      if (!worker || !currentWorker) {
        throw new Error('Search refresh worker is not available');
      }

      const sent = worker.send({
        type: 'refresh',
        osmType,
        osmId
      });
      if (sent === false) {
        logger.error('search_refresh_worker_send_buffered', {
          osmType,
          osmId
        });
      }
    } catch (error) {
      if (currentWorker) handleWorkerError(currentWorker, error);
      else scheduleRestart();
      if (typeof refreshSearchIndexForBuildingFallback === 'function') {
        logger.error('search_refresh_worker_fallback', {
          osmType,
          osmId,
          error: String(error?.message || error)
        });
        try {
          void Promise.resolve(refreshSearchIndexForBuildingFallback(osmType, osmId)).catch((fallbackError) => {
            logger.error('search_refresh_worker_fallback_failed', {
              osmType,
              osmId,
              error: String(fallbackError?.message || fallbackError)
            });
          });
        } catch (fallbackError) {
          logger.error('search_refresh_worker_fallback_failed', {
            osmType,
            osmId,
            error: String(fallbackError?.message || fallbackError)
          });
        }
        return null;
      }
      logger.error('search_refresh_worker_dispatch_failed', {
        osmType,
        osmId,
        error: String(error?.message || error)
      });
      return null;
    }
    return null;
  }

  function stop() {
    isStopping = true;
    if (restartTimer) clearTimeoutFn(restartTimer);
    restartTimer = null;
    if (currentWorker && !currentWorker.killed) {
      try {
        currentWorker.kill('SIGTERM');
      } catch {
        // ignore shutdown cleanup errors
      }
    }
    clearWorkerState();
  }

  // Regional imports enqueue PostgreSQL changes without sending edit IPC. Start
  // their durable consumer even when nobody has edited a building.
  if (String(db?.provider || env.DB_PROVIDER) === 'postgres' && canSpawnWorker && !isShuttingDown()) {
    try { spawnWorker(); } catch (error) {
      logWorkerFailure('search_refresh_worker_start_failed', { error: String(error?.message || error) });
      scheduleRestart();
    }
  }

  return {
    dispatchRefreshTask,
    stop,
    isWorkerEnabled: () => canSpawnWorker,
    isWorkerRunning: () => Boolean(currentWorker && currentWorkerReady)
  };
}

module.exports = {
  createSearchIndexRefreshDispatcher
};
