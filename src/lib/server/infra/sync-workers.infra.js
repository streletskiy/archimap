const fs = require('fs');

const MAX_NODE_TIMER_MS = 2_147_483_647;

function initSyncWorkersInfra(options = {}) {
  const {
    spawn,
    processExecPath,
    syncScriptPath,
    cwd,
    env,
    autoSyncEnabled,
    autoSyncOnStart,
    autoSyncIntervalHours,
    buildingsPmtilesPath,
    isShuttingDown,
    getContoursTotal,
    onSyncSuccess,
    log = console
  } = options;

  let syncInProgress = false;
  let scheduledSkipLogged = false;
  let currentSyncChild = null;
  let currentPmtilesBuildChild = null;
  let nextSyncTimer = null;

  function runCitySync(reason = 'interval') {
    if (syncInProgress) {
      if (reason !== 'scheduled' || !scheduledSkipLogged) {
        log.log(`[auto-sync] skipped (${reason}): previous sync still running`);
        if (reason === 'scheduled') scheduledSkipLogged = true;
      }
      return;
    }

    scheduledSkipLogged = false;
    syncInProgress = true;
    log.log(`[auto-sync] started (${reason})`);

    const child = spawn(processExecPath, [syncScriptPath], {
      cwd,
      env,
      stdio: 'inherit'
    });
    currentSyncChild = child;

    child.on('error', (error) => {
      syncInProgress = false;
      scheduledSkipLogged = false;
      currentSyncChild = null;
      log.error(`[auto-sync] failed to start: ${String(error.message || error)}`);
    });

    child.on('close', (code, signal) => {
      syncInProgress = false;
      scheduledSkipLogged = false;
      currentSyncChild = null;
      if (isShuttingDown() && (signal === 'SIGTERM' || signal === 'SIGINT')) {
        log.log('[auto-sync] stopped due to shutdown');
        return;
      }
      if (code === 0) {
        log.log('[auto-sync] finished successfully');
        if (typeof onSyncSuccess === 'function') onSyncSuccess();
      } else {
        log.error(`[auto-sync] failed with code ${code}`);
      }
    });
  }

  function runPmtilesBuild(reason = 'startup-missing') {
    if (currentPmtilesBuildChild) {
      log.log(`[pmtiles] skipped (${reason}): generation already running`);
      return;
    }
    if (syncInProgress) {
      log.log(`[pmtiles] skipped (${reason}): full sync is running`);
      return;
    }

    log.log(`[pmtiles] generation started (${reason})`);
    const child = spawn(processExecPath, [syncScriptPath, '--pmtiles-only'], {
      cwd,
      env,
      stdio: 'inherit'
    });
    currentPmtilesBuildChild = child;

    child.on('error', (error) => {
      currentPmtilesBuildChild = null;
      log.error(`[pmtiles] failed to start: ${String(error.message || error)}`);
    });

    child.on('close', (code, signal) => {
      currentPmtilesBuildChild = null;
      if (isShuttingDown() && (signal === 'SIGTERM' || signal === 'SIGINT')) {
        log.log('[pmtiles] generation stopped due to shutdown');
        return;
      }
      if (code === 0) {
        log.log('[pmtiles] generation finished successfully');
      } else {
        log.error(`[pmtiles] generation failed with code ${code}`);
        log.error('[pmtiles] Hint: run "docker compose run --rm archimap node scripts/sync-osm-buildings.js --pmtiles-only" to build tiles in Docker.');
      }
    });
  }

  function shouldRunStartupSync() {
    const hasPmtiles = fs.existsSync(buildingsPmtilesPath);
    const hasContours = getContoursTotal() > 0;
    if (hasContours && hasPmtiles) {
      log.log('[auto-sync] startup skipped: contours and PMTiles already exist');
      return false;
    }
    return true;
  }

  function maybeGeneratePmtilesOnStartup() {
    if (autoSyncEnabled && autoSyncOnStart) return;

    const hasPmtiles = fs.existsSync(buildingsPmtilesPath);
    if (hasPmtiles) return;

    if (getContoursTotal() <= 0) {
      log.log('[pmtiles] startup generation skipped: building_contours is empty');
      return;
    }

    runPmtilesBuild('startup-missing');
  }

  function initAutoSync() {
    const contoursTotal = getContoursTotal();
    const needsBootstrapSync = contoursTotal <= 0;

    if (needsBootstrapSync) {
      if (!autoSyncEnabled) {
        log.log('[auto-sync] bootstrap run: building_contours is empty (AUTO_SYNC_ENABLED ignored for first sync)');
      } else if (!autoSyncOnStart) {
        log.log('[auto-sync] bootstrap run: building_contours is empty (AUTO_SYNC_ON_START ignored for first sync)');
      }
      runCitySync('bootstrap-first-run');
    }

    if (!autoSyncEnabled) {
      log.log('[auto-sync] disabled by AUTO_SYNC_ENABLED=false');
      if (!needsBootstrapSync) {
        maybeGeneratePmtilesOnStartup();
      }
      return;
    }

    if (!needsBootstrapSync && autoSyncOnStart) {
      if (shouldRunStartupSync()) {
        runCitySync('startup');
      }
    } else if (!needsBootstrapSync) {
      maybeGeneratePmtilesOnStartup();
    }

    if (Number.isFinite(autoSyncIntervalHours) && autoSyncIntervalHours > 0) {
      const intervalMs = Math.max(60_000, Math.round(autoSyncIntervalHours * 60 * 60 * 1000));
      const scheduleNext = (targetTs) => {
        const now = Date.now();
        const remaining = Math.max(0, targetTs - now);
        const delay = Math.min(remaining, MAX_NODE_TIMER_MS);

        nextSyncTimer = setTimeout(() => {
          if (Date.now() >= targetTs) {
            runCitySync('scheduled');
            scheduleNext(Date.now() + intervalMs);
            return;
          }
          scheduleNext(targetTs);
        }, delay);

        if (typeof nextSyncTimer.unref === 'function') {
          nextSyncTimer.unref();
        }
      };

      scheduleNext(Date.now() + intervalMs);
      log.log(`[auto-sync] scheduled every ${autoSyncIntervalHours}h`);
    } else {
      log.log('[auto-sync] periodic updates disabled (AUTO_SYNC_INTERVAL_HOURS <= 0)');
    }
  }

  function stop() {
    if (currentSyncChild && !currentSyncChild.killed) {
      try {
        currentSyncChild.kill('SIGTERM');
      } catch {
        // ignore
      }
    }
    if (currentPmtilesBuildChild && !currentPmtilesBuildChild.killed) {
      try {
        currentPmtilesBuildChild.kill('SIGTERM');
      } catch {
        // ignore
      }
    }
    if (nextSyncTimer) {
      clearTimeout(nextSyncTimer);
      nextSyncTimer = null;
    }
  }

  return {
    initAutoSync,
    runCitySync,
    runPmtilesBuild,
    stop,
    isSyncInProgress: () => syncInProgress
  };
}

module.exports = {
  initSyncWorkersInfra
};
