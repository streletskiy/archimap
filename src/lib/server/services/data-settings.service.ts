const { DEFAULT_FILTER_TAG_ALLOWLIST, normalizeFilterTagKeyList } = require('./filter-tags.service');
const { createDataSettingsContext } = require('./data-settings/shared');
const { createBootstrapDomain } = require('./data-settings/bootstrap');
const { createExtractsDomain } = require('./data-settings/extracts');
const { createRegionCatalog } = require('./data-settings/region-catalog');
const { createRegionsDomain } = require('./data-settings/regions');
const { createSyncRunsDomain } = require('./data-settings/sync-runs');
const { createUpstreamDomain } = require('./data-settings/upstream');
const { createPresetsDomain } = require('./data-settings/presets');
import type { AdminDataSettings, Region } from '$shared/types';

function normalizeRegionPmtilesSlug(regionOrSlug) {
  const raw = typeof regionOrSlug === 'object' && regionOrSlug ? regionOrSlug.slug : regionOrSlug;
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

function createDataSettingsService(options: LooseRecord = {}) {
  const { createCountrySubregionsCatalog } = require('./data-settings/country-subregions');
  const regionCatalog = options.regionCatalog || createRegionCatalog(options);
  const countrySubregionsCatalog =
    options.countrySubregionsCatalog ||
    createCountrySubregionsCatalog({
      ...options,
      regionCatalog
    });
  const context = createDataSettingsContext({
    ...options,
    regionCatalog,
    extractResolver: options.extractResolver || null
  });
  context.countrySubregionsCatalog = countrySubregionsCatalog;
  const { db, dataDir, readAppDataSettingsRow, normalizeNullableText, computeRegionDbBytes } = context;

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
      availableKeys: [],
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
    await db
      .prepare(
        `
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
    `
      )
      .run(
        Number(settingsRow?.env_bootstrap_completed || 0) > 0 ? 1 : 0,
        settingsRow?.env_bootstrap_source ? String(settingsRow.env_bootstrap_source) : null,
        JSON.stringify(normalizedAllowlist),
        updatedBy
      );
    return getFilterTagAllowlistForAdmin();
  }

  async function getLatestStorageStatsByRegionId() {
    let rows: LooseRecord[];
    try {
      rows = await db
        .prepare(
          `
        SELECT runs.region_id, runs.pmtiles_bytes, runs.db_bytes, runs.db_bytes_approximate
        FROM data_region_sync_runs runs
        INNER JOIN (
          SELECT region_id, MAX(id) AS latest_id
          FROM data_region_sync_runs
          GROUP BY region_id
        ) latest
          ON latest.latest_id = runs.id
      `
        )
        .all();
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

  async function enrichRegionsWithStorageStats(regions: Region[] = []): Promise<Region[]> {
    const items = Array.isArray(regions) ? regions : [];
    if (items.length === 0) return [];

    const storageStatsByRegionId = await getLatestStorageStatsByRegionId();
    const computedStorageStatsByRegionId = new Map(
      await Promise.all(
        items.map(async (region) => {
          const value = storageStatsByRegionId.has(region.id) ? null : await computeRegionDbBytes(region.id);
          return [region.id, value] as const;
        })
      )
    );

    return items.map((region) => {
      const stats = storageStatsByRegionId.get(region.id) || computedStorageStatsByRegionId.get(region.id) || {};
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

  const upstreamDomain = createUpstreamDomain(context);
  Object.assign(context, upstreamDomain);

  const syncRunsDomain = createSyncRunsDomain(context);
  const presetsDomain = createPresetsDomain(context);

  async function mapWithConcurrency(items = [], limit = 4, iteratee = async (value, _index) => value) {
    const source = Array.isArray(items) ? items : [];
    if (source.length === 0) return [];
    const normalizedLimit = Math.max(1, Math.min(16, Math.trunc(Number(limit) || 4)));
    const results = new Array(source.length);
    let nextIndex = 0;

    const workers = Array.from({ length: Math.min(normalizedLimit, source.length) }, async () => {
      while (true) {
        const currentIndex = nextIndex;
        nextIndex += 1;
        if (currentIndex >= source.length) return;
        results[currentIndex] = await iteratee(source[currentIndex], currentIndex);
      }
    });

    await Promise.all(workers);
    return results;
  }

  async function getDataSettingsForAdmin(): Promise<AdminDataSettings> {
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

  async function getRegionsUpstreamState(regionIds = [], options: LooseRecord = {}): Promise<Region[]> {
    await bootstrapDomain.ensureBootstrapped();
    const normalizedIds = [
      ...new Set(
        (Array.isArray(regionIds) ? regionIds : [])
          .map((value) => Number(value))
          .filter((value) => Number.isInteger(value) && value > 0)
      )
    ];
    if (normalizedIds.length === 0) {
      return [];
    }

    const items = await mapWithConcurrency(normalizedIds, 4, async (regionId) =>
      upstreamDomain.getRegionUpstreamState(regionId, options)
    );

    return items.filter((item): item is Region => Boolean(item));
  }

  return {
    slugify: context.slugify,
    normalizeBounds: context.normalizeBounds,
    normalizeRegionInput: regionsDomain.normalizeRegionInput,
    computeNextSyncAt: context.computeNextSyncAt,
    getBootstrapState: bootstrapDomain.getBootstrapState,
    bootstrapFromEnvIfNeeded: bootstrapDomain.bootstrapFromEnvIfNeeded,
    listRegions: regionsDomain.listRegions,
    listRegionTree: regionsDomain.listRegionTree,
    listSubregions: regionsDomain.listSubregions,
    getRegionById: regionsDomain.getRegionById,
    searchExtractCandidates: extractsDomain.searchExtractCandidates,
    saveRegion: regionsDomain.saveRegion,
    createCountryAggregate: regionsDomain.createCountryAggregate,
    listCountryCatalog: async () => countrySubregionsCatalog.getCountries(),
    deleteRegion: regionsDomain.deleteRegion,
    getDataSettingsForAdmin,
    getRegionsUpstreamState,
    getFilterTagAllowlistForAdmin,
    getEffectiveFilterTagAllowlistConfig,
    saveFilterTagAllowlist,
    listRuntimePmtilesRegions: regionsDomain.listRuntimePmtilesRegions,
    getFilterPresetsForAdmin: presetsDomain.getFilterPresetsForAdmin,
    getFilterPresetsForRuntime: presetsDomain.getFilterPresetsForRuntime,
    saveFilterPreset: presetsDomain.saveFilterPreset,
    deleteFilterPresetById: presetsDomain.deleteFilterPresetById,
    getRegionUpstreamState: upstreamDomain.getRegionUpstreamState,
    getRecentRuns: syncRunsDomain.getRecentRuns,
    getRunById: syncRunsDomain.getRunById,
    createQueuedRun: syncRunsDomain.createQueuedRun,
    markRunStarted: syncRunsDomain.markRunStarted,
    markRunSucceeded: syncRunsDomain.markRunSucceeded,
    markRunFailed: syncRunsDomain.markRunFailed,
    markRunCancelRequested: syncRunsDomain.markRunCancelRequested,
    abandonActiveRunsForRegion: syncRunsDomain.abandonActiveRunsForRegion,
    updateRunStage: syncRunsDomain.updateRunStage,
    touchRunHeartbeat: syncRunsDomain.touchRunHeartbeat,
    recoverInterruptedRuns: syncRunsDomain.recoverInterruptedRuns,
    rescheduleRegionAfterSkippedSync: syncRunsDomain.rescheduleRegionAfterSkippedSync,
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
