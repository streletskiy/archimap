const { RUN_SELECT_FIELDS } = require('./shared');

function createSyncRunsDomain(context = {}) {
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
      return 'Регион не найден';
    }
    if (region.extractResolutionStatus === 'resolution_error') {
      return region.extractResolutionError || 'Не удалось подтвердить canonical extract для региона';
    }
    if (region.extractResolutionStatus === 'resolution_required' || region.extractResolutionStatus === 'needs_resolution') {
      return region.extractResolutionError || 'Для региона требуется ручной выбор canonical extract';
    }
    return 'Регион не готов к синхронизации: canonical extract не выбран';
  }

  async function getRecentRuns(regionId = null, limit = 25) {
    await ensureBootstrapped();
    const safeLimit = Math.max(1, Math.min(200, Number(limit) || 25));
    const rows = regionId == null
      ? await db.prepare(`
        SELECT ${RUN_SELECT_FIELDS}
        FROM data_region_sync_runs
        ORDER BY id DESC
        LIMIT ?
      `).all(safeLimit)
      : await db.prepare(`
        SELECT ${RUN_SELECT_FIELDS}
        FROM data_region_sync_runs
        WHERE region_id = ?
        ORDER BY id DESC
        LIMIT ?
      `).all(Number(regionId), safeLimit);
    return rows.map(rowToRun);
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
      throw new Error('Регион не найден');
    }
    if (!region.enabled) {
      throw new Error('Синхронизация доступна только для enabled региона');
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
      throw new Error('Run не найден');
    }
    const startedAt = toIsoOrNull(now());
    await db.prepare(`
      UPDATE data_region_sync_runs
      SET
        status = 'running',
        started_at = ?,
        updated_at = datetime('now')
      WHERE id = ?
    `).run(startedAt, run.id);
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

  async function markRunSucceeded(runId, summary = {}) {
    await ensureBootstrapped();
    const run = await getRunById(runId);
    if (!run) {
      throw new Error('Run не найден');
    }
    const region = await getRegionById(run.regionId);
    if (!region) {
      throw new Error('Регион не найден');
    }

    const finishedAt = toIsoOrNull(now());
    const bounds = normalizeBounds(summary.bounds || null);
    const importedFeatureCount = summary.importedFeatureCount == null ? null : Number(summary.importedFeatureCount);
    const activeFeatureCount = summary.activeFeatureCount == null ? null : Number(summary.activeFeatureCount);
    const orphanDeletedCount = summary.orphanDeletedCount == null ? null : Number(summary.orphanDeletedCount);
    const pmtilesBytes = summary.pmtilesBytes == null ? null : Number(summary.pmtilesBytes);
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
      run.id
    );

    await db.prepare(`
      UPDATE data_sync_regions
      SET
        last_sync_status = 'idle',
        last_sync_finished_at = ?,
        last_sync_error = NULL,
        last_successful_sync_at = ?,
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

  async function markRunFailed(runId, errorText, options = {}) {
    await ensureBootstrapped();
    const run = await getRunById(runId);
    if (!run) {
      throw new Error('Run не найден');
    }
    const region = await getRegionById(run.regionId);
    if (!region) {
      throw new Error('Регион не найден');
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
        updated_at = datetime('now')
      WHERE id = ?
    `).run(
      failedStatus,
      finishedAt,
      message,
      run.id
    );

    await db.prepare(`
      UPDATE data_sync_regions
      SET
        last_sync_status = 'failed',
        last_sync_finished_at = ?,
        last_sync_error = ?,
        next_sync_at = ?,
        updated_at = datetime('now')
      WHERE id = ?
    `).run(
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
    recoverInterruptedRuns,
    refreshRegionNextSyncAt,
    refreshAllNextSyncAt
  };
}

module.exports = {
  createSyncRunsDomain
};
