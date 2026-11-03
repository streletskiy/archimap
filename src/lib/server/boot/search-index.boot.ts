const { createSearchIndexRefreshDispatcher } = require('./search-index-refresh.dispatcher');
const { createSearchIndexRefreshService } = require('../services/search-index-refresh.service');

function createSearchIndexBoot(options: LooseRecord = {}) {
  const {
    db,
    dbProvider,
    logger,
    spawn,
    processExecPath,
    rootDir,
    searchRebuildScriptPath,
    searchRefreshWorkerScriptPath,
    batchSize,
    env = process.env,
    sqlite = {},
    isShuttingDown = () => false
  } = options;

  let currentSearchRebuildChild = null;
  let searchIndexRebuildInProgress = false;
  let queuedSearchIndexRebuild: LooseRecord = null;
  let activeSearchRebuildPromise: Promise<void> = null;
  let searchIndexStopping = false;
  const pendingSearchIndexRefreshes = new Set();
  const queuedSearchIndexRefreshes = new Map();
  let searchIndexRefreshQueueScheduled = false;
  let searchIndexRefreshQueueRunning = false;
  const isPostgres =
    String(dbProvider || db?.provider || '')
      .trim()
      .toLowerCase() === 'postgres';
  const searchIndexRefreshService = createSearchIndexRefreshService({
    db,
    logger
  });
  const searchIndexRefreshDispatcher = createSearchIndexRefreshDispatcher({
    db,
    logger,
    spawn,
    processExecPath,
    rootDir,
    searchRefreshWorkerScriptPath,
    env,
    sqlite,
    isShuttingDown,
    refreshSearchIndexForBuildingFallback: searchIndexRefreshService.refreshSearchIndexForBuilding
  });

  const selectSearchCounts = db.prepare(
    isPostgres
      ? `
      SELECT
        (EXISTS (SELECT 1 FROM public.building_search_source))::integer AS search_source_count,
        EXISTS (SELECT 1 FROM osm.building_contours bc WHERE
          jsonb_exists(public.archimap_parse_tags(bc.tags_json), 'building')
          OR NOT (jsonb_exists_any(public.archimap_parse_tags(bc.tags_json), ARRAY['building:part', 'building_part']))
          LIMIT 1) AS searchable_rows_expected,
        EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public' AND c.relkind = 'i' AND c.relname = 'idx_building_search_source_tsv') AS search_tsv_index_present,
        (SELECT projection_version FROM public.search_index_state WHERE id = 1) AS projection_version,
        EXISTS (SELECT 1 FROM public.building_data_changes) AS has_search_changes
    `
      : `
      SELECT
        (SELECT COUNT(*) FROM building_search_source) AS search_source_count,
        (SELECT COUNT(*) FROM building_search_fts) AS search_fts_count,
        EXISTS (
          SELECT 1 FROM osm.building_contours bc
          LEFT JOIN local.architectural_info ai ON ai.osm_type=bc.osm_type AND ai.osm_id=bc.osm_id
          WHERE (json_type(CASE WHEN json_valid(bc.tags_json) THEN bc.tags_json ELSE '{}' END, '$.building') IS NOT NULL
            OR (json_type(CASE WHEN json_valid(bc.tags_json) THEN bc.tags_json ELSE '{}' END, '$."building:part"') IS NULL
              AND json_type(CASE WHEN json_valid(bc.tags_json) THEN bc.tags_json ELSE '{}' END, '$.building_part') IS NULL))
          AND (EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(bc.tags_json) THEN bc.tags_json ELSE '{}' END))
            OR NULLIF(trim(ai.name), '') IS NOT NULL OR NULLIF(trim(ai.address), '') IS NOT NULL
            OR NULLIF(trim(ai.style), '') IS NOT NULL OR NULLIF(trim(ai.architect), '') IS NOT NULL
            OR NULLIF(trim(ai.design_ref), '') IS NOT NULL OR NULLIF(trim(ai.material), '') IS NOT NULL
            OR NULLIF(trim(ai.archimap_description), '') IS NOT NULL)
          LIMIT 1
        ) AS searchable_rows_expected
    `
  );
  async function getSearchIndexCountsSnapshot() {
    return selectSearchCounts.get();
  }

  async function getSearchRebuildDecision() {
    const countsSnapshot = await getSearchIndexCountsSnapshot();
    const actualSourceRows = Number(countsSnapshot?.search_source_count || 0);
    const searchableRowsExpected = Boolean(countsSnapshot?.searchable_rows_expected);
    const missingOrStaleSource = searchableRowsExpected ? actualSourceRows === 0 : actualSourceRows > 0;

    if (isPostgres) {
      const searchTsvIndexPresent = Boolean(countsSnapshot?.search_tsv_index_present);
      const reasons = [];
      if (Number(countsSnapshot?.projection_version || 0) !== 2) reasons.push('search projection version changed');
      if (missingOrStaleSource)
        reasons.push(`source ${actualSourceRows}/${searchableRowsExpected ? '>0 expected' : '0 expected'}`);
      if (actualSourceRows > 0 && !searchTsvIndexPresent) reasons.push('missing idx_building_search_source_tsv');
      if (reasons.length > 0) {
        return {
          shouldRebuild: true,
          reason: reasons.join(', '),
          mode: 'full'
        };
      }
      return {
        shouldRebuild: Boolean(countsSnapshot?.has_search_changes),
        mode: 'incremental',
        reason: 'search projection is current; consume durable changes'
      };
    }

    const actualFtsRows = Number(countsSnapshot?.search_fts_count || 0);
    const ftsMismatch = actualFtsRows !== actualSourceRows;

    if (missingOrStaleSource || ftsMismatch) {
      const reasons = [];
      if (missingOrStaleSource)
        reasons.push(`source ${actualSourceRows}/${searchableRowsExpected ? '>0 expected' : '0 expected'}`);
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

  function normalizeSearchRefreshTarget(osmType, osmId) {
    const normalizedType = String(osmType || '').trim();
    const normalizedId = Number(osmId);
    if (!['way', 'relation'].includes(normalizedType) || !Number.isInteger(normalizedId) || normalizedId <= 0) {
      return null;
    }
    return {
      osmType: normalizedType,
      osmId: normalizedId
    };
  }

  async function refreshSearchIndexForBuilding(osmType, osmId) {
    const target = normalizeSearchRefreshTarget(osmType, osmId);
    if (!target) return;
    if (searchIndexRebuildInProgress) {
      pendingSearchIndexRefreshes.add(`${target.osmType}/${target.osmId}`);
      return;
    }
    return searchIndexRefreshDispatcher.dispatchRefreshTask(target.osmType, target.osmId);
  }

  function scheduleQueuedSearchIndexRefreshes() {
    if (searchIndexRefreshQueueScheduled || searchIndexRefreshQueueRunning) return;
    searchIndexRefreshQueueScheduled = true;
    setImmediate(() => {
      searchIndexRefreshQueueScheduled = false;
      void flushQueuedSearchIndexRefreshes();
    });
  }

  async function flushQueuedSearchIndexRefreshes() {
    if (searchIndexRefreshQueueRunning) return;
    searchIndexRefreshQueueRunning = true;
    try {
      while (queuedSearchIndexRefreshes.size > 0) {
        const batch = Array.from(queuedSearchIndexRefreshes.values());
        queuedSearchIndexRefreshes.clear();
        for (const item of batch) {
          try {
            await refreshSearchIndexForBuilding(item.osmType, item.osmId);
          } catch (error) {
            logger.error('search_incremental_refresh_failed', {
              osmType: item.osmType,
              osmId: item.osmId,
              error: String(error?.message || error)
            });
          }
        }
      }
    } finally {
      searchIndexRefreshQueueRunning = false;
      if (queuedSearchIndexRefreshes.size > 0) {
        scheduleQueuedSearchIndexRefreshes();
      }
    }
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
        await refreshSearchIndexForBuilding(osmType, osmId);
      }
    }
  }

  function enqueueSearchIndexRefresh(osmType, osmId) {
    const target = normalizeSearchRefreshTarget(osmType, osmId);
    if (!target) return;

    const key = `${target.osmType}/${target.osmId}`;
    queuedSearchIndexRefreshes.set(key, target);
    scheduleQueuedSearchIndexRefreshes();
  }

  async function runSearchRebuild(reason, force, onStarted) {
    let mode = 'full';
    if (!force) {
      const decision = await getSearchRebuildDecision();
      if (!decision.shouldRebuild) {
        logger.info('search_rebuild_skipped', { reason, details: decision.reason });
        onStarted();
        return;
      }
      mode = decision.mode || 'full';
      logger.info('search_rebuild_required', { reason, details: decision.reason });
    }
    if (searchIndexStopping || isShuttingDown()) { onStarted(); return; }
    const startedAt = Date.now();
    logger.info('search_rebuild_started', { reason, batchSize });
    const child = spawn(processExecPath, ['--import', 'tsx', searchRebuildScriptPath], {
      cwd: rootDir,
      env: { ...env, DB_PROVIDER: dbProvider, SEARCH_REBUILD_REASON: reason,
        SEARCH_REBUILD_MODE: mode, SEARCH_INDEX_BATCH_SIZE: String(batchSize),
        ...(dbProvider === 'sqlite' ? { ARCHIMAP_DB_PATH: sqlite.dbPath,
          OSM_DB_PATH: sqlite.osmDbPath, LOCAL_EDITS_DB_PATH: sqlite.localEditsDbPath } : {}) },
      stdio: 'inherit'
    });
    currentSearchRebuildChild = child;
    try {
      await new Promise<void>((resolve, reject) => {
        child.once('error', reject);
        child.once('close', (code, signal) => {
          if (code === 0 || ((searchIndexStopping || isShuttingDown()) && ['SIGTERM', 'SIGINT'].includes(signal))) resolve();
          else reject(new Error(`Search refresh exited with ${code}`));
        });
        onStarted();
      });
      logger.info('search_rebuild_finished', { reason, durationMs: Date.now() - startedAt });
    } finally {
      if (currentSearchRebuildChild === child) currentSearchRebuildChild = null;
    }
  }

  function rebuildSearchIndex(reason = 'manual', options: LooseRecord = {}) {
    if (searchIndexStopping || isShuttingDown()) return Promise.resolve();
    if (activeSearchRebuildPromise) {
      queuedSearchIndexRebuild = { reason, force: Boolean(options.force || queuedSearchIndexRebuild?.force) };
      logger.info('search_rebuild_queued', { reason });
      return options.waitForCompletion ? activeSearchRebuildPromise : Promise.resolve();
    }
    // Reserve before the first asynchronous count/decision so concurrent callers
    // cannot launch two workers or mistake a deciding task for an idle one.
    searchIndexRebuildInProgress = true;
    let resolveStarted;
    let rejectStarted;
    const started = new Promise<void>((resolve, reject) => { resolveStarted = resolve; rejectStarted = reject; });
    started.catch(() => {});
    activeSearchRebuildPromise = Promise.resolve().then(async () => {
      let request: LooseRecord = { reason, force: Boolean(options.force) };
      let firstError = null;
      try {
        while (request && !searchIndexStopping && !isShuttingDown()) {
          try {
            await runSearchRebuild(request.reason, request.force, resolveStarted);
          } catch (error) {
            rejectStarted(error);
            firstError ||= error;
            logger.error('search_rebuild_failed', { reason: request.reason, error: String(error?.message || error) });
          }
          request = queuedSearchIndexRebuild;
          queuedSearchIndexRebuild = null;
        }
        resolveStarted();
        if (firstError) throw firstError;
      } finally {
        searchIndexRebuildInProgress = false;
        activeSearchRebuildPromise = null;
        if (!searchIndexStopping && !isShuttingDown()) await flushDeferredSearchRefreshes();
      }
    });
    activeSearchRebuildPromise.catch(() => {});
    return options.waitForCompletion ? activeSearchRebuildPromise : started;
  }

  function stop() {
    searchIndexStopping = true;
    queuedSearchIndexRebuild = null;
    if (currentSearchRebuildChild && !currentSearchRebuildChild.killed) {
      try {
        currentSearchRebuildChild.kill('SIGTERM');
      } catch {
        // ignore shutdown cleanup errors
      }
    }
    searchIndexRefreshDispatcher.stop();
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
