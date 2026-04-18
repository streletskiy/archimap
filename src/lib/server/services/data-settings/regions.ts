import type { Region, RegionInput } from '$shared/types';

const DELETE_REGION_SQL = {
  countActiveRuns: `
    SELECT COUNT(*) AS total
    FROM data_region_sync_runs
    WHERE region_id = ?
      AND status IN ('queued', 'running')
  `,
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
    validateSelectedExtract,
    countrySubregionsCatalog
  } = context;

  async function getRegionById(regionId): Promise<Region | null> {
    await ensureBootstrapped();
    return rowToRegion(await getRegionRowById(regionId));
  }

  async function countActiveRuns(regionId) {
    return Number((await db.prepare(DELETE_REGION_SQL.countActiveRuns).get(Number(regionId)))?.total || 0);
  }

  async function listRegions(
    options: {
      includeDisabled?: boolean;
      includeStorageStats?: boolean;
      includeHiddenSubregions?: boolean;
    } = {}
  ): Promise<Region[]> {
    await ensureBootstrapped();
    const includeDisabled = options.includeDisabled !== false;
    const includeStorageStats = options.includeStorageStats === true;
    const includeHiddenSubregions = options.includeHiddenSubregions === true;
    const rows = await listRegionRows();
    const all = rows.map(rowToRegion).filter((item): item is Region => Boolean(item));

    const subregionStats = new Map<number, { count: number; done: number }>();
    for (const region of all) {
      if (region.parentRegionId == null) continue;
      const stats = subregionStats.get(region.parentRegionId) || { count: 0, done: 0 };
      stats.count += 1;
      if (region.lastSuccessfulSyncAt) stats.done += 1;
      subregionStats.set(region.parentRegionId, stats);
    }

    const items = all
      .filter((item) => includeDisabled || item.enabled)
      .filter((item) => includeHiddenSubregions || item.visibleInAdmin)
      .map((item) => {
        const stats = subregionStats.get(item.id);
        if (!stats) return item;
        return {
          ...item,
          subregionCount: stats.count,
          subregionCompletedCount: stats.done
        };
      });
    return includeStorageStats ? await context.enrichRegionsWithStorageStats(items) : items;
  }

  async function ensureUniqueSlug(baseSlug, excludeRegionId = null) {
    const normalizedBase = slugify(baseSlug) || 'region';
    let candidate = normalizedBase;
    let suffix = 2;

    while (true) {
      const row = await db
        .prepare(
          `
        SELECT id
        FROM data_sync_regions
        WHERE slug = ?
        LIMIT 1
      `
        )
        .get(candidate);
      if (!row || Number(row.id) === Number(excludeRegionId || 0)) {
        return candidate;
      }
      candidate = `${normalizedBase}-${suffix}`;
      suffix += 1;
    }
  }

  async function validateOverlap(nextRegion: Region) {
    if (!nextRegion?.enabled || !nextRegion?.bounds) return [];
    const allRegions = await listRegions();
    return allRegions.filter((candidate) => {
      if (!candidate.enabled) return false;
      if (Number(candidate.id || 0) === Number(nextRegion.id || 0)) return false;
      return boundsOverlap(nextRegion.bounds, candidate.bounds);
    });
  }

  async function normalizeRegionInput(input: RegionInput = {}, previous: Region | null = null) {
    const previousRegion = previous || null;
    const hasLegacySourceValueField =
      Object.prototype.hasOwnProperty.call(input, 'sourceValue') ||
      Object.prototype.hasOwnProperty.call(input, 'source_value');
    const rawSearchQuery = normalizeNullableText(
      input.searchQuery ?? input.search_query ?? previousRegion?.searchQuery ?? '',
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
    const sourceTypeRaw = String(input.sourceType ?? input.source_type ?? previousRegion?.sourceType ?? 'extract')
      .trim()
      .toLowerCase();
    const sourceType = sourceTypeRaw || 'extract';
    const searchQuery = rawSearchQuery || extractLabel || extractId || '';
    const name = normalizeNullableText(input.name ?? previousRegion?.name ?? extractLabel ?? searchQuery ?? '', 160);
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
      })
        ? 'resolved'
        : 'needs_resolution',
      extractResolutionError: null,
      enabled: normalizeBoolean(input.enabled ?? previousRegion?.enabled, true),
      autoSyncEnabled: normalizeBoolean(
        input.autoSyncEnabled ?? previousRegion?.autoSyncEnabled,
        fallback.autoSyncEnabled
      ),
      autoSyncOnStart: normalizeBoolean(
        input.autoSyncOnStart ?? previousRegion?.autoSyncOnStart,
        fallback.autoSyncOnStart
      ),
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
      sourceLayer: normalizeSourceLayer(input.sourceLayer ?? previousRegion?.sourceLayer ?? fallback.sourceLayer),
      regionKind: (() => {
        const raw = String(input.regionKind ?? input.region_kind ?? previousRegion?.regionKind ?? 'standalone')
          .trim()
          .toLowerCase();
        return ['standalone', 'country_aggregate', 'subregion'].includes(raw) ? raw : 'standalone';
      })(),
      parentRegionId: (() => {
        const raw = input.parentRegionId ?? input.parent_region_id ?? previousRegion?.parentRegionId ?? null;
        const numeric = Number(raw);
        return Number.isInteger(numeric) && numeric > 0 ? numeric : null;
      })(),
      orderInParent: (() => {
        const raw = input.orderInParent ?? input.order_in_parent ?? previousRegion?.orderInParent ?? null;
        const numeric = Number(raw);
        return Number.isFinite(numeric) ? Math.trunc(numeric) : null;
      })(),
      visibleInAdmin: normalizeBoolean(
        input.visibleInAdmin ?? input.visible_in_admin ?? previousRegion?.visibleInAdmin,
        true
      ),
      countryCode: normalizeNullableText(
        input.countryCode ?? input.country_code ?? previousRegion?.countryCode ?? '',
        8
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
    next.nextSyncAt = hasResolvedExtract(next) ? computeNextSyncAt(next, now()) : null;

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

  async function saveRegion(input: RegionInput = {}, actor = null): Promise<Region> {
    await ensureBootstrapped();
    const regionId = Number(input?.id || 0);
    const existing = regionId > 0 ? await getRegionById(regionId) : null;
    if (regionId > 0 && !existing) {
      throw new Error('Region not found');
    }
    if (
      existing &&
      ['queued', 'running'].includes(existing.lastSyncStatus) &&
      (await countActiveRuns(existing.id)) > 0
    ) {
      throw new Error('Region cannot be updated while it is queued or actively syncing');
    }

    if (existing) {
      const existingExtractSource = normalizeNullableText(existing.extractSource, 64) || '';
      const existingExtractId = normalizeNullableText(existing.extractId, 240) || '';
      const nextExtractSource =
        normalizeNullableText(input.extractSource ?? input.extract_source ?? existing.extractSource ?? '', 64) || '';
      const nextExtractId =
        normalizeNullableText(input.extractId ?? input.extract_id ?? existing.extractId ?? '', 240) || '';
      const extractChanged = existingExtractSource !== nextExtractSource || existingExtractId !== nextExtractId;
      const hasSavedCanonicalExtract = Boolean(existingExtractSource && existingExtractId);
      if (extractChanged && hasSavedCanonicalExtract) {
        const membershipCount = await countRegionMemberships(existing.id);
        if (membershipCount > 0 || existing.lastSuccessfulSyncAt) {
          throw new Error(
            'Changing canonical extract for an already synced region is not supported. Create a new region instead.'
          );
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
      await db
        .prepare(
          `
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
          region_kind = ?,
          parent_region_id = ?,
          order_in_parent = ?,
          visible_in_admin = ?,
          country_code = ?,
          updated_by = ?,
          updated_at = datetime('now')
        WHERE id = ?
      `
        )
        .run(
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
          next.regionKind,
          next.parentRegionId,
          next.orderInParent,
          next.visibleInAdmin ? 1 : 0,
          next.countryCode,
          updatedBy,
          existing.id
        );
      const updatedRegion = await getRegionById(existing.id);
      if (!updatedRegion) {
        throw new Error('Failed to load saved region');
      }
      return updatedRegion;
    }

    await db
      .prepare(
        `
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
        region_kind,
        parent_region_id,
        order_in_parent,
        visible_in_admin,
        country_code,
        updated_by,
        created_at,
        updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, 'idle', ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
    `
      )
      .run(
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
        next.regionKind,
        next.parentRegionId,
        next.orderInParent,
        next.visibleInAdmin ? 1 : 0,
        next.countryCode,
        updatedBy
      );

    const row = await db
      .prepare(
        `
      SELECT id
      FROM data_sync_regions
      WHERE slug = ?
      ORDER BY id DESC
      LIMIT 1
    `
      )
      .get(next.slug);
    const createdRegion = await getRegionById(row?.id);
    if (!createdRegion) {
      throw new Error('Failed to load saved region');
    }
    return createdRegion;
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
    if (['queued', 'running'].includes(existing.lastSyncStatus) && (await countActiveRuns(existing.id)) > 0) {
      throw new Error('Region cannot be deleted while it is queued or actively syncing');
    }

    const deletedBy = normalizeNullableText(actor, 160);
    const tx = db.transaction(async () => runDeleteRegionTx(existing, deletedBy));
    return tx();
  }

  async function listSubregions(parentId: number): Promise<Region[]> {
    const numericId = Number(parentId);
    if (!Number.isInteger(numericId) || numericId <= 0) return [];
    const rows = await db
      .prepare(
        `
      SELECT
        id, slug, name, source_type, source_value, extract_source, extract_id, extract_label,
        extract_resolution_status, extract_resolution_error, enabled, auto_sync_enabled,
        auto_sync_on_start, auto_sync_interval_hours, pmtiles_min_zoom, pmtiles_max_zoom,
        source_layer, last_sync_started_at, last_sync_finished_at, last_sync_status,
        last_sync_error, last_successful_sync_at, source_data_updated_at, next_sync_at,
        bounds_west, bounds_south, bounds_east, bounds_north, last_feature_count, updated_by,
        created_at, updated_at, parent_region_id, region_kind, order_in_parent,
        visible_in_admin, country_code
      FROM data_sync_regions
      WHERE parent_region_id = ?
      ORDER BY COALESCE(order_in_parent, 0), lower(name), id
    `
      )
      .all(numericId);
    return (Array.isArray(rows) ? rows : []).map(rowToRegion).filter((item): item is Region => Boolean(item));
  }

  async function listRegionTree(
    options: { includeDisabled?: boolean; includeSubregions?: boolean } = {}
  ): Promise<Region[]> {
    await ensureBootstrapped();
    const includeDisabled = options.includeDisabled !== false;
    const includeSubregions = options.includeSubregions !== false;
    const rows = await listRegionRows();
    const items = rows
      .map(rowToRegion)
      .filter((item): item is Region => Boolean(item))
      .filter((item) => includeDisabled || item.enabled);
    const byId = new Map<number, Region>();
    for (const region of items) byId.set(region.id, region);

    const visible = items.filter((region) => region.visibleInAdmin && region.parentRegionId == null);
    if (!includeSubregions) return visible;

    const childrenByParent = new Map<number, Region[]>();
    for (const region of items) {
      if (region.parentRegionId == null) continue;
      const arr = childrenByParent.get(region.parentRegionId) || [];
      arr.push(region);
      childrenByParent.set(region.parentRegionId, arr);
    }
    for (const arr of childrenByParent.values()) {
      arr.sort((a, b) => {
        const ao = a.orderInParent ?? Number.MAX_SAFE_INTEGER;
        const bo = b.orderInParent ?? Number.MAX_SAFE_INTEGER;
        if (ao !== bo) return ao - bo;
        return String(a.name).localeCompare(String(b.name));
      });
    }

    const out: Region[] = [];
    for (const region of visible) {
      const subs = childrenByParent.get(region.id) || [];
      const successful = subs.filter((sub) => Boolean(sub.lastSuccessfulSyncAt));
      out.push({
        ...region,
        subregions: subs,
        subregionCount: subs.length,
        subregionCompletedCount: successful.length
      });
    }
    return out;
  }

  async function createCountryAggregate(options: LooseRecord = {}): Promise<Region> {
    await ensureBootstrapped();
    if (!countrySubregionsCatalog || typeof countrySubregionsCatalog.getCountry !== 'function') {
      throw new Error('Country-subregions catalog is not configured');
    }
    const countryId = String(options?.countryId || '')
      .trim()
      .toLowerCase();
    if (!countryId) {
      throw new Error('countryId is required');
    }
    const country = await countrySubregionsCatalog.getCountry(countryId);
    if (!country) {
      throw new Error(`Country not found in Geofabrik catalog: ${countryId}`);
    }
    const actor = normalizeNullableText(options?.actor, 160);
    const hasSubregions = Array.isArray(country.subregions) && country.subregions.length > 0;

    const parentRegion = await saveRegion(
      {
        name: country.name,
        slug: slugify(country.countryId),
        extractSource: 'geofabrik',
        extractId: country.countryId,
        extractLabel: country.name,
        searchQuery: country.name,
        regionKind: hasSubregions ? 'country_aggregate' : 'standalone',
        visibleInAdmin: true,
        countryCode: country.iso
      },
      actor
    );

    if (!hasSubregions) return parentRegion;

    const subs: Region[] = [];
    let orderIndex = 0;
    for (const sub of country.subregions) {
      const subSlug = slugify(`${country.countryId}-${sub.extractId.replace(/\//g, '-')}`);
      const saved = await saveRegion(
        {
          name: `${country.name} · ${sub.name}`,
          slug: subSlug,
          extractSource: 'geofabrik',
          extractId: sub.extractId,
          extractLabel: sub.name,
          searchQuery: sub.name,
          regionKind: 'subregion',
          parentRegionId: parentRegion.id,
          orderInParent: orderIndex,
          visibleInAdmin: false,
          countryCode: sub.iso || country.iso,
          autoSyncOnStart: false
        },
        actor
      );
      subs.push(saved);
      orderIndex += 1;
    }

    return {
      ...parentRegion,
      subregions: subs,
      subregionCount: subs.length,
      subregionCompletedCount: 0
    };
  }

  async function listRuntimePmtilesRegions(): Promise<
    Array<
      Pick<
        Region,
        'id' | 'slug' | 'name' | 'sourceLayer' | 'bounds' | 'pmtilesMinZoom' | 'pmtilesMaxZoom' | 'lastSuccessfulSyncAt'
      >
    >
  > {
    await ensureBootstrapped();
    return (await listRegions({ includeDisabled: false, includeHiddenSubregions: true }))
      .filter((region) => region.enabled && region.bounds && region.regionKind !== 'country_aggregate')
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
    listRegionTree,
    listSubregions,
    normalizeRegionInput,
    saveRegion,
    createCountryAggregate,
    deleteRegion,
    listRuntimePmtilesRegions,
    validateOverlap
  };
}

module.exports = {
  createRegionsDomain
};
