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

function createRegionsDomain(context: LooseRecord = {}) {
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
    hasResolvedExtract,
    fallback,
    now,
    validateSelectedExtract
  } = context;

  async function getRegionById(regionId) {
    await ensureBootstrapped();
    return rowToRegion(await getRegionRowById(regionId));
  }

  async function listRegions(options: LooseRecord = {}) {
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

  async function normalizeRegionInput(input: LooseRecord = {}, previous = null) {
    const previousRegion = previous || null;
    const hasLegacySourceValueField = Object.prototype.hasOwnProperty.call(input, 'sourceValue')
      || Object.prototype.hasOwnProperty.call(input, 'source_value');
    const rawSearchQuery = normalizeNullableText(
      input.searchQuery
        ?? input.search_query
        ?? previousRegion?.searchQuery
        ?? '',
      240
    );
    const extractSource = normalizeNullableText(
      input.extractSource ?? input.extract_source ?? previousRegion?.extractSource ?? '',
      64
    );
    const extractId = normalizeNullableText(
      input.extractId ?? input.extract_id ?? previousRegion?.extractId ?? '',
      240
    );
    const extractLabel = normalizeNullableText(
      input.extractLabel ?? input.extract_label ?? previousRegion?.extractLabel ?? '',
      240
    );
    const sourceTypeRaw = String(
      input.sourceType ?? input.source_type ?? previousRegion?.sourceType ?? 'extract'
    ).trim().toLowerCase();
    const sourceType = sourceTypeRaw || 'extract';
    const searchQuery = rawSearchQuery || extractLabel || extractId || '';
    const name = normalizeNullableText(
      input.name ?? previousRegion?.name ?? extractLabel ?? searchQuery ?? '',
      160
    );
    const slugRaw = normalizeNullableText(
      input.slug ?? previousRegion?.slug ?? name ?? extractLabel ?? searchQuery ?? 'region',
      100
    );
    const slug = await ensureUniqueSlug(slugRaw, previousRegion?.id || null);

    const next = {
      id: previousRegion?.id ? Number(previousRegion.id) : null,
      slug,
      name: name || extractLabel || searchQuery || 'Region',
      sourceType,
      sourceValue: searchQuery,
      searchQuery,
      extractSource: extractSource || '',
      extractId: extractId || '',
      extractLabel: extractLabel || extractId || null,
      extractResolutionStatus: hasResolvedExtract({
        extractSource,
        extractId,
        extractResolutionStatus: previousRegion?.extractResolutionStatus
      }) ? 'resolved' : 'needs_resolution',
      extractResolutionError: null,
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
    next.nextSyncAt = hasResolvedExtract(next)
      ? computeNextSyncAt(next, now())
      : null;

    const errors = [];
    if (hasLegacySourceValueField) {
      errors.push('The sourceValue field is no longer supported. Use searchQuery instead.');
    }
    if (sourceTypeRaw === 'extract_query') {
      errors.push('sourceType=extract_query is no longer supported. Use sourceType=extract instead.');
    } else if (next.sourceType !== 'extract') {
      errors.push('Only sourceType=extract is supported in v2');
    }
    if (!next.extractSource || !next.extractId) {
      errors.push('Select a canonical extract before saving the region');
    }
    if (!next.name) {
      errors.push('Region name is required');
    }
    if (!next.slug) {
      errors.push('Failed to generate region slug');
    }
    if (!next.sourceLayer) {
      errors.push('PMTiles source layer is required');
    }

    return {
      value: next,
      errors
    };
  }

  async function saveRegion(input: LooseRecord = {}, actor = null) {
    await ensureBootstrapped();
    const regionId = Number(input?.id || 0);
    const existing = regionId > 0 ? await getRegionById(regionId) : null;
    if (regionId > 0 && !existing) {
      throw new Error('Region not found');
    }
    if (existing && ['queued', 'running'].includes(existing.lastSyncStatus)) {
      throw new Error('Region cannot be updated while it is queued or actively syncing');
    }

    if (existing) {
      const existingExtractSource = normalizeNullableText(existing.extractSource, 64) || '';
      const existingExtractId = normalizeNullableText(existing.extractId, 240) || '';
      const nextExtractSource = normalizeNullableText(
        input.extractSource ?? input.extract_source ?? existing.extractSource ?? '',
        64
      ) || '';
      const nextExtractId = normalizeNullableText(
        input.extractId ?? input.extract_id ?? existing.extractId ?? '',
        240
      ) || '';
      const extractChanged = existingExtractSource !== nextExtractSource
        || existingExtractId !== nextExtractId;
      const hasSavedCanonicalExtract = Boolean(existingExtractSource && existingExtractId);
      if (extractChanged && hasSavedCanonicalExtract) {
        const membershipCount = await countRegionMemberships(existing.id);
        if (membershipCount > 0 || existing.lastSuccessfulSyncAt) {
          throw new Error('Changing canonical extract for an already synced region is not supported. Create a new region instead.');
        }
      }
    }

    const normalized = await normalizeRegionInput(input, existing);
    if (normalized.errors.length > 0) {
      throw new Error(normalized.errors.join(' '));
    }

    const extractValidation = await validateSelectedExtract(normalized.value, existing);
    if (extractValidation.error || !extractValidation.candidate) {
      throw new Error(extractValidation.error || 'Failed to validate canonical extract');
    }

    const next = {
      ...normalized.value,
      sourceType: 'extract',
      extractSource: extractValidation.candidate.extractSource,
      extractId: extractValidation.candidate.extractId,
      extractLabel: extractValidation.candidate.extractLabel,
      extractResolutionStatus: 'resolved',
      extractResolutionError: null
    };
    next.sourceValue = next.searchQuery || next.extractLabel || next.extractId;
    next.nextSyncAt = computeNextSyncAt(next, now());

    const updatedBy = normalizeNullableText(actor, 160);
    if (existing) {
      await db.prepare(`
        UPDATE data_sync_regions
        SET
          slug = ?,
          name = ?,
          source_type = ?,
          source_value = ?,
          extract_source = ?,
          extract_id = ?,
          extract_label = ?,
          extract_resolution_status = ?,
          extract_resolution_error = NULL,
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
        next.extractSource,
        next.extractId,
        next.extractLabel,
        next.extractResolutionStatus,
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
        extract_source,
        extract_id,
        extract_label,
        extract_resolution_status,
        extract_resolution_error,
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
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, 'idle', ?, ?, datetime('now'), datetime('now'))
    `).run(
      next.slug,
      next.name,
      next.sourceType,
      next.sourceValue,
      next.extractSource,
      next.extractId,
      next.extractLabel,
      next.extractResolutionStatus,
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
      throw new Error('Region has already been deleted');
    }

    return buildDeleteResult(existing, deletedBy, membershipCount, runCount, orphanDeletedCount);
  }

  async function deleteRegion(regionId, actor = null) {
    await ensureBootstrapped();
    const numericRegionId = Number(regionId || 0);
    if (!Number.isInteger(numericRegionId) || numericRegionId <= 0) {
      throw new Error('Region not found');
    }

    const existing = await getRegionById(numericRegionId);
    if (!existing) {
      throw new Error('Region not found');
    }
    if (['queued', 'running'].includes(existing.lastSyncStatus)) {
      throw new Error('Region cannot be deleted while it is queued or actively syncing');
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
