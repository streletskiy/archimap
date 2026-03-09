const RUN_SELECT_FIELDS = `
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
`;

function wrapRawSqliteDb(rawDb) {
  let txQueue = Promise.resolve();

  return {
    provider: 'sqlite',
    prepare(sql) {
      const statement = rawDb.prepare(String(sql || ''));
      return {
        get: (...args) => statement.get(...args),
        all: (...args) => statement.all(...args),
        run: (...args) => statement.run(...args)
      };
    },
    exec(sql) {
      return rawDb.exec(String(sql || ''));
    },
    transaction(fn) {
      return async (...args) => {
        const run = async () => {
          rawDb.exec('BEGIN');
          try {
            const result = await fn(...args);
            rawDb.exec('COMMIT');
            return result;
          } catch (error) {
            try {
              rawDb.exec('ROLLBACK');
            } catch {
              // ignore rollback cleanup errors to keep original failure
            }
            throw error;
          }
        };

        const execution = txQueue.then(run, run);
        txQueue = execution.catch(() => {});
        return execution;
      };
    }
  };
}

function ensureCompatDb(db) {
  if (db && typeof db.prepare === 'function' && typeof db.transaction === 'function' && typeof db.provider === 'string') {
    return db;
  }
  if (db && typeof db.prepare === 'function' && typeof db.transaction === 'function') {
    return wrapRawSqliteDb(db);
  }
  throw new Error('createDataSettingsService: db is required');
}

function createDataSettingsContext(options = {}) {
  const db = ensureCompatDb(options.db);
  const dataDir = String(options.dataDir || '');
  const now = typeof options.now === 'function'
    ? options.now
    : () => new Date();

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

  const fallback = normalizeFallbackData(options.fallbackData);

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
      pmtilesBytes: row.pmtiles_bytes == null ? null : Number(row.pmtiles_bytes),
      dbBytes: row.db_bytes == null ? null : Number(row.db_bytes),
      dbBytesApproximate: Boolean(row.db_bytes_approximate),
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

  return {
    db,
    dataDir,
    now,
    fallback,
    normalizeBoolean,
    normalizeNullableText,
    normalizeInteger,
    normalizeSourceLayer,
    slugify,
    normalizeBounds,
    boundsFromRow,
    boundsOverlap,
    toIsoOrNull,
    computeNextSyncAt,
    rowToRegion,
    rowToRun,
    readAppDataSettingsRow,
    listRegionRows,
    getRegionRowById,
    countRegions,
    countRegionMemberships,
    state: {
      bootstrapPromise: null
    }
  };
}

module.exports = {
  RUN_SELECT_FIELDS,
  createDataSettingsContext
};
