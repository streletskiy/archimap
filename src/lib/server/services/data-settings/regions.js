const DELETE_REGION_SQL = {
  countMemberships: `
    SELECT COUNT(*) AS total
    FROM data_region_memberships
    WHERE region_id = ?
  `,
  countRuns: `
    SELECT COUNT(*) AS total
    FROM data_region_sync_runs
    WHERE region_id = ?
  `,
  deleteMemberships: `
    DELETE FROM data_region_memberships
    WHERE region_id = ?
  `,
  deleteRuns: `
    DELETE FROM data_region_sync_runs
    WHERE region_id = ?
  `,
  deleteOrphanContours: `
    DELETE FROM osm.building_contours
    WHERE NOT EXISTS (
      SELECT 1
      FROM data_region_memberships drm
      WHERE drm.osm_type = osm.building_contours.osm_type
        AND drm.osm_id = osm.building_contours.osm_id
    )
  `,
  refreshPostgresContourSummary: `
    INSERT INTO osm.building_contours_summary (singleton_id, total, last_updated, refreshed_at)
    SELECT 1, COUNT(*)::bigint, MAX(updated_at), NOW()
    FROM osm.building_contours
    ON CONFLICT (singleton_id) DO UPDATE SET
      total = EXCLUDED.total,
      last_updated = EXCLUDED.last_updated,
      refreshed_at = EXCLUDED.refreshed_at
  `,
  deleteRegion: `
    DELETE FROM data_sync_regions
    WHERE id = ?
  `
};

function createRegionsDomain(context = {}) {
  const {
    db,
    ensureBootstrapped,
    rowToRegion,
    listRegionRows,
    getRegionRowById,
    countRegionMemberships,
    normalizeNullableText,
    normalizeBoolean,
    normalizeInteger,
    normalizeSourceLayer,
    slugify,
    boundsOverlap,
    computeNextSyncAt,
    fallback,
    now
  } = context;

  async function getRegionById(regionId) {
    await ensureBootstrapped();
    return rowToRegion(await getRegionRowById(regionId));
  }

  async function listRegions(options = {}) {
    await ensureBootstrapped();
    const includeDisabled = options.includeDisabled !== false;
    const includeStorageStats = options.includeStorageStats === true;
    const rows = await listRegionRows();
    const items = rows
      .map(rowToRegion)
      .filter((item) => includeDisabled || item.enabled);
    return includeStorageStats
      ? await context.enrichRegionsWithStorageStats(items)
      : items;
  }

  async function ensureUniqueSlug(baseSlug, excludeRegionId = null) {
    const normalizedBase = slugify(baseSlug) || 'region';
    let candidate = normalizedBase;
    let suffix = 2;

    while (true) {
      const row = await db.prepare(`
        SELECT id
        FROM data_sync_regions
        WHERE slug = ?
        LIMIT 1
      `).get(candidate);
      if (!row || Number(row.id) === Number(excludeRegionId || 0)) {
        return candidate;
      }
      candidate = `${normalizedBase}-${suffix}`;
      suffix += 1;
    }
  }

  async function validateOverlap(nextRegion) {
    if (!nextRegion?.enabled || !nextRegion?.bounds) return [];
    const allRegions = await listRegions();
    return allRegions.filter((candidate) => {
      if (!candidate.enabled) return false;
      if (Number(candidate.id || 0) === Number(nextRegion.id || 0)) return false;
      return boundsOverlap(nextRegion.bounds, candidate.bounds);
    });
  }

  async function normalizeRegionInput(input = {}, previous = null) {
    const previousRegion = previous || null;
    const sourceValue = normalizeNullableText(
      input.sourceValue ?? input.source_value ?? previousRegion?.sourceValue ?? '',
      240
    );
    const sourceType = String(
      input.sourceType ?? input.source_type ?? previousRegion?.sourceType ?? 'extract_query'
    ).trim() || 'extract_query';
    const name = normalizeNullableText(
      input.name ?? previousRegion?.name ?? sourceValue ?? '',
      160
    );
    const slugRaw = normalizeNullableText(
      input.slug ?? previousRegion?.slug ?? name ?? sourceValue ?? 'region',
      100
    );
    const slug = await ensureUniqueSlug(slugRaw, previousRegion?.id || null);

    const next = {
      id: previousRegion?.id ? Number(previousRegion.id) : null,
      slug,
      name: name || sourceValue || 'Region',
      sourceType,
      sourceValue: sourceValue || '',
      enabled: normalizeBoolean(input.enabled ?? previousRegion?.enabled, true),
      autoSyncEnabled: normalizeBoolean(input.autoSyncEnabled ?? previousRegion?.autoSyncEnabled, fallback.autoSyncEnabled),
      autoSyncOnStart: normalizeBoolean(input.autoSyncOnStart ?? previousRegion?.autoSyncOnStart, fallback.autoSyncOnStart),
      autoSyncIntervalHours: normalizeInteger(
        input.autoSyncIntervalHours ?? previousRegion?.autoSyncIntervalHours,
        fallback.autoSyncIntervalHours,
        0,
        24 * 365
      ),
      pmtilesMinZoom: normalizeInteger(
        input.pmtilesMinZoom ?? previousRegion?.pmtilesMinZoom,
        fallback.pmtilesMinZoom,
        0,
        22
      ),
      pmtilesMaxZoom: normalizeInteger(
        input.pmtilesMaxZoom ?? previousRegion?.pmtilesMaxZoom,
        fallback.pmtilesMaxZoom,
        0,
        22
      ),
      sourceLayer: normalizeSourceLayer(
        input.sourceLayer ?? previousRegion?.sourceLayer ?? fallback.sourceLayer
      ),
      bounds: previousRegion?.bounds || null,
      lastSyncStartedAt: previousRegion?.lastSyncStartedAt || null,
      lastSyncFinishedAt: previousRegion?.lastSyncFinishedAt || null,
      lastSyncStatus: previousRegion?.lastSyncStatus || 'idle',
      lastSyncError: previousRegion?.lastSyncError || null,
      lastSuccessfulSyncAt: previousRegion?.lastSuccessfulSyncAt || null,
      nextSyncAt: previousRegion?.nextSyncAt || null,
      lastFeatureCount: previousRegion?.lastFeatureCount ?? null
    };

    next.pmtilesMaxZoom = Math.max(next.pmtilesMinZoom, next.pmtilesMaxZoom);
    next.nextSyncAt = computeNextSyncAt(next, now());

    const errors = [];
    if (next.sourceType !== 'extract_query') {
      errors.push('Для v1 поддерживается только sourceType=extract_query');
    }
    if (!next.sourceValue) {
      errors.push('Укажите QuackOSM extract query');
    }
    if (!next.name) {
      errors.push('Укажите название региона');
    }
    if (!next.slug) {
      errors.push('Не удалось сформировать slug региона');
    }
    if (!next.sourceLayer) {
      errors.push('Укажите source layer для PMTiles');
    }

    return {
      value: next,
      errors
    };
  }

  async function saveRegion(input = {}, actor = null) {
    await ensureBootstrapped();
    const regionId = Number(input?.id || 0);
    const existing = regionId > 0 ? await getRegionById(regionId) : null;
    if (regionId > 0 && !existing) {
      throw new Error('Регион не найден');
    }
    if (existing && ['queued', 'running'].includes(existing.lastSyncStatus)) {
      throw new Error('Нельзя изменять регион во время очереди или активной синхронизации');
    }

    if (existing) {
      const nextSourceType = input.sourceType ?? input.source_type ?? existing.sourceType ?? '';
      const nextSourceValue = input.sourceValue ?? input.source_value ?? existing.sourceValue ?? '';
      const sourceChanged = String(existing.sourceType || '') !== String(nextSourceType || '')
        || String(existing.sourceValue || '') !== String(nextSourceValue || '').trim();
      if (sourceChanged) {
        const membershipCount = await countRegionMemberships(existing.id);
        if (membershipCount > 0 || existing.lastSuccessfulSyncAt) {
          throw new Error('Изменение extract query для уже синхронизированного региона не поддерживается в v1. Создайте новый регион.');
        }
      }
    }

    const normalized = await normalizeRegionInput(input, existing);
    if (normalized.errors.length > 0) {
      throw new Error(normalized.errors.join(' '));
    }

    const next = normalized.value;
    const updatedBy = normalizeNullableText(actor, 160);
    if (existing) {
      await db.prepare(`
        UPDATE data_sync_regions
        SET
          slug = ?,
          name = ?,
          source_type = ?,
          source_value = ?,
          enabled = ?,
          auto_sync_enabled = ?,
          auto_sync_on_start = ?,
          auto_sync_interval_hours = ?,
          pmtiles_min_zoom = ?,
          pmtiles_max_zoom = ?,
          source_layer = ?,
          next_sync_at = ?,
          updated_by = ?,
          updated_at = datetime('now')
        WHERE id = ?
      `).run(
        next.slug,
        next.name,
        next.sourceType,
        next.sourceValue,
        next.enabled ? 1 : 0,
        next.autoSyncEnabled ? 1 : 0,
        next.autoSyncOnStart ? 1 : 0,
        next.autoSyncIntervalHours,
        next.pmtilesMinZoom,
        next.pmtilesMaxZoom,
        next.sourceLayer,
        next.nextSyncAt,
        updatedBy,
        existing.id
      );
      return getRegionById(existing.id);
    }

    await db.prepare(`
      INSERT INTO data_sync_regions (
        slug,
        name,
        source_type,
        source_value,
        enabled,
        auto_sync_enabled,
        auto_sync_on_start,
        auto_sync_interval_hours,
        pmtiles_min_zoom,
        pmtiles_max_zoom,
        source_layer,
        last_sync_status,
        next_sync_at,
        updated_by,
        created_at,
        updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'idle', ?, ?, datetime('now'), datetime('now'))
    `).run(
      next.slug,
      next.name,
      next.sourceType,
      next.sourceValue,
      next.enabled ? 1 : 0,
      next.autoSyncEnabled ? 1 : 0,
      next.autoSyncOnStart ? 1 : 0,
      next.autoSyncIntervalHours,
      next.pmtilesMinZoom,
      next.pmtilesMaxZoom,
      next.sourceLayer,
      next.nextSyncAt,
      updatedBy
    );

    const row = await db.prepare(`
      SELECT id
      FROM data_sync_regions
      WHERE slug = ?
      ORDER BY id DESC
      LIMIT 1
    `).get(next.slug);
    return getRegionById(row?.id);
  }

  function buildDeleteResult(existing, deletedBy, membershipCount, runCount, orphanDeletedCount) {
    return {
      region: {
        ...existing,
        deletedBy
      },
      deletedMembershipCount: membershipCount,
      deletedRunCount: runCount,
      orphanDeletedCount
    };
  }

  async function runDeleteRegionTx(existing, deletedBy) {
    const membershipCount = Number((await db.prepare(DELETE_REGION_SQL.countMemberships).get(existing.id))?.total || 0);
    const runCount = Number((await db.prepare(DELETE_REGION_SQL.countRuns).get(existing.id))?.total || 0);

    await db.prepare(DELETE_REGION_SQL.deleteMemberships).run(existing.id);
    await db.prepare(DELETE_REGION_SQL.deleteRuns).run(existing.id);

    const orphanDeletedCount = Number((await db.prepare(DELETE_REGION_SQL.deleteOrphanContours).run())?.changes || 0);

    if (db.provider === 'postgres') {
      await db.prepare(DELETE_REGION_SQL.refreshPostgresContourSummary).run();
    }

    const deleteResult = await db.prepare(DELETE_REGION_SQL.deleteRegion).run(existing.id);
    if (Number(deleteResult?.changes || 0) === 0) {
      throw new Error('Регион уже был удалён');
    }

    return buildDeleteResult(existing, deletedBy, membershipCount, runCount, orphanDeletedCount);
  }

  async function deleteRegion(regionId, actor = null) {
    await ensureBootstrapped();
    const numericRegionId = Number(regionId || 0);
    if (!Number.isInteger(numericRegionId) || numericRegionId <= 0) {
      throw new Error('Регион не найден');
    }

    const existing = await getRegionById(numericRegionId);
    if (!existing) {
      throw new Error('Регион не найден');
    }
    if (['queued', 'running'].includes(existing.lastSyncStatus)) {
      throw new Error('Нельзя удалить регион во время очереди или активной синхронизации');
    }

    const deletedBy = normalizeNullableText(actor, 160);
    const tx = db.transaction(async () => runDeleteRegionTx(existing, deletedBy));
    return tx();
  }

  async function listRuntimePmtilesRegions() {
    await ensureBootstrapped();
    return (await listRegions({ includeDisabled: false }))
      .filter((region) => region.enabled && region.bounds && region.lastSuccessfulSyncAt)
      .map((region) => ({
        id: region.id,
        slug: region.slug,
        name: region.name,
        sourceLayer: region.sourceLayer,
        bounds: region.bounds,
        pmtilesMinZoom: region.pmtilesMinZoom,
        pmtilesMaxZoom: region.pmtilesMaxZoom,
        lastSuccessfulSyncAt: region.lastSuccessfulSyncAt
      }));
  }

  return {
    getRegionById,
    listRegions,
    normalizeRegionInput,
    saveRegion,
    deleteRegion,
    listRuntimePmtilesRegions,
    validateOverlap
  };
}

module.exports = {
  createRegionsDomain
};
