const {
  DEFAULT_FILTER_TAG_ALLOWLIST,
  normalizeFilterTagKeyList
} = require('./filter-tags.service');
const path = require('path');
const { createDataSettingsContext } = require('./data-settings/shared');
const { createBootstrapDomain } = require('./data-settings/bootstrap');
const { createExtractsDomain } = require('./data-settings/extracts');
const { createRegionsDomain } = require('./data-settings/regions');
const { createSyncRunsDomain } = require('./data-settings/sync-runs');
const { createPresetsDomain } = require('./data-settings/presets');
const { createPythonExtractResolver } = require('../../../../scripts/region-sync/python-extractor');

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
  const context = createDataSettingsContext({
    ...options,
    extractResolver: options.extractResolver || createPythonExtractResolver({
      importerPath: path.resolve(__dirname, '../../../../scripts/sync-osm-buildings.py')
    })
  });
  const {
    db,
    dataDir,
    readAppDataSettingsRow,
    normalizeNullableText,
    computeRegionDbBytes
  } = context;

  const bootstrapDomain = createBootstrapDomain(context);
  Object.assign(context, bootstrapDomain);

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

  async function saveFilterTagAllowlist(input = [], actor = null) {
    await bootstrapDomain.ensureBootstrapped();
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

  async function getLatestStorageStatsByRegionId() {
    let rows = [];
    try {
      rows = await db.prepare(`
        SELECT runs.region_id, runs.pmtiles_bytes, runs.db_bytes, runs.db_bytes_approximate
        FROM data_region_sync_runs runs
        INNER JOIN (
          SELECT region_id, MAX(id) AS latest_id
          FROM data_region_sync_runs
          GROUP BY region_id
        ) latest
          ON latest.latest_id = runs.id
      `).all();
    } catch {
      rows = [];
    }
    const map = new Map();
    for (const row of Array.isArray(rows) ? rows : []) {
      const regionId = Number(row?.region_id || 0);
      if (!Number.isInteger(regionId) || regionId <= 0) continue;
      map.set(regionId, {
        pmtilesBytes: row?.pmtiles_bytes == null ? null : Number(row.pmtiles_bytes),
        dbBytes: row?.db_bytes == null ? null : Number(row.db_bytes),
        dbBytesApproximate: Boolean(row?.db_bytes_approximate)
      });
    }
    return map;
  }

  function resolveStoredPmtilesBytes(region, fallbackBytes = null) {
    if (dataDir) {
      const fs = require('fs');
      const pmtilesPath = resolveExistingRegionPmtilesPath(dataDir, region);
      if (pmtilesPath) {
        try {
          return Number(fs.statSync(pmtilesPath).size || 0);
        } catch {
          // fall through to persisted bytes
        }
      }
    }
    return fallbackBytes == null ? null : Number(fallbackBytes);
  }

  async function enrichRegionsWithStorageStats(regions = []) {
    const items = Array.isArray(regions) ? regions : [];
    if (items.length === 0) return [];

    const storageStatsByRegionId = await getLatestStorageStatsByRegionId();
    const computedStorageStatsByRegionId = new Map(
      await Promise.all(
        items.map(async (region) => {
          if (storageStatsByRegionId.has(region.id)) {
            return [region.id, null];
          }
          return [region.id, await computeRegionDbBytes(region.id)];
        })
      )
    );

    return items.map((region) => {
      const stats = storageStatsByRegionId.get(region.id)
        || computedStorageStatsByRegionId.get(region.id)
        || {};
      return {
        ...region,
        pmtilesBytes: resolveStoredPmtilesBytes(region, stats.pmtilesBytes ?? null),
        dbBytes: stats.dbBytes ?? 0,
        dbBytesApproximate: stats.dbBytesApproximate ?? false
      };
    });
  }

  context.enrichRegionsWithStorageStats = enrichRegionsWithStorageStats;

  const extractsDomain = createExtractsDomain(context);
  Object.assign(context, extractsDomain);

  const regionsDomain = createRegionsDomain(context);
  Object.assign(context, regionsDomain);

  const syncRunsDomain = createSyncRunsDomain(context);
  const presetsDomain = createPresetsDomain(context);

  async function getDataSettingsForAdmin() {
    await bootstrapDomain.ensureBootstrapped();
    const bootstrap = await bootstrapDomain.getBootstrapState();
    const regions = await regionsDomain.listRegions({ includeStorageStats: true });
    const filterTags = await getFilterTagAllowlistForAdmin();
    const filterPresets = await presetsDomain.getFilterPresetsForAdmin();
    return {
      source: 'db',
      bootstrap,
      regions,
      filterTags,
      filterPresets
    };
  }

  return {
    slugify: context.slugify,
    normalizeBounds: context.normalizeBounds,
    normalizeRegionInput: regionsDomain.normalizeRegionInput,
    computeNextSyncAt: context.computeNextSyncAt,
    getBootstrapState: bootstrapDomain.getBootstrapState,
    bootstrapFromEnvIfNeeded: bootstrapDomain.bootstrapFromEnvIfNeeded,
    listRegions: regionsDomain.listRegions,
    getRegionById: regionsDomain.getRegionById,
    searchExtractCandidates: extractsDomain.searchExtractCandidates,
    saveRegion: regionsDomain.saveRegion,
    deleteRegion: regionsDomain.deleteRegion,
    getDataSettingsForAdmin,
    getFilterTagAllowlistForAdmin,
    getEffectiveFilterTagAllowlistConfig,
    saveFilterTagAllowlist,
    listRuntimePmtilesRegions: regionsDomain.listRuntimePmtilesRegions,
    getFilterPresetsForAdmin: presetsDomain.getFilterPresetsForAdmin,
    getFilterPresetsForRuntime: presetsDomain.getFilterPresetsForRuntime,
    saveFilterPreset: presetsDomain.saveFilterPreset,
    deleteFilterPresetById: presetsDomain.deleteFilterPresetById,
    getRecentRuns: syncRunsDomain.getRecentRuns,
    getRunById: syncRunsDomain.getRunById,
    createQueuedRun: syncRunsDomain.createQueuedRun,
    markRunStarted: syncRunsDomain.markRunStarted,
    markRunSucceeded: syncRunsDomain.markRunSucceeded,
    markRunFailed: syncRunsDomain.markRunFailed,
    recoverInterruptedRuns: syncRunsDomain.recoverInterruptedRuns,
    refreshRegionNextSyncAt: syncRunsDomain.refreshRegionNextSyncAt,
    refreshAllNextSyncAt: syncRunsDomain.refreshAllNextSyncAt,
    validateOverlap: regionsDomain.validateOverlap
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
