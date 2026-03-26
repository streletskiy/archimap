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
  let queuedSearchIndexRebuildReason = null;
  const pendingSearchIndexRefreshes = new Set();
  const queuedSearchIndexRefreshes = new Map();
  let searchIndexRefreshQueueScheduled = false;
  let searchIndexRefreshQueueRunning = false;
  const isPostgres = String(dbProvider || db?.provider || '').trim().toLowerCase() === 'postgres';
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

  const selectSearchCounts = db.prepare(isPostgres
    ? `
      SELECT
        (SELECT COUNT(*) FROM building_search_source) AS search_source_count,
        EXISTS (
          SELECT 1
          FROM osm.building_contours bc
          LEFT JOIN local.architectural_info ai
            ON ai.osm_type = bc.osm_type
           AND ai.osm_id = bc.osm_id
          CROSS JOIN LATERAL (
            SELECT
              CASE
                WHEN bc.tags_json ~ '^\\s*\\{' THEN bc.tags_json::jsonb
                ELSE '{}'::jsonb
              END AS tags_jsonb
          ) tags
          WHERE bc.osm_type IN ('way', 'relation')
            AND bc.osm_id > 0
            AND (
              NULLIF(btrim(ai.name), '') IS NOT NULL
              OR NULLIF(btrim(ai.address), '') IS NOT NULL
              OR NULLIF(btrim(ai.style), '') IS NOT NULL
              OR NULLIF(btrim(ai.architect), '') IS NOT NULL
              OR NULLIF(btrim(ai.design_ref), '') IS NOT NULL
              OR NULLIF(btrim(tags.tags_jsonb ->> 'name'), '') IS NOT NULL
              OR NULLIF(btrim(tags.tags_jsonb ->> 'name:ru'), '') IS NOT NULL
              OR NULLIF(btrim(tags.tags_jsonb ->> 'official_name'), '') IS NOT NULL
              OR NULLIF(btrim(tags.tags_jsonb ->> 'addr:full'), '') IS NOT NULL
              OR NULLIF(btrim(tags.tags_jsonb ->> 'addr:postcode'), '') IS NOT NULL
              OR NULLIF(btrim(tags.tags_jsonb ->> 'addr:city'), '') IS NOT NULL
              OR NULLIF(btrim(tags.tags_jsonb ->> 'addr:place'), '') IS NOT NULL
              OR NULLIF(btrim(tags.tags_jsonb ->> 'addr:street'), '') IS NOT NULL
              OR NULLIF(btrim(tags.tags_jsonb ->> 'addr:housenumber'), '') IS NOT NULL
              OR NULLIF(btrim(tags.tags_jsonb ->> 'building:architecture'), '') IS NOT NULL
              OR NULLIF(btrim(tags.tags_jsonb ->> 'architecture'), '') IS NOT NULL
              OR NULLIF(btrim(tags.tags_jsonb ->> 'style'), '') IS NOT NULL
              OR NULLIF(btrim(tags.tags_jsonb ->> 'architect'), '') IS NOT NULL
              OR NULLIF(btrim(tags.tags_jsonb ->> 'architect_name'), '') IS NOT NULL
              OR NULLIF(btrim(tags.tags_jsonb ->> 'design:ref'), '') IS NOT NULL
              OR NULLIF(btrim(tags.tags_jsonb ->> 'design_ref'), '') IS NOT NULL
            )
          LIMIT 1
        ) AS searchable_rows_expected,
        EXISTS (
          SELECT 1
          FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public'
            AND c.relkind = 'i'
            AND c.relname = 'idx_building_search_source_tsv'
        ) AS search_tsv_index_present
    `
    : `
      SELECT
        (SELECT COUNT(*) FROM building_search_source) AS search_source_count,
        (SELECT COUNT(*) FROM building_search_fts) AS search_fts_count
        ,
        EXISTS (
          SELECT 1
          FROM osm.building_contours bc
          LEFT JOIN local.architectural_info ai
            ON ai.osm_type = bc.osm_type
           AND ai.osm_id = bc.osm_id
          WHERE bc.osm_type IN ('way', 'relation')
            AND bc.osm_id > 0
            AND (
              NULLIF(trim(ai.name), '') IS NOT NULL
              OR NULLIF(trim(ai.address), '') IS NOT NULL
              OR NULLIF(trim(ai.style), '') IS NOT NULL
              OR NULLIF(trim(ai.architect), '') IS NOT NULL
              OR NULLIF(trim(ai.design_ref), '') IS NOT NULL
              OR NULLIF(trim(CASE WHEN json_valid(bc.tags_json) THEN json_extract(bc.tags_json, '$.name') END), '') IS NOT NULL
              OR NULLIF(trim(CASE WHEN json_valid(bc.tags_json) THEN json_extract(bc.tags_json, '$."name:ru"') END), '') IS NOT NULL
              OR NULLIF(trim(CASE WHEN json_valid(bc.tags_json) THEN json_extract(bc.tags_json, '$.official_name') END), '') IS NOT NULL
              OR NULLIF(trim(CASE WHEN json_valid(bc.tags_json) THEN json_extract(bc.tags_json, '$."addr:full"') END), '') IS NOT NULL
              OR NULLIF(trim(CASE WHEN json_valid(bc.tags_json) THEN json_extract(bc.tags_json, '$."addr:postcode"') END), '') IS NOT NULL
              OR NULLIF(trim(CASE WHEN json_valid(bc.tags_json) THEN json_extract(bc.tags_json, '$."addr:city"') END), '') IS NOT NULL
              OR NULLIF(trim(CASE WHEN json_valid(bc.tags_json) THEN json_extract(bc.tags_json, '$."addr:place"') END), '') IS NOT NULL
              OR NULLIF(trim(CASE WHEN json_valid(bc.tags_json) THEN json_extract(bc.tags_json, '$."addr:street"') END), '') IS NOT NULL
              OR NULLIF(trim(CASE WHEN json_valid(bc.tags_json) THEN json_extract(bc.tags_json, '$."addr:housenumber"') END), '') IS NOT NULL
              OR NULLIF(trim(CASE WHEN json_valid(bc.tags_json) THEN json_extract(bc.tags_json, '$."building:architecture"') END), '') IS NOT NULL
              OR NULLIF(trim(CASE WHEN json_valid(bc.tags_json) THEN json_extract(bc.tags_json, '$.architecture') END), '') IS NOT NULL
              OR NULLIF(trim(CASE WHEN json_valid(bc.tags_json) THEN json_extract(bc.tags_json, '$.style') END), '') IS NOT NULL
              OR NULLIF(trim(CASE WHEN json_valid(bc.tags_json) THEN json_extract(bc.tags_json, '$.architect') END), '') IS NOT NULL
              OR NULLIF(trim(CASE WHEN json_valid(bc.tags_json) THEN json_extract(bc.tags_json, '$.architect_name') END), '') IS NOT NULL
              OR NULLIF(trim(CASE WHEN json_valid(bc.tags_json) THEN json_extract(bc.tags_json, '$."design:ref"') END), '') IS NOT NULL
              OR NULLIF(trim(CASE WHEN json_valid(bc.tags_json) THEN json_extract(bc.tags_json, '$.design_ref') END), '') IS NOT NULL
            )
          LIMIT 1
        ) AS searchable_rows_expected
    `);
  async function getSearchIndexCountsSnapshot() {
    return selectSearchCounts.get();
  }

  async function getSearchRebuildDecision() {
    const countsSnapshot = await getSearchIndexCountsSnapshot();
    const actualSourceRows = Number(countsSnapshot?.search_source_count || 0);
    const searchableRowsExpected = Boolean(countsSnapshot?.searchable_rows_expected);
    const missingOrStaleSource = searchableRowsExpected
      ? actualSourceRows === 0
      : actualSourceRows > 0;

    if (isPostgres) {
      const searchTsvIndexPresent = Boolean(countsSnapshot?.search_tsv_index_present);
      const reasons = [];
      if (missingOrStaleSource) reasons.push(`source ${actualSourceRows}/${searchableRowsExpected ? '>0 expected' : '0 expected'}`);
      if (actualSourceRows > 0 && !searchTsvIndexPresent) reasons.push('missing idx_building_search_source_tsv');
      if (reasons.length > 0) {
        return {
          shouldRebuild: true,
          reason: reasons.join(', ')
        };
      }
      return {
        shouldRebuild: false,
        reason: 'search source rows and PostgreSQL tsv index are consistent'
      };
    }

    const actualFtsRows = Number(countsSnapshot?.search_fts_count || 0);
    const ftsMismatch = actualFtsRows !== actualSourceRows;

    if (missingOrStaleSource || ftsMismatch) {
      const reasons = [];
      if (missingOrStaleSource) reasons.push(`source ${actualSourceRows}/${searchableRowsExpected ? '>0 expected' : '0 expected'}`);
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

  function maybeRunQueuedSearchRebuild() {
    if (!queuedSearchIndexRebuildReason) return;
    const nextReason = queuedSearchIndexRebuildReason;
    queuedSearchIndexRebuildReason = null;
    rebuildSearchIndex(nextReason).catch((error) => {
      logger.error('search_rebuild_run_failed', { reason: nextReason, error: String(error?.message || error) });
    });
  }

  function enqueueSearchIndexRefresh(osmType, osmId) {
    const target = normalizeSearchRefreshTarget(osmType, osmId);
    if (!target) return;

    const key = `${target.osmType}/${target.osmId}`;
    queuedSearchIndexRefreshes.set(key, target);
    scheduleQueuedSearchIndexRefreshes();
  }

  async function rebuildSearchIndex(reason = 'manual', options: LooseRecord = {}) {
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

    const child = spawn(processExecPath, ['--import', 'tsx', searchRebuildScriptPath], {
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
