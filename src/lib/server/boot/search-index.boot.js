const {
  BUILDING_SEARCH_FTS_DELETE_SQL,
  BUILDING_SEARCH_FTS_INSERT_SQL,
  BUILDING_SEARCH_SOURCE_DELETE_SQL,
  BUILDING_SEARCH_SOURCE_UPSERT_SQL,
  buildRawSearchSourceQuery,
  normalizeSearchSourceRow
} = require('../services/search-index-source.service');

function createSearchIndexBoot(options = {}) {
  const {
    db,
    dbProvider,
    logger,
    spawn,
    processExecPath,
    rootDir,
    searchRebuildScriptPath,
    batchSize,
    env = process.env,
    sqlite = {},
    isShuttingDown = () => false
  } = options;

  let currentSearchRebuildChild = null;
  let searchIndexRebuildInProgress = false;
  let queuedSearchIndexRebuildReason = null;
  const pendingSearchIndexRefreshes = new Set();

  const selectSearchCounts = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM osm.building_contours) AS contours_count,
      (SELECT COUNT(*) FROM building_search_source) AS search_source_count,
      (SELECT COUNT(*) FROM building_search_fts) AS search_fts_count
  `);
  const selectRawSearchSourceByBuilding = db.prepare(buildRawSearchSourceQuery({
    where: 'WHERE bc.osm_type = ? AND bc.osm_id = ?'
  }));
  const upsertSearchSource = db.prepare(BUILDING_SEARCH_SOURCE_UPSERT_SQL);
  const deleteSearchSource = db.prepare(BUILDING_SEARCH_SOURCE_DELETE_SQL);
  const deleteSearchFts = db.prepare(BUILDING_SEARCH_FTS_DELETE_SQL);
  const insertSearchFts = db.prepare(BUILDING_SEARCH_FTS_INSERT_SQL);

  async function getSearchIndexCountsSnapshot() {
    return selectSearchCounts.get();
  }

  async function getSearchRebuildDecision() {
    const countsSnapshot = await getSearchIndexCountsSnapshot();
    const expectedSourceRows = Number(countsSnapshot?.contours_count || 0);
    const actualSourceRows = Number(countsSnapshot?.search_source_count || 0);
    const actualFtsRows = Number(countsSnapshot?.search_fts_count || 0);

    const sourceMismatch = actualSourceRows !== expectedSourceRows;
    const ftsMismatch = actualFtsRows !== actualSourceRows;

    if (sourceMismatch || ftsMismatch) {
      const reasons = [];
      if (sourceMismatch) reasons.push(`source ${actualSourceRows}/${expectedSourceRows}`);
      if (ftsMismatch) reasons.push(`fts ${actualFtsRows}/${actualSourceRows}`);
      return {
        shouldRebuild: true,
        reason: reasons.join(', ')
      };
    }

    return {
      shouldRebuild: false,
      reason: 'search index row counts are consistent'
    };
  }

  async function applySearchSourceRow(sourceRow) {
    await upsertSearchSource.run(sourceRow);
    await deleteSearchFts.run(sourceRow.osm_key);
    await insertSearchFts.run(
      sourceRow.osm_key,
      sourceRow.name || '',
      sourceRow.address || '',
      sourceRow.style || '',
      sourceRow.architect || ''
    );
  }

  async function refreshSearchIndexForBuilding(osmType, osmId, options = {}) {
    const force = Boolean(options.force);
    if (!force && searchIndexRebuildInProgress) {
      pendingSearchIndexRefreshes.add(`${osmType}/${osmId}`);
      return;
    }

    const rawRow = await selectRawSearchSourceByBuilding.get(osmType, osmId);
    const sourceRow = normalizeSearchSourceRow(rawRow);
    const osmKey = `${osmType}/${osmId}`;

    if (!sourceRow) {
      await deleteSearchSource.run(osmKey);
      await deleteSearchFts.run(osmKey);
      return;
    }

    await applySearchSourceRow(sourceRow);
  }

  async function flushDeferredSearchRefreshes() {
    if (pendingSearchIndexRefreshes.size === 0) return;
    const pending = Array.from(pendingSearchIndexRefreshes);
    pendingSearchIndexRefreshes.clear();
    logger.info('search_deferred_refreshes_applied', { pending: pending.length });
    for (const key of pending) {
      const [osmType, osmIdRaw] = String(key).split('/');
      const osmId = Number(osmIdRaw);
      if (['way', 'relation'].includes(osmType) && Number.isInteger(osmId)) {
        await refreshSearchIndexForBuilding(osmType, osmId, { force: true });
      }
    }
  }

  function maybeRunQueuedSearchRebuild() {
    if (!queuedSearchIndexRebuildReason) return;
    const nextReason = queuedSearchIndexRebuildReason;
    queuedSearchIndexRebuildReason = null;
    rebuildSearchIndex(nextReason).catch((error) => {
      logger.error('search_rebuild_run_failed', { reason: nextReason, error: String(error?.message || error) });
    });
  }

  function enqueueSearchIndexRefresh(osmType, osmId) {
    setImmediate(async () => {
      try {
        await refreshSearchIndexForBuilding(osmType, osmId);
      } catch (error) {
        logger.error('search_incremental_refresh_failed', { osmType, osmId, error: String(error.message || error) });
      }
    });
  }

  async function rebuildSearchIndex(reason = 'manual', options = {}) {
    const force = Boolean(options.force);
    if (searchIndexRebuildInProgress) {
      queuedSearchIndexRebuildReason = reason;
      logger.info('search_rebuild_queued', { reason });
      return;
    }

    if (!force) {
      const decision = await getSearchRebuildDecision();
      if (!decision.shouldRebuild) {
        logger.info('search_rebuild_skipped', { reason, details: decision.reason });
        return;
      }
      logger.info('search_rebuild_required', { reason, details: decision.reason });
    }

    const startedAt = Date.now();
    searchIndexRebuildInProgress = true;
    logger.info('search_rebuild_started', { reason, batchSize: batchSize });

    const child = spawn(processExecPath, [searchRebuildScriptPath], {
      cwd: rootDir,
      env: {
        ...env,
        DB_PROVIDER: dbProvider,
        SEARCH_REBUILD_REASON: reason,
        SEARCH_INDEX_BATCH_SIZE: String(batchSize),
        ...(dbProvider === 'sqlite'
          ? {
            ARCHIMAP_DB_PATH: sqlite.dbPath,
            OSM_DB_PATH: sqlite.osmDbPath,
            LOCAL_EDITS_DB_PATH: sqlite.localEditsDbPath
          }
          : {})
      },
      stdio: 'inherit'
    });
    currentSearchRebuildChild = child;

    child.on('error', (error) => {
      currentSearchRebuildChild = null;
      searchIndexRebuildInProgress = false;
      logger.error('search_rebuild_start_failed', { reason, error: String(error.message || error) });
      flushDeferredSearchRefreshes().catch(() => {});
      maybeRunQueuedSearchRebuild();
    });

    child.on('close', (code, signal) => {
      currentSearchRebuildChild = null;
      searchIndexRebuildInProgress = false;

      if (isShuttingDown() && (signal === 'SIGTERM' || signal === 'SIGINT')) {
        logger.info('search_rebuild_stopped', { reason: 'shutdown' });
        return;
      }
      if (code === 0) {
        logger.info('search_rebuild_finished', { reason, durationMs: Date.now() - startedAt });
      } else {
        logger.error('search_rebuild_failed', { reason, code });
      }

      flushDeferredSearchRefreshes().catch(() => {});
      maybeRunQueuedSearchRebuild();
    });
  }

  function stop() {
    if (currentSearchRebuildChild && !currentSearchRebuildChild.killed) {
      try {
        currentSearchRebuildChild.kill('SIGTERM');
      } catch {
        // ignore shutdown cleanup errors
      }
    }
  }

  return {
    rebuildSearchIndex,
    refreshSearchIndexForBuilding,
    enqueueSearchIndexRefresh,
    stop,
    isSearchIndexRebuildInProgress: () => searchIndexRebuildInProgress
  };
}

module.exports = {
  createSearchIndexBoot
};
