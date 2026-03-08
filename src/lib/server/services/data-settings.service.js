const {
  DEFAULT_FILTER_TAG_ALLOWLIST,
  normalizeFilterTagKeyList
} = require('./filter-tags.service');

function normalizeRegionPmtilesSlug(regionOrSlug) {
  const raw = typeof regionOrSlug === 'object' && regionOrSlug
    ? regionOrSlug.slug
    : regionOrSlug;
  const slug = String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  if (!slug) {
    throw new Error('normalizeRegionPmtilesSlug: region slug is required');
  }
  return slug;
}

function buildLegacyRegionPmtilesFileName(regionId) {
  const id = Number(regionId);
  if (!Number.isInteger(id) || id <= 0) {
    throw new Error('buildLegacyRegionPmtilesFileName: regionId must be a positive integer');
  }
  return `buildings-region-${id}.pmtiles`;
}

function buildRegionPmtilesFileName(regionOrSlug) {
  return `buildings-region-${normalizeRegionPmtilesSlug(regionOrSlug)}.pmtiles`;
}

function resolveLegacyRegionPmtilesPath(dataDir, regionId) {
  const path = require('path');
  return path.join(String(dataDir || ''), 'regions', buildLegacyRegionPmtilesFileName(regionId));
}

function resolveRegionPmtilesPath(dataDir, regionOrSlug) {
  const path = require('path');
  return path.join(String(dataDir || ''), 'regions', buildRegionPmtilesFileName(regionOrSlug));
}

function resolveExistingRegionPmtilesPath(dataDir, region) {
  const fs = require('fs');
  const primaryPath = resolveRegionPmtilesPath(dataDir, region);
  if (fs.existsSync(primaryPath)) {
    return primaryPath;
  }
  if (region && Number.isInteger(Number(region.id)) && Number(region.id) > 0) {
    const legacyPath = resolveLegacyRegionPmtilesPath(dataDir, region.id);
    if (fs.existsSync(legacyPath)) {
      return legacyPath;
    }
  }
  return null;
}

function createDataSettingsService(options = {}) {
  const {
    db,
    fallbackData = {},
    now = () => new Date()
  } = options;

  if (!db) {
    throw new Error('createDataSettingsService: db is required');
  }

  const fallback = normalizeFallbackData(fallbackData);
  let bootstrapPromise = null;

  function normalizeBoolean(value, fallbackValue = false) {
    if (typeof value === 'boolean') return value;
    const text = String(value ?? '').trim().toLowerCase();
    if (text === 'true' || text === '1' || text === 'yes') return true;
    if (text === 'false' || text === '0' || text === 'no') return false;
    return Boolean(fallbackValue);
  }

  function normalizeNullableText(value, maxLength = 255) {
    const text = String(value ?? '').trim();
    if (!text) return null;
    return text.slice(0, Math.max(1, maxLength));
  }

  function normalizeInteger(value, fallbackValue, min, max) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallbackValue;
    const truncated = Math.trunc(parsed);
    return Math.max(min, Math.min(max, truncated));
  }

  function slugify(value) {
    return String(value || '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80);
  }

  function normalizeSourceLayer(value, fallbackValue = 'buildings') {
    const raw = String(value || fallbackValue || 'buildings').trim();
    const safe = raw.replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
    return safe.slice(0, 64) || 'buildings';
  }

  function normalizeBounds(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const west = Number(raw.west);
    const south = Number(raw.south);
    const east = Number(raw.east);
    const north = Number(raw.north);
    if (![west, south, east, north].every(Number.isFinite)) return null;
    if (west < -180 || west > 180 || east < -180 || east > 180) return null;
    if (south < -90 || south > 90 || north < -90 || north > 90) return null;
    if (west >= east || south >= north) return null;
    return { west, south, east, north };
  }

  function boundsFromRow(row) {
    const bounds = normalizeBounds({
      west: row?.bounds_west,
      south: row?.bounds_south,
      east: row?.bounds_east,
      north: row?.bounds_north
    });
    return bounds || null;
  }

  function boundsOverlap(left, right) {
    if (!left || !right) return false;
    return left.west < right.east
      && left.east > right.west
      && left.south < right.north
      && left.north > right.south;
  }

  function addHours(date, hours) {
    const ts = Date.parse(String(date || ''));
    if (!Number.isFinite(ts)) return null;
    return new Date(ts + (Math.max(0, Number(hours) || 0) * 60 * 60 * 1000));
  }

  function toIsoOrNull(value) {
    if (value == null) return null;
    if (typeof value === 'string' && !value.trim()) return null;
    const date = value instanceof Date ? value : new Date(value);
    const ts = date.getTime();
    if (!Number.isFinite(ts)) return null;
    return date.toISOString();
  }

  function computeNextSyncAt(regionLike = {}, referenceDate = now()) {
    const enabled = normalizeBoolean(regionLike.enabled, true);
    const autoSyncEnabled = normalizeBoolean(regionLike.autoSyncEnabled, true);
    const intervalHours = normalizeInteger(
      regionLike.autoSyncIntervalHours,
      fallback.autoSyncIntervalHours,
      0,
      24 * 365
    );

    if (!enabled || !autoSyncEnabled || intervalHours <= 0) {
      return null;
    }

    const referenceIso = toIsoOrNull(referenceDate) || toIsoOrNull(now());
    const lastSuccessfulSyncAt = toIsoOrNull(regionLike.lastSuccessfulSyncAt);
    if (lastSuccessfulSyncAt) {
      const next = addHours(lastSuccessfulSyncAt, intervalHours);
      if (!next) return referenceIso;
      return next.toISOString();
    }

    const lastSyncStatus = String(regionLike.lastSyncStatus || '').trim().toLowerCase();
    const lastSyncFinishedAt = toIsoOrNull(regionLike.lastSyncFinishedAt);
    if (['failed', 'abandoned'].includes(lastSyncStatus) && lastSyncFinishedAt) {
      const retryAt = addHours(lastSyncFinishedAt, intervalHours);
      if (!retryAt) return referenceIso;
      return retryAt.toISOString();
    }

    return referenceIso;
  }

  function rowToRegion(row) {
    if (!row) return null;
    return {
      id: Number(row.id),
      slug: String(row.slug || ''),
      name: String(row.name || ''),
      sourceType: String(row.source_type || 'extract_query'),
      sourceValue: String(row.source_value || ''),
      enabled: Number(row.enabled || 0) > 0,
      autoSyncEnabled: Number(row.auto_sync_enabled || 0) > 0,
      autoSyncOnStart: Number(row.auto_sync_on_start || 0) > 0,
      autoSyncIntervalHours: Number(row.auto_sync_interval_hours || 0),
      pmtilesMinZoom: Number(row.pmtiles_min_zoom || 0),
      pmtilesMaxZoom: Number(row.pmtiles_max_zoom || 0),
      sourceLayer: String(row.source_layer || 'buildings'),
      lastSyncStartedAt: row.last_sync_started_at ? String(row.last_sync_started_at) : null,
      lastSyncFinishedAt: row.last_sync_finished_at ? String(row.last_sync_finished_at) : null,
      lastSyncStatus: String(row.last_sync_status || 'idle'),
      lastSyncError: row.last_sync_error ? String(row.last_sync_error) : null,
      lastSuccessfulSyncAt: row.last_successful_sync_at ? String(row.last_successful_sync_at) : null,
      nextSyncAt: row.next_sync_at ? String(row.next_sync_at) : null,
      bounds: boundsFromRow(row),
      lastFeatureCount: row.last_feature_count == null ? null : Number(row.last_feature_count),
      updatedBy: row.updated_by ? String(row.updated_by) : null,
      createdAt: row.created_at ? String(row.created_at) : null,
      updatedAt: row.updated_at ? String(row.updated_at) : null
    };
  }

  function rowToRun(row) {
    if (!row) return null;
    return {
      id: Number(row.id),
      regionId: Number(row.region_id),
      status: String(row.status || 'queued'),
      triggerReason: String(row.trigger_reason || 'manual'),
      requestedBy: row.requested_by ? String(row.requested_by) : null,
      requestedAt: row.requested_at ? String(row.requested_at) : null,
      startedAt: row.started_at ? String(row.started_at) : null,
      finishedAt: row.finished_at ? String(row.finished_at) : null,
      error: row.error_text ? String(row.error_text) : null,
      importedFeatureCount: row.imported_feature_count == null ? null : Number(row.imported_feature_count),
      activeFeatureCount: row.active_feature_count == null ? null : Number(row.active_feature_count),
      orphanDeletedCount: row.orphan_deleted_count == null ? null : Number(row.orphan_deleted_count),
      pmtilesBytes: row.pmtiles_bytes == null ? null : Number(row.pmtiles_bytes),
      bounds: boundsFromRow(row),
      createdAt: row.created_at ? String(row.created_at) : null,
      updatedAt: row.updated_at ? String(row.updated_at) : null
    };
  }

function normalizeFallbackData(raw = {}) {
    return {
      autoSyncEnabled: normalizeBoolean(raw.autoSyncEnabled, true),
      autoSyncOnStart: normalizeBoolean(raw.autoSyncOnStart, false),
      autoSyncIntervalHours: normalizeInteger(raw.autoSyncIntervalHours, 168, 0, 24 * 365),
      pmtilesMinZoom: normalizeInteger(raw.pmtilesMinZoom, 13, 0, 22),
      pmtilesMaxZoom: normalizeInteger(raw.pmtilesMaxZoom, 16, 0, 22),
      sourceLayer: normalizeSourceLayer(raw.sourceLayer || 'buildings')
    };
  }

  async function readAppDataSettingsRow() {
    try {
      return await db.prepare(`
        SELECT
          id,
          env_bootstrap_completed,
          env_bootstrap_source,
          filter_tag_allowlist_json,
          updated_by,
          updated_at
        FROM app_data_settings
        WHERE id = 1
        LIMIT 1
      `).get() || null;
    } catch {
      return null;
    }
  }

  async function listRegionRows() {
    try {
      return await db.prepare(`
        SELECT
          id,
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
          last_sync_started_at,
          last_sync_finished_at,
          last_sync_status,
          last_sync_error,
          last_successful_sync_at,
          next_sync_at,
          bounds_west,
          bounds_south,
          bounds_east,
          bounds_north,
          last_feature_count,
          updated_by,
          created_at,
          updated_at
        FROM data_sync_regions
        ORDER BY lower(name), id
      `).all();
    } catch {
      return [];
    }
  }

  async function getRegionRowById(regionId) {
    const id = Number(regionId);
    if (!Number.isInteger(id) || id <= 0) return null;
    return await db.prepare(`
      SELECT
        id,
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
        last_sync_started_at,
        last_sync_finished_at,
        last_sync_status,
        last_sync_error,
        last_successful_sync_at,
        next_sync_at,
        bounds_west,
        bounds_south,
        bounds_east,
        bounds_north,
        last_feature_count,
        updated_by,
        created_at,
        updated_at
      FROM data_sync_regions
      WHERE id = ?
      LIMIT 1
    `).get(id) || null;
  }

  async function getRegionById(regionId) {
    await ensureBootstrapped();
    return rowToRegion(await getRegionRowById(regionId));
  }

  async function listRegions(options = {}) {
    await ensureBootstrapped();
    const includeDisabled = options.includeDisabled !== false;
    const rows = await listRegionRows();
    return rows
      .map(rowToRegion)
      .filter((item) => includeDisabled || item.enabled);
  }

  async function getRecentRuns(regionId = null, limit = 25) {
    await ensureBootstrapped();
    const safeLimit = Math.max(1, Math.min(200, Number(limit) || 25));
    const rows = regionId == null
      ? await db.prepare(`
        SELECT
          id,
          region_id,
          status,
          trigger_reason,
          requested_by,
          requested_at,
          started_at,
          finished_at,
          error_text,
          imported_feature_count,
          active_feature_count,
          orphan_deleted_count,
          pmtiles_bytes,
          bounds_west,
          bounds_south,
          bounds_east,
          bounds_north,
          created_at,
          updated_at
        FROM data_region_sync_runs
        ORDER BY id DESC
        LIMIT ?
      `).all(safeLimit)
      : await db.prepare(`
        SELECT
          id,
          region_id,
          status,
          trigger_reason,
          requested_by,
          requested_at,
          started_at,
          finished_at,
          error_text,
          imported_feature_count,
          active_feature_count,
          orphan_deleted_count,
          pmtiles_bytes,
          bounds_west,
          bounds_south,
          bounds_east,
          bounds_north,
          created_at,
          updated_at
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
      SELECT
        id,
        region_id,
        status,
        trigger_reason,
        requested_by,
        requested_at,
        started_at,
        finished_at,
        error_text,
        imported_feature_count,
        active_feature_count,
        orphan_deleted_count,
        pmtiles_bytes,
        bounds_west,
        bounds_south,
        bounds_east,
        bounds_north,
        created_at,
        updated_at
      FROM data_region_sync_runs
      WHERE id = ?
      LIMIT 1
    `).get(Number(runId)) || null;
    return rowToRun(row);
  }

  async function countRegions() {
    const row = await db.prepare(`
      SELECT COUNT(*) AS total
      FROM data_sync_regions
    `).get();
    return Number(row?.total || 0);
  }

  async function countRegionMemberships(regionId) {
    const row = await db.prepare(`
      SELECT COUNT(*) AS total
      FROM data_region_memberships
      WHERE region_id = ?
    `).get(Number(regionId));
    return Number(row?.total || 0);
  }

  async function getBootstrapState() {
    const settingsRow = await readAppDataSettingsRow();
    return {
      completed: Number(settingsRow?.env_bootstrap_completed || 0) > 0,
      source: settingsRow?.env_bootstrap_source ? String(settingsRow.env_bootstrap_source) : null,
      updatedBy: settingsRow?.updated_by ? String(settingsRow.updated_by) : null,
      updatedAt: settingsRow?.updated_at ? String(settingsRow.updated_at) : null
    };
  }

  function parseStoredFilterTagAllowlist(raw) {
    if (raw == null || String(raw).trim() === '') return null;
    try {
      const parsed = JSON.parse(String(raw));
      return normalizeFilterTagKeyList(parsed);
    } catch {
      return null;
    }
  }

  async function getFilterTagAllowlistForAdmin() {
    const settingsRow = await readAppDataSettingsRow();
    const storedAllowlist = parseStoredFilterTagAllowlist(settingsRow?.filter_tag_allowlist_json);
    const allowlist = storedAllowlist || [...DEFAULT_FILTER_TAG_ALLOWLIST];
    return {
      source: storedAllowlist ? 'db' : 'default',
      allowlist,
      defaultAllowlist: [...DEFAULT_FILTER_TAG_ALLOWLIST],
      updatedBy: settingsRow?.updated_by ? String(settingsRow.updated_by) : null,
      updatedAt: settingsRow?.updated_at ? String(settingsRow.updated_at) : null
    };
  }

  async function getEffectiveFilterTagAllowlistConfig() {
    const current = await getFilterTagAllowlistForAdmin();
    return {
      allowlist: [...current.allowlist]
    };
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

  async function writeBootstrapState(source, actor = 'system') {
    const updatedBy = normalizeNullableText(actor, 160);
    await db.prepare(`
      INSERT INTO app_data_settings (
        id,
        env_bootstrap_completed,
        env_bootstrap_source,
        updated_by,
        updated_at
      )
      VALUES (1, 1, ?, ?, datetime('now'))
      ON CONFLICT(id) DO UPDATE SET
        env_bootstrap_completed = 1,
        env_bootstrap_source = excluded.env_bootstrap_source,
        updated_by = excluded.updated_by,
        updated_at = datetime('now')
    `).run(String(source || 'legacy-env'), updatedBy);
  }

  async function saveFilterTagAllowlist(input = [], actor = null) {
    await ensureBootstrapped();
    const settingsRow = await readAppDataSettingsRow();
    const updatedBy = normalizeNullableText(actor, 160);
    const normalizedAllowlist = normalizeFilterTagKeyList(input);
    await db.prepare(`
      INSERT INTO app_data_settings (
        id,
        env_bootstrap_completed,
        env_bootstrap_source,
        filter_tag_allowlist_json,
        updated_by,
        updated_at
      )
      VALUES (1, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(id) DO UPDATE SET
        filter_tag_allowlist_json = excluded.filter_tag_allowlist_json,
        updated_by = excluded.updated_by,
        updated_at = datetime('now')
    `).run(
      Number(settingsRow?.env_bootstrap_completed || 0) > 0 ? 1 : 0,
      settingsRow?.env_bootstrap_source ? String(settingsRow.env_bootstrap_source) : null,
      JSON.stringify(normalizedAllowlist),
      updatedBy
    );
    return getFilterTagAllowlistForAdmin();
  }

  async function bootstrapFromEnvIfNeeded(actor = 'system') {
    if (bootstrapPromise) return bootstrapPromise;

    bootstrapPromise = (async () => {
      const existingRegions = await countRegions();
      if (existingRegions > 0) {
        return {
          source: 'db',
          imported: false,
          regions: (await listRegionRows()).map(rowToRegion)
        };
      }

      const bootstrapState = await getBootstrapState();
      if (bootstrapState.completed) {
        return {
          source: 'db',
          imported: false,
          regions: (await listRegionRows()).map(rowToRegion)
        };
      }

      await writeBootstrapState('db-only', actor);
      return {
        source: 'db',
        imported: false,
        regions: (await listRegionRows()).map(rowToRegion)
      };
    })();

    try {
      return await bootstrapPromise;
    } finally {
      bootstrapPromise = null;
    }
  }

  async function ensureBootstrapped() {
    await bootstrapFromEnvIfNeeded('env-bootstrap');
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
    function buildDeleteResult(membershipCount, runCount, orphanDeletedCount) {
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

    function deleteRegionTxSync(txDb = db) {
      const membershipCount = Number((txDb.prepare(`
        SELECT COUNT(*) AS total
        FROM data_region_memberships
        WHERE region_id = ?
      `).get(existing.id))?.total || 0);
      const runCount = Number((txDb.prepare(`
        SELECT COUNT(*) AS total
        FROM data_region_sync_runs
        WHERE region_id = ?
      `).get(existing.id))?.total || 0);

      txDb.prepare(`
        DELETE FROM data_region_memberships
        WHERE region_id = ?
      `).run(existing.id);

      txDb.prepare(`
        DELETE FROM data_region_sync_runs
        WHERE region_id = ?
      `).run(existing.id);

      const orphanDeletedCount = Number((txDb.prepare(`
        DELETE FROM osm.building_contours
        WHERE NOT EXISTS (
          SELECT 1
          FROM data_region_memberships drm
          WHERE drm.osm_type = osm.building_contours.osm_type
            AND drm.osm_id = osm.building_contours.osm_id
        )
      `).run())?.changes || 0);

      const deleteResult = txDb.prepare(`
        DELETE FROM data_sync_regions
        WHERE id = ?
      `).run(existing.id);
      if (Number(deleteResult?.changes || 0) === 0) {
        throw new Error('Регион уже был удалён');
      }

      return buildDeleteResult(membershipCount, runCount, orphanDeletedCount);
    }

    async function deleteRegionTxAsync(txDb = db) {
      const membershipCount = Number((await txDb.prepare(`
        SELECT COUNT(*) AS total
        FROM data_region_memberships
        WHERE region_id = ?
      `).get(existing.id))?.total || 0);
      const runCount = Number((await txDb.prepare(`
        SELECT COUNT(*) AS total
        FROM data_region_sync_runs
        WHERE region_id = ?
      `).get(existing.id))?.total || 0);

      await txDb.prepare(`
        DELETE FROM data_region_memberships
        WHERE region_id = ?
      `).run(existing.id);

      await txDb.prepare(`
        DELETE FROM data_region_sync_runs
        WHERE region_id = ?
      `).run(existing.id);

      const orphanDeletedCount = Number((await txDb.prepare(`
        DELETE FROM osm.building_contours
        WHERE NOT EXISTS (
          SELECT 1
          FROM data_region_memberships drm
          WHERE drm.osm_type = osm.building_contours.osm_type
            AND drm.osm_id = osm.building_contours.osm_id
        )
      `).run())?.changes || 0);

      if (txDb.provider === 'postgres') {
        await txDb.prepare(`
          INSERT INTO osm.building_contours_summary (singleton_id, total, last_updated, refreshed_at)
          SELECT 1, COUNT(*)::bigint, MAX(updated_at), NOW()
          FROM osm.building_contours
          ON CONFLICT (singleton_id) DO UPDATE SET
            total = EXCLUDED.total,
            last_updated = EXCLUDED.last_updated,
            refreshed_at = EXCLUDED.refreshed_at
        `).run();
      }

      const deleteResult = await txDb.prepare(`
        DELETE FROM data_sync_regions
        WHERE id = ?
      `).run(existing.id);
      if (Number(deleteResult?.changes || 0) === 0) {
        throw new Error('Регион уже был удалён');
      }

      return buildDeleteResult(membershipCount, runCount, orphanDeletedCount);
    }

    if (typeof db.withNativeTransaction === 'function') {
      return db.withNativeTransaction(async (nativeDb) => deleteRegionTxAsync(nativeDb))();
    }

    if (db.provider !== 'postgres') {
      const tx = db.transaction(() => deleteRegionTxSync(db));
      return tx();
    }

    const tx = db.transaction(() => deleteRegionTxAsync(db));
    return tx();
  }

  async function getDataSettingsForAdmin() {
    await ensureBootstrapped();
    const bootstrap = await getBootstrapState();
    const regions = await listRegions();
    const filterTags = await getFilterTagAllowlistForAdmin();
    return {
      source: 'db',
      bootstrap,
      regions,
      filterTags
    };
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

  async function createQueuedRun(regionId, triggerReason = 'manual', requestedBy = null) {
    await ensureBootstrapped();
    const region = await getRegionById(regionId);
    if (!region) {
      throw new Error('Регион не найден');
    }
    if (!region.enabled) {
      throw new Error('Синхронизация доступна только для enabled региона');
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
    slugify,
    normalizeBounds,
    normalizeRegionInput,
    computeNextSyncAt,
    getBootstrapState,
    bootstrapFromEnvIfNeeded,
    listRegions,
    getRegionById,
    saveRegion,
    deleteRegion,
    getDataSettingsForAdmin,
    getFilterTagAllowlistForAdmin,
    getEffectiveFilterTagAllowlistConfig,
    saveFilterTagAllowlist,
    listRuntimePmtilesRegions,
    getRecentRuns,
    getRunById,
    createQueuedRun,
    markRunStarted,
    markRunSucceeded,
    markRunFailed,
    recoverInterruptedRuns,
    refreshRegionNextSyncAt,
    refreshAllNextSyncAt,
    validateOverlap
  };
}

module.exports = {
  createDataSettingsService,
  normalizeRegionPmtilesSlug,
  buildLegacyRegionPmtilesFileName,
  buildRegionPmtilesFileName,
  resolveLegacyRegionPmtilesPath,
  resolveRegionPmtilesPath,
  resolveExistingRegionPmtilesPath
};
