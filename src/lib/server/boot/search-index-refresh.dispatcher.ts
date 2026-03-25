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
    refreshSearchIndexForBuildingFallback
  } = options;

  const canSpawnWorker = Boolean(
    spawn
    && processExecPath
    && rootDir
    && searchRefreshWorkerScriptPath
  );
  let currentWorker = null;
  let currentWorkerReady = false;
  let isStopping = false;

  function clearWorkerState() {
    currentWorker = null;
    currentWorkerReady = false;
  }

  function logWorkerFailure(eventName, details) {
    if (isShuttingDown() || isStopping) return;
    logger.error(eventName, details);
  }

  function handleWorkerExit(code, signal) {
    if (!currentWorker) return;
    logWorkerFailure('search_refresh_worker_stopped', {
      code,
      signal
    });
    clearWorkerState();
  }

  function handleWorkerError(error) {
    if (!currentWorker) return;
    logWorkerFailure('search_refresh_worker_error', {
      error: String(error?.message || error)
    });
    clearWorkerState();
  }

  function spawnWorker() {
    if (!canSpawnWorker) {
      return null;
    }
    if (currentWorker) {
      return currentWorker;
    }

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

    const onMessage = (message) => {
      const type = String(message?.type || '').trim();
      if (type === 'ready') {
        currentWorkerReady = true;
        return;
      }
    };

    child.on('message', onMessage);
    child.once('error', handleWorkerError);
    child.once('exit', handleWorkerExit);

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
    if (currentWorker && !currentWorker.killed) {
      try {
        currentWorker.kill('SIGTERM');
      } catch {
        // ignore shutdown cleanup errors
      }
    }
    clearWorkerState();
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
