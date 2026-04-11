const { RUN_SELECT_FIELDS } = require('./shared');

function createSyncRunsDomain(context: LooseRecord = {}) {
  const {
    db,
    ensureBootstrapped,
    rowToRun,
    getRegionById,
    listRegions,
    normalizeBounds,
    normalizeNullableText,
    toIsoOrNull,
    computeNextSyncAt,
    computeRegionDbBytes,
    now
  } = context;

  function buildRegionSyncEligibilityError(region) {
    if (!region) {
      return 'Region not found';
    }
    if (region.extractResolutionStatus === 'resolution_error') {
      return region.extractResolutionError || 'Failed to confirm canonical extract for the region';
    }
    if (region.extractResolutionStatus === 'resolution_required' || region.extractResolutionStatus === 'needs_resolution') {
      return region.extractResolutionError || 'Region requires manual canonical extract selection';
    }
    return 'Region is not ready for sync: canonical extract is not selected';
  }

  async function getRecentRuns(regionId = null, pageOrLimit = 1, limitMaybe = undefined) {
    await ensureBootstrapped();

    const hasPageArgument = limitMaybe !== undefined;
    const rawPage = hasPageArgument ? pageOrLimit : 1;
    const rawLimit = hasPageArgument ? limitMaybe : pageOrLimit;
    const safeLimit = Math.max(1, Math.min(200, Math.trunc(Number(rawLimit) || 25)));
    const numericRegionId = Number(regionId);
    const hasRegionId = Number.isInteger(numericRegionId) && numericRegionId > 0;
    const whereSql = hasRegionId ? 'WHERE region_id = ?' : '';
    const queryArgs = hasRegionId ? [numericRegionId] : [];

    const countRow = await db.prepare(`
      SELECT COUNT(*) AS total
      FROM data_region_sync_runs
      ${whereSql}
    `).get(...queryArgs);
    const total = Math.max(0, Number(countRow?.total || 0));
    const pageCount = total > 0 ? Math.ceil(total / safeLimit) : 0;
    const safePage = pageCount > 0
      ? Math.min(Math.max(1, Math.trunc(Number(rawPage) || 1)), pageCount)
      : 1;
    const offset = (safePage - 1) * safeLimit;

    const rows = hasRegionId
      ? await db.prepare(`
        SELECT ${RUN_SELECT_FIELDS}
        FROM data_region_sync_runs
        ${whereSql}
        ORDER BY id DESC
        LIMIT ?
        OFFSET ?
      `).all(...queryArgs, safeLimit, offset)
      : await db.prepare(`
        SELECT ${RUN_SELECT_FIELDS}
        FROM data_region_sync_runs
        ORDER BY id DESC
        LIMIT ?
        OFFSET ?
      `).all(safeLimit, offset);

    const items = rows.map(rowToRun).filter(Boolean);
    return Object.assign(items, {
      total,
      page: safePage,
      pageSize: safeLimit,
      pageCount
    });
  }

  async function getRunById(runId) {
    await ensureBootstrapped();
    const row = await db.prepare(`
      SELECT ${RUN_SELECT_FIELDS}
      FROM data_region_sync_runs
      WHERE id = ?
      LIMIT 1
    `).get(Number(runId)) || null;
    return rowToRun(row);
  }

  async function createQueuedRun(regionId, triggerReason = 'manual', requestedBy = null) {
    await ensureBootstrapped();
    const region = await getRegionById(regionId);
    if (!region) {
      throw new Error('Region not found');
    }
    if (!region.enabled) {
      throw new Error('Sync is only available for enabled regions');
    }
    if (!region.canSync) {
      throw new Error(buildRegionSyncEligibilityError(region));
    }

    const queuedAt = toIsoOrNull(now());
    await db.prepare(`
      INSERT INTO data_region_sync_runs (
        region_id,
        status,
        trigger_reason,
        requested_by,
        requested_at,
        created_at,
        updated_at
      )
      VALUES (?, 'queued', ?, ?, ?, datetime('now'), datetime('now'))
    `).run(
      region.id,
      String(triggerReason || 'manual'),
      normalizeNullableText(requestedBy, 160),
      queuedAt
    );

    const row = await db.prepare(`
      SELECT id
      FROM data_region_sync_runs
      WHERE region_id = ?
      ORDER BY id DESC
      LIMIT 1
    `).get(region.id);
    const run = await getRunById(row?.id);

    await db.prepare(`
      UPDATE data_sync_regions
      SET
        last_sync_status = 'queued',
        updated_at = datetime('now')
      WHERE id = ?
    `).run(region.id);

    return run;
  }

  async function markRunStarted(runId) {
    await ensureBootstrapped();
    const run = await getRunById(runId);
    if (!run) {
      throw new Error('Run not found');
    }
    const startedAt = toIsoOrNull(now());
    await db.prepare(`
      UPDATE data_region_sync_runs
      SET
        status = 'running',
        started_at = ?,
        stage = 'starting',
        stage_progress = NULL,
        stage_detail = NULL,
        stage_updated_at = ?,
        updated_at = datetime('now')
      WHERE id = ?
    `).run(startedAt, startedAt, run.id);
    await db.prepare(`
      UPDATE data_sync_regions
      SET
        last_sync_status = 'running',
        last_sync_started_at = ?,
        last_sync_error = NULL,
        updated_at = datetime('now')
      WHERE id = ?
    `).run(startedAt, run.regionId);
    return getRunById(run.id);
  }

  async function updateRunStage(runId, stage, progress = null, detail = null) {
    await ensureBootstrapped();
    const numericRunId = Number(runId);
    if (!Number.isInteger(numericRunId) || numericRunId <= 0) {
      return null;
    }
    const normalizedStage = normalizeNullableText(stage, 32) || null;
    if (!normalizedStage) return null;
    const numericProgress = Number(progress);
    const safeProgress = Number.isFinite(numericProgress)
      ? Math.max(0, Math.min(100, Math.round(numericProgress)))
      : null;
    const normalizedDetail = normalizeNullableText(detail, 200);
    const updatedAt = toIsoOrNull(now());
    await db.prepare(`
      UPDATE data_region_sync_runs
      SET
        stage = ?,
        stage_progress = ?,
        stage_detail = ?,
        stage_updated_at = ?,
        updated_at = datetime('now')
      WHERE id = ? AND status = 'running'
    `).run(normalizedStage, safeProgress, normalizedDetail, updatedAt, numericRunId);
    return getRunById(numericRunId);
  }

  async function markRunCancelRequested(runId) {
    await ensureBootstrapped();
    const run = await getRunById(runId);
    if (!run) return null;
    const updatedAt = toIsoOrNull(now());
    await db.prepare(`
      UPDATE data_region_sync_runs
      SET
        cancel_requested = TRUE,
        stage = 'cancelling',
        stage_updated_at = ?,
        updated_at = datetime('now')
      WHERE id = ?
    `).run(updatedAt, run.id);
    return getRunById(run.id);
  }

  async function markRunSucceeded(runId, summary: LooseRecord = {}) {
    await ensureBootstrapped();
    const run = await getRunById(runId);
    if (!run) {
      throw new Error('Run not found');
    }
    const region = await getRegionById(run.regionId);
    if (!region) {
      throw new Error('Region not found');
    }

    const finishedAt = toIsoOrNull(now());
    const bounds = normalizeBounds(summary.bounds || null);
    const importedFeatureCount = summary.importedFeatureCount == null ? null : Number(summary.importedFeatureCount);
    const activeFeatureCount = summary.activeFeatureCount == null ? null : Number(summary.activeFeatureCount);
    const orphanDeletedCount = summary.orphanDeletedCount == null ? null : Number(summary.orphanDeletedCount);
    const pmtilesBytes = summary.pmtilesBytes == null ? null : Number(summary.pmtilesBytes);
    const sourceDataUpdatedAt = toIsoOrNull(summary.sourceDataUpdatedAt);
    const { dbBytes, dbBytesApproximate } = await computeRegionDbBytes(region.id);
    const nextSyncAt = computeNextSyncAt({
      ...region,
      lastSuccessfulSyncAt: finishedAt
    }, finishedAt);
    await db.prepare(`
      UPDATE data_region_sync_runs
      SET
        status = 'success',
        finished_at = ?,
        error_text = NULL,
        imported_feature_count = ?,
        active_feature_count = ?,
        orphan_deleted_count = ?,
        pmtiles_bytes = ?,
        db_bytes = ?,
        db_bytes_approximate = ?,
        bounds_west = ?,
        bounds_south = ?,
        bounds_east = ?,
        bounds_north = ?,
        stage = 'done',
        stage_progress = 100,
        stage_detail = NULL,
        stage_updated_at = ?,
        cancel_requested = FALSE,
        updated_at = datetime('now')
      WHERE id = ?
    `).run(
      finishedAt,
      importedFeatureCount,
      activeFeatureCount,
      orphanDeletedCount,
      pmtilesBytes,
      dbBytes,
      dbBytesApproximate ? 1 : 0,
      bounds?.west ?? null,
      bounds?.south ?? null,
      bounds?.east ?? null,
      bounds?.north ?? null,
      finishedAt,
      run.id
    );

    await db.prepare(`
      UPDATE data_sync_regions
      SET
        last_sync_status = 'idle',
        last_sync_finished_at = ?,
        last_sync_error = NULL,
        last_successful_sync_at = ?,
        source_data_updated_at = ?,
        next_sync_at = ?,
        bounds_west = ?,
        bounds_south = ?,
        bounds_east = ?,
        bounds_north = ?,
        last_feature_count = ?,
        updated_at = datetime('now')
      WHERE id = ?
    `).run(
      finishedAt,
      finishedAt,
      sourceDataUpdatedAt || region.sourceDataUpdatedAt || null,
      nextSyncAt,
      bounds?.west ?? null,
      bounds?.south ?? null,
      bounds?.east ?? null,
      bounds?.north ?? null,
      activeFeatureCount ?? importedFeatureCount ?? null,
      region.id
    );

    return {
      run: await getRunById(run.id),
      region: await getRegionById(region.id)
    };
  }

  async function rescheduleRegionAfterSkippedSync(regionId, referenceDate = now()) {
    await ensureBootstrapped();
    const region = await getRegionById(regionId);
    if (!region) {
      throw new Error('Region not found');
    }

    const referenceIso = toIsoOrNull(referenceDate);
    const nextSyncAt = computeNextSyncAt({
      ...region,
      lastSuccessfulSyncAt: referenceIso || region.lastSuccessfulSyncAt
    }, referenceIso || referenceDate);

    await db.prepare(`
      UPDATE data_sync_regions
      SET
        next_sync_at = ?,
        updated_at = datetime('now')
      WHERE id = ?
    `).run(nextSyncAt, region.id);

    return getRegionById(region.id);
  }

  async function markRunFailed(runId, errorText, options: LooseRecord = {}) {
    await ensureBootstrapped();
    const run = await getRunById(runId);
    if (!run) {
      throw new Error('Run not found');
    }
    const region = await getRegionById(run.regionId);
    if (!region) {
      throw new Error('Region not found');
    }

    const finishedAt = toIsoOrNull(now());
    const message = normalizeNullableText(errorText, 4000) || 'Sync failed';
    const failedStatus = String(options.status || 'failed');
    const nextSyncAt = computeNextSyncAt({
      ...region,
      lastSyncStatus: failedStatus,
      lastSyncFinishedAt: finishedAt
    }, finishedAt);

    await db.prepare(`
      UPDATE data_region_sync_runs
      SET
        status = ?,
        finished_at = ?,
        error_text = ?,
        stage = NULL,
        stage_progress = NULL,
        stage_detail = NULL,
        stage_updated_at = ?,
        cancel_requested = FALSE,
        updated_at = datetime('now')
      WHERE id = ?
    `).run(
      failedStatus,
      finishedAt,
      message,
      finishedAt,
      run.id
    );

    await db.prepare(`
      UPDATE data_sync_regions
      SET
        last_sync_status = ?,
        last_sync_finished_at = ?,
        last_sync_error = ?,
        next_sync_at = ?,
        updated_at = datetime('now')
      WHERE id = ?
    `).run(
      failedStatus,
      finishedAt,
      message,
      nextSyncAt,
      region.id
    );

    return {
      run: await getRunById(run.id),
      region: await getRegionById(region.id)
    };
  }

  async function recoverInterruptedRuns(reason = 'Sync interrupted by process restart') {
    await ensureBootstrapped();
    const stuckRuns = await db.prepare(`
      SELECT id
      FROM data_region_sync_runs
      WHERE status IN ('queued', 'running')
      ORDER BY id
    `).all();

    const recovered = [];
    for (const row of stuckRuns) {
      const result = await markRunFailed(row.id, reason, {
        status: 'abandoned'
      });
      recovered.push(result.run);
    }
    return recovered;
  }

  async function refreshRegionNextSyncAt(regionId) {
    await ensureBootstrapped();
    const region = await getRegionById(regionId);
    if (!region) return null;
    if (['queued', 'running'].includes(region.lastSyncStatus)) {
      return region;
    }
    if (!region.canSync) {
      await db.prepare(`
        UPDATE data_sync_regions
        SET
          next_sync_at = NULL,
          updated_at = datetime('now')
        WHERE id = ?
      `).run(region.id);
      return getRegionById(region.id);
    }
    const nextSyncAt = computeNextSyncAt(region, now());
    await db.prepare(`
      UPDATE data_sync_regions
      SET
        next_sync_at = ?,
        updated_at = datetime('now')
      WHERE id = ?
    `).run(nextSyncAt, region.id);
    return getRegionById(region.id);
  }

  async function refreshAllNextSyncAt() {
    await ensureBootstrapped();
    const regions = await listRegions();
    const out = [];
    for (const region of regions) {
      const refreshed = await refreshRegionNextSyncAt(region.id);
      if (refreshed) out.push(refreshed);
    }
    return out;
  }

  return {
    getRecentRuns,
    getRunById,
    createQueuedRun,
    markRunStarted,
    markRunSucceeded,
    markRunFailed,
    markRunCancelRequested,
    updateRunStage,
    recoverInterruptedRuns,
    rescheduleRegionAfterSkippedSync,
    refreshRegionNextSyncAt,
    refreshAllNextSyncAt
  };
}

module.exports = {
  createSyncRunsDomain
};
