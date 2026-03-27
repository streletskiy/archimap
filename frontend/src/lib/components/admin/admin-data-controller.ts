import { derived, get, writable, type Writable } from 'svelte/store';

import { translateNow } from '$lib/i18n/index';
import { DEFAULT_LOCALE, SUPPORTED_LOCALES } from '$lib/i18n/config';
import { apiJson } from '$lib/services/http';
import { createBuildingFilterLayerDraft } from '$lib/stores/filters';
import { normalizeFilterLayers } from '$lib/components/map/filter-pipeline-utils';
import { createFilterSettingsController as createFilterSettingsControllerModule } from './filter-settings-controller';
import { createFilterPresetController as createFilterPresetControllerModule } from './filter-preset-controller';
import { createMapRegionController as createMapRegionControllerModule } from './region-controller';
import type {
  AdminDataSettings,
  FilterPreset as ApiFilterPreset,
  FilterPresetDraft as SharedFilterPresetDraft,
  FilterPresetLayer,
  FilterPresetRule,
  FilterPresetState,
  Region as DataRegion,
  RegionDraft as SharedRegionDraft,
  RegionExtractCandidate
} from '$shared/types';

const DATA_I18N_PREFIX = 'admin.data';
const FILTER_PRESET_LOCALE_RE = /^[a-z]{2,8}(?:-[a-z0-9]{2,8})*$/i;
const FILTER_PRESET_NAME_LOCALES = Object.freeze([...(Array.isArray(SUPPORTED_LOCALES) ? SUPPORTED_LOCALES : [])]);

const msg = (error, fallback) => String(error?.message || fallback);
const dataT = (key, params = {}) => translateNow(`${DATA_I18N_PREFIX}.${key}`, params);

function createEmptyDataSettings(): AdminDataSettings {
  return {
    source: 'db',
    bootstrap: { completed: false, source: null },
    regions: [],
    filterTags: {
      source: 'default',
      allowlist: [],
      defaultAllowlist: [],
      availableKeys: [],
      updatedBy: null,
      updatedAt: null
    },
    filterPresets: createEmptyFilterPresetState()
  };
}

function createRegionDraft(region: Partial<DataRegion> | null = null): SharedRegionDraft {
  return {
    id: Number(region?.id || 0) || null,
    name: String(region?.name || ''),
    slug: String(region?.slug || ''),
    searchQuery: String(region?.searchQuery || ''),
    extractSource: String(region?.extractSource || ''),
    extractId: String(region?.extractId || ''),
    extractLabel: String(region?.extractLabel || ''),
    extractResolutionStatus: String(region?.extractResolutionStatus || 'needs_resolution') as SharedRegionDraft['extractResolutionStatus'],
    extractResolutionError: region?.extractResolutionError ? String(region.extractResolutionError) : null,
    enabled: region?.enabled !== false,
    autoSyncEnabled: region?.autoSyncEnabled !== false,
    autoSyncOnStart: Boolean(region?.autoSyncOnStart),
    autoSyncIntervalHours: Number(region?.autoSyncIntervalHours ?? 168) || 0,
    pmtilesMinZoom: Number(region?.pmtilesMinZoom ?? 13) || 0,
    pmtilesMaxZoom: Number(region?.pmtilesMaxZoom ?? 16) || 0,
    sourceLayer: String(region?.sourceLayer || 'buildings')
  };
}

type DataSettings = AdminDataSettings;
type RegionDraft = SharedRegionDraft;
type FilterPresetItem = SharedFilterPresetDraft;
type FilterPresetDraft = SharedFilterPresetDraft;
function normalizeFilterPresetKey(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

function normalizeFilterPresetLocale(locale) {
  const normalized = String(locale || '')
    .trim()
    .toLowerCase()
    .replace(/_/g, '-')
    .slice(0, 32);
  if (!normalized) return '';
  if (!FILTER_PRESET_LOCALE_RE.test(normalized)) return '';
  return normalized;
}

function normalizeFilterPresetName(value) {
  return String(value || '').trim().slice(0, 160);
}

function normalizeFilterPresetNameI18n(nameI18n = null, fallbackName = '') {
  const source = nameI18n && typeof nameI18n === 'object' && !Array.isArray(nameI18n) ? nameI18n : {};
  const normalized: Record<string, string> = {};
  for (const [rawLocale, rawName] of Object.entries(source)) {
    const locale = normalizeFilterPresetLocale(rawLocale);
    if (!locale) continue;
    const name = normalizeFilterPresetName(rawName);
    if (!name) continue;
    normalized[locale] = name;
  }

  const fallback = normalizeFilterPresetName(fallbackName);
  if (fallback && !normalized[DEFAULT_LOCALE]) {
    normalized[DEFAULT_LOCALE] = fallback;
  }
  return normalized;
}

function getPreferredFilterPresetName(nameI18n = null, fallback = '') {
  const source = nameI18n && typeof nameI18n === 'object' ? nameI18n as Record<string, string> : {};
  const defaultName = normalizeFilterPresetName(source?.[DEFAULT_LOCALE]);
  if (defaultName) return defaultName;

  for (const locale of FILTER_PRESET_NAME_LOCALES) {
    const name = normalizeFilterPresetName(source?.[locale]);
    if (name) return name;
  }

  for (const value of Object.values(source)) {
    const name = normalizeFilterPresetName(value);
    if (name) return name;
  }

  return normalizeFilterPresetName(fallback);
}

function normalizeFilterPresetRule(rule: Partial<FilterPresetRule> | LooseRecord = {}, options: { preserveId?: boolean } = {}): FilterPresetRule {
  const normalized: FilterPresetRule = {
    key: String(rule?.key || '').trim(),
    op: String(rule?.op || 'contains').trim() as FilterPresetRule['op'],
    value: String(rule?.value || '').trim()
  };

  if (options.preserveId === true) {
    const ruleId = String(rule?.id || '').trim();
    if (ruleId) {
      normalized.id = ruleId;
    }
  }

  return normalized;
}

function normalizeFilterPresetLayersForDraft(layers: Array<Partial<FilterPresetLayer> | LooseRecord> = []): FilterPresetLayer[] {
  const source = Array.isArray(layers) ? layers : [];
  if (source.length === 0) {
    return [createBuildingFilterLayerDraft()];
  }
  return source.map((layer, index, list) => createBuildingFilterLayerDraft({
    ...layer,
    priority: Number.isFinite(Number(layer?.priority)) ? Number(layer.priority) : index,
    rules: Array.isArray(layer?.rules) && layer.rules.length > 0
      ? layer.rules.map((rule) => normalizeFilterPresetRule(rule, { preserveId: true }))
      : [normalizeFilterPresetRule({}, { preserveId: true })]
  }, list.slice(0, index)));
}

function normalizeFilterPresetLayersForSave(layers: Array<Partial<FilterPresetLayer> | LooseRecord> = []) {
  const normalized = normalizeFilterLayers(Array.isArray(layers) ? (layers as LooseRecord[]) : [], { preserveEmpty: false });
  if (normalized.invalidReason) {
    return {
      layers: [],
      error: normalized.invalidReason
    };
  }
  if (normalized.layers.length === 0) {
    return {
      layers: [],
      error: dataT('filterPresets.errors.emptyLayers')
    };
  }
  return {
    layers: normalized.layers.map((layer, index) => ({
      id: String(layer?.id || `filter-layer-${index + 1}`),
      color: String(layer?.color || '').trim(),
      priority: index,
      mode: String(layer?.mode || 'layer').trim() as FilterPresetLayer['mode'],
      rules: (Array.isArray(layer?.rules) ? layer.rules : []).map((rule) => normalizeFilterPresetRule(rule))
    })),
    error: null
  };
}

function normalizeFilterPresetItem(preset: ApiFilterPreset | SharedFilterPresetDraft | LooseRecord | null = null): FilterPresetItem {
  const source = (preset && typeof preset === 'object' ? preset : {}) as Partial<FilterPresetItem> & LooseRecord;
  const id = Number(source?.id || 0);
  const nameI18n = normalizeFilterPresetNameI18n(source?.nameI18n, source?.name);
  const name = normalizeFilterPresetName(source?.name) || getPreferredFilterPresetName(nameI18n);
  return {
    id: Number.isInteger(id) && id > 0 ? id : null,
    key: normalizeFilterPresetKey(source?.key || ''),
    name,
    nameI18n,
    description: source?.description == null ? '' : String(source.description),
    layers: normalizeFilterPresetLayersForDraft(source?.layers),
    createdAt: source?.createdAt ? String(source.createdAt) : null,
    updatedAt: source?.updatedAt ? String(source.updatedAt) : null,
    updatedBy: source?.updatedBy ? String(source.updatedBy) : null
  };
}

function buildFilterPresetDraftRecord(draft: FilterPresetDraft | null = null): FilterPresetDraft {
  const source = (draft && typeof draft === 'object' ? draft : {}) as Partial<FilterPresetDraft> & LooseRecord;
  return normalizeFilterPresetItem(source);
}

function createFilterPresetDraft(preset: FilterPresetDraft | null = null): FilterPresetDraft {
  return buildFilterPresetDraftRecord(preset);
}

function createEmptyFilterPresetState(): FilterPresetState {
  return {
    source: 'db',
    items: []
  };
}

function normalizeDataSettings(nextSettings, fallback): DataSettings {
  const value = (nextSettings && typeof nextSettings === 'object' ? nextSettings : fallback) as Partial<DataSettings> & LooseRecord;
  return {
    source: String(value?.source || 'db'),
    bootstrap: {
      completed: Boolean(value?.bootstrap?.completed),
      source: value?.bootstrap?.source ? String(value.bootstrap.source) : null
    },
    regions: Array.isArray(value?.regions) ? (value.regions as DataRegion[]) : [],
    filterTags: {
      source: String(value?.filterTags?.source || 'default'),
      allowlist: Array.isArray(value?.filterTags?.allowlist) ? value.filterTags.allowlist : [],
      defaultAllowlist: Array.isArray(value?.filterTags?.defaultAllowlist) ? value.filterTags.defaultAllowlist : [],
      availableKeys: Array.isArray(value?.filterTags?.availableKeys) ? value.filterTags.availableKeys : [],
      updatedBy: value?.filterTags?.updatedBy ? String(value.filterTags.updatedBy) : null,
      updatedAt: value?.filterTags?.updatedAt ? String(value.filterTags.updatedAt) : null
    },
    filterPresets: {
      source: String(value?.filterPresets?.source || 'db'),
      items: Array.isArray(value?.filterPresets?.items)
        ? value.filterPresets.items.map((item) => normalizeFilterPresetItem(item)).filter((item) => item.id != null)
        : []
    }
  };
}

function normalizeStorageBytes(value) {
  const bytes = Number(value);
  return Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
}

function buildStorageSummary(regions = []) {
  return (Array.isArray(regions) ? regions : []).reduce(
    (summary, region) => ({
      totalPmtilesBytes: summary.totalPmtilesBytes + normalizeStorageBytes(region?.pmtilesBytes),
      totalDbBytes: summary.totalDbBytes + normalizeStorageBytes(region?.dbBytes),
      totalDbBytesApproximate: summary.totalDbBytesApproximate || Boolean(region?.dbBytesApproximate)
    }),
    {
      totalPmtilesBytes: 0,
      totalDbBytes: 0,
      totalDbBytesApproximate: false
    }
  );
}

function getSavedFilterTagAllowlist(dataSettings: DataSettings) {
  return Array.isArray(dataSettings?.filterTags?.allowlist) ? dataSettings.filterTags.allowlist : [];
}

function buildFilterTagDraftStateByKey(
  keys: readonly string[] = [],
  saved: readonly string[] = [],
  draft: readonly string[] = []
): Record<string, 'enabled_pending' | 'disabled_pending' | 'unchanged'> {
  const result: Record<string, 'enabled_pending' | 'disabled_pending' | 'unchanged'> = {};
  const savedSet = new Set(Array.isArray(saved) ? saved : []);
  const draftSet = new Set(Array.isArray(draft) ? draft : []);

  for (const rawKey of Array.isArray(keys) ? keys : []) {
    const key = String(rawKey || '').trim();
    if (!key) continue;
    if (draftSet.has(key) && !savedSet.has(key)) {
      result[key] = 'enabled_pending';
      continue;
    }
    if (!draftSet.has(key) && savedSet.has(key)) {
      result[key] = 'disabled_pending';
      continue;
    }
    result[key] = 'unchanged';
  }

  return result;
}

function sortFilterTagKeys(keys: readonly string[] = [], selected: readonly string[] = []) {
  const selectedSet = new Set(Array.isArray(selected) ? selected : []);
  return [...(Array.isArray(keys) ? keys : [])].sort((left, right) => {
    const leftSelected = selectedSet.has(left);
    const rightSelected = selectedSet.has(right);
    if (leftSelected !== rightSelected) return leftSelected ? -1 : 1;
    return String(left || '').localeCompare(String(right || ''), 'en', { sensitivity: 'base' });
  });
}

export function createAdminDataController() {
  const dataSettings: Writable<DataSettings> = writable(createEmptyDataSettings());
  const dataLoading: Writable<boolean> = writable(false);
  const dataStatus: Writable<string> = writable('');
  const filterTagAllowlistDraft: Writable<string[]> = writable([]);
  const filterTagAllowlistSaving: Writable<boolean> = writable(false);
  const filterPresetItems: Writable<FilterPresetItem[]> = writable([]);
  const selectedFilterPresetId: Writable<number | null> = writable(null);
  const filterPresetDraft: Writable<FilterPresetDraft> = writable(createFilterPresetDraft());
  const filterPresetLoading: Writable<boolean> = writable(false);
  const filterPresetSaving: Writable<boolean> = writable(false);
  const filterPresetDeleting: Writable<boolean> = writable(false);
  const regionDraft: Writable<RegionDraft> = writable(createRegionDraft());
  const regionSaving: Writable<boolean> = writable(false);
  const regionDeleting: Writable<boolean> = writable(false);
  const regionSyncBusy: Writable<boolean> = writable(false);
  const regionResolveBusy: Writable<boolean> = writable(false);
  const regionExtractCandidates: Writable<RegionExtractCandidate[]> = writable([]);
  const selectedDataRegionId: Writable<number | null> = writable(null);
  const regionRuns: Writable<LooseRecord[]> = writable([]);
  const regionRunsLoading: Writable<boolean> = writable(false);
  const regionRunsStatus: Writable<string> = writable('');
  const regionRunsPage: Writable<number> = writable(1);
  const regionRunsPageCount: Writable<number> = writable(0);
  const regionRunsTotal: Writable<number> = writable(0);
  const regionEditorOpen: Writable<boolean> = writable(false);
  const initialized: Writable<boolean> = writable(false);
  const REGION_RUNS_PAGE_SIZE = 20;
  let nextOptimisticRegionId = -1;
  let regionRunsRequestToken = 0;
  const pendingOptimisticRegions = new Map();

  const sortedAvailableFilterTagKeys = derived(dataSettings, ($dataSettings) =>
    sortFilterTagKeys($dataSettings?.filterTags?.availableKeys, getSavedFilterTagAllowlist($dataSettings))
  );

  const storageSummary = derived(dataSettings, ($dataSettings) => buildStorageSummary($dataSettings?.regions));

  const filterTagDraftStateByKey = derived(
    [dataSettings, filterTagAllowlistDraft],
    ([$dataSettings, $filterTagAllowlistDraft]) =>
      buildFilterTagDraftStateByKey(
        $dataSettings?.filterTags?.availableKeys,
        getSavedFilterTagAllowlist($dataSettings),
        $filterTagAllowlistDraft
      )
  );

  const filterTagAllowlistDirty = derived(
    [dataSettings, filterTagAllowlistDraft],
    ([$dataSettings, $filterTagAllowlistDraft]) => {
      const saved = [...getSavedFilterTagAllowlist($dataSettings)].sort();
      const draft = [...$filterTagAllowlistDraft].sort();
      return JSON.stringify(saved) !== JSON.stringify(draft);
    }
  );

  const selectedFilterPreset = derived(
    [filterPresetItems, selectedFilterPresetId],
    ([$filterPresetItems, $selectedFilterPresetId]) => (
      (Array.isArray($filterPresetItems) ? $filterPresetItems : [])
        .find((item) => Number(item?.id || 0) === Number($selectedFilterPresetId || 0))
      || null
    )
  );

  const filterPresetDraftCanonical = derived(filterPresetDraft, ($filterPresetDraft) => {
    const nameI18n = normalizeFilterPresetNameI18n($filterPresetDraft?.nameI18n, $filterPresetDraft?.name);
    const name = normalizeFilterPresetName($filterPresetDraft?.name) || getPreferredFilterPresetName(nameI18n);
    const payload = normalizeFilterPresetLayersForSave($filterPresetDraft?.layers);
    return {
      ...($filterPresetDraft?.id ? { id: Number($filterPresetDraft.id) } : {}),
      key: normalizeFilterPresetKey($filterPresetDraft?.key || name || ''),
      name,
      nameI18n,
      description: String($filterPresetDraft?.description || '').trim() || null,
      layers: payload.layers,
      createdAt: $filterPresetDraft?.createdAt || null,
      updatedAt: $filterPresetDraft?.updatedAt || null,
      updatedBy: $filterPresetDraft?.updatedBy || null
    };
  });

  const filterPresetDraftJsonPreview = derived(
    filterPresetDraftCanonical,
    ($filterPresetDraftCanonical) => JSON.stringify($filterPresetDraftCanonical, null, 2)
  );

  const filterPresetDirty = derived(
    [selectedFilterPreset, filterPresetDraftCanonical],
    ([$selectedFilterPreset, $filterPresetDraftCanonical]) => {
      const left = $selectedFilterPreset
        ? {
          id: Number($selectedFilterPreset.id || 0),
          key: String($selectedFilterPreset.key || '').trim(),
          name: normalizeFilterPresetName($selectedFilterPreset.name),
          nameI18n: normalizeFilterPresetNameI18n($selectedFilterPreset.nameI18n, $selectedFilterPreset.name),
          description: String($selectedFilterPreset.description || '').trim() || null,
          layers: normalizeFilterPresetLayersForSave($selectedFilterPreset.layers).layers
        }
        : {
          id: null,
          key: '',
          name: '',
          nameI18n: {},
          description: null,
          layers: []
        };
      const right = {
        id: Number($filterPresetDraftCanonical?.id || 0) || null,
        key: String($filterPresetDraftCanonical?.key || '').trim(),
        name: normalizeFilterPresetName($filterPresetDraftCanonical?.name),
        nameI18n: normalizeFilterPresetNameI18n($filterPresetDraftCanonical?.nameI18n, $filterPresetDraftCanonical?.name),
        description: String($filterPresetDraftCanonical?.description || '').trim() || null,
        layers: normalizeFilterPresetLayersForSave($filterPresetDraftCanonical?.layers).layers
      };
      return JSON.stringify(left) !== JSON.stringify(right);
    }
  );

  const filtersDirty = derived(
    [filterTagAllowlistDirty, filterPresetDirty],
    ([$filterTagAllowlistDirty, $filterPresetDirty]) => Boolean($filterTagAllowlistDirty || $filterPresetDirty)
  );

  function patchRegionDraft(patch: Partial<RegionDraft>) {
    regionDraft.update((current) => ({
      ...current,
      ...(patch && typeof patch === 'object' ? patch : {})
    }));
  }

  const filterSettingsController = createFilterSettingsControllerModule({
    dataSettings,
    dataStatus,
    filterTagAllowlistDraft,
    filterTagAllowlistSaving,
    filterTagAllowlistDirty,
    dataT
  });

  const filterPresetController = createFilterPresetControllerModule({
    dataSettings,
    dataStatus,
    filterPresetItems,
    selectedFilterPresetId,
    filterPresetDraft,
    filterPresetLoading,
    filterPresetSaving,
    filterPresetDeleting,
    filterPresetDirty,
    dataT
  });

  const mapRegionController = createMapRegionControllerModule({
    dataSettings,
    dataStatus,
    regionDraft,
    regionResolveBusy,
    regionExtractCandidates,
    patchRegionDraft,
    dataT
  });

  function seedFilterTagAllowlistDraft(filterTags = null) {
    return filterSettingsController.seedFilterTagAllowlistDraft(filterTags);
  }

  function seedFilterPresetItems(filterPresets: FilterPresetState | null = null, options: { preserveSelection?: boolean; skipDraftSync?: boolean } = {}) {
    return filterPresetController.seedFilterPresetItems(filterPresets, options);
  }

  function getMapRegionFeatureMeta(feature: { properties?: Record<string, unknown> | null } | null) {
    return mapRegionController.getMapRegionFeatureMeta(feature);
  }

  function findRegionByMapFeature(feature: { properties?: Record<string, unknown> | null } | null, regions: DataRegion[] | null = null) {
    return mapRegionController.findRegionByMapFeature(feature, regions);
  }

  function applyRegionDraftFromMapFeature(feature: { properties?: Record<string, unknown> | null } | null) {
    return mapRegionController.applyRegionDraftFromMapFeature(feature);
  }

  function applyRegionExtractCandidate(candidate: RegionExtractCandidate | null, options: { setStatus?: boolean } = {}) {
    return mapRegionController.applyRegionExtractCandidate(candidate, options);
  }

  function getRegionById(regionId: number | string): DataRegion | null {
    return get(dataSettings).regions.find((item) => Number(item?.id || 0) === Number(regionId)) || null;
  }

  function buildRegionSnapshot(
    region: Partial<DataRegion> | null,
    fallback: Partial<DataRegion> | null = null,
    overrides: Partial<DataRegion> = {}
  ): DataRegion {
    const source = (region && typeof region === 'object' ? region : {}) as Partial<DataRegion> & LooseRecord;
    const base = (fallback && typeof fallback === 'object' ? fallback : {}) as Partial<DataRegion> & LooseRecord;

    return {
      ...source,
      id: Number(source?.id || base?.id || 0) || null,
      sourceType: 'extract',
      name: String(source?.name || base?.name || ''),
      slug: String(source?.slug || base?.slug || ''),
      searchQuery: String(source?.searchQuery || base?.searchQuery || ''),
      extractSource: String(source?.extractSource || base?.extractSource || ''),
      extractId: String(source?.extractId || base?.extractId || ''),
      extractLabel: String(source?.extractLabel || base?.extractLabel || ''),
      extractResolutionStatus: String(
        source?.extractResolutionStatus || base?.extractResolutionStatus || 'resolved'
      ) as SharedRegionDraft['extractResolutionStatus'],
      extractResolutionError: source?.extractResolutionError ?? base?.extractResolutionError ?? null,
      resolutionRequired:
        String(source?.extractResolutionStatus || base?.extractResolutionStatus || 'resolved') !== 'resolved',
      enabled: source?.enabled ?? base?.enabled ?? true,
      autoSyncEnabled: source?.autoSyncEnabled ?? base?.autoSyncEnabled ?? true,
      autoSyncOnStart: source?.autoSyncOnStart ?? base?.autoSyncOnStart ?? false,
      autoSyncIntervalHours: Number(source?.autoSyncIntervalHours ?? base?.autoSyncIntervalHours ?? 168) || 0,
      pmtilesMinZoom: Number(source?.pmtilesMinZoom ?? base?.pmtilesMinZoom ?? 13) || 0,
      pmtilesMaxZoom: Number(source?.pmtilesMaxZoom ?? base?.pmtilesMaxZoom ?? 16) || 0,
      sourceLayer: String(source?.sourceLayer || base?.sourceLayer || 'buildings'),
      lastSyncStatus: String(source?.lastSyncStatus || base?.lastSyncStatus || 'idle'),
      lastSyncError: source?.lastSyncError ?? base?.lastSyncError ?? null,
      lastSuccessfulSyncAt: source?.lastSuccessfulSyncAt ?? base?.lastSuccessfulSyncAt ?? null,
      lastSyncFinishedAt: source?.lastSyncFinishedAt ?? base?.lastSyncFinishedAt ?? null,
      nextSyncAt: source?.nextSyncAt ?? base?.nextSyncAt ?? null,
      pmtilesBytes: Number(source?.pmtilesBytes ?? base?.pmtilesBytes ?? 0) || 0,
      dbBytes: Number(source?.dbBytes ?? base?.dbBytes ?? 0) || 0,
      dbBytesApproximate: Boolean(source?.dbBytesApproximate ?? base?.dbBytesApproximate),
      bounds: source?.bounds ?? base?.bounds ?? null,
      __optimistic: Boolean(source?.__optimistic ?? base?.__optimistic),
      ...overrides
    } as DataRegion;
  }

  function getRegionIdentityKey(region) {
    const slug = String(region?.slug || '')
      .trim()
      .toLowerCase();
    const extractSource = String(region?.extractSource || '')
      .trim()
      .toLowerCase();
    const extractId = String(region?.extractId || '')
      .trim()
      .toLowerCase();

    if (extractSource && extractId) return `extract:${extractSource}:${extractId}`;
    if (slug) return `slug:${slug}`;
    return '';
  }

  function isOptimisticRegion(region) {
    return Boolean(region?.__optimistic) && Number(region?.id || 0) <= 0;
  }

  function compareRegions(left: Partial<DataRegion> | null, right: Partial<DataRegion> | null) {
    const leftOptimistic = isOptimisticRegion(left);
    const rightOptimistic = isOptimisticRegion(right);
    if (leftOptimistic !== rightOptimistic) return leftOptimistic ? -1 : 1;

    const leftId = Number(left?.id || 0);
    const rightId = Number(right?.id || 0);
    if (leftOptimistic && rightOptimistic && leftId !== rightId) {
      return rightId - leftId;
    }
    if (leftId !== rightId) return leftId - rightId;
    return String(left?.slug || '').localeCompare(String(right?.slug || ''), 'en', { sensitivity: 'base' });
  }

  function rememberOptimisticRegion(region) {
    const snapshot = region && typeof region === 'object' ? region : null;
    const numericRegionId = Number(snapshot?.id || 0);
    if (!snapshot || !Number.isInteger(numericRegionId) || numericRegionId >= 0) return;
    pendingOptimisticRegions.set(numericRegionId, snapshot);
  }

  function forgetOptimisticRegion(regionId) {
    const numericRegionId = Number(regionId || 0);
    if (!Number.isInteger(numericRegionId)) return;
    pendingOptimisticRegions.delete(numericRegionId);
  }

  function mergePendingOptimisticRegions(regions: DataRegion[] = []): DataRegion[] {
    const nextRegions = Array.isArray(regions) ? [...regions] : [];
    const existingKeys = new Set(nextRegions.map((item) => getRegionIdentityKey(item)).filter(Boolean));

    for (const pendingRegion of pendingOptimisticRegions.values()) {
      const identityKey = getRegionIdentityKey(pendingRegion);
      if (!identityKey || existingKeys.has(identityKey)) continue;
      nextRegions.push(pendingRegion);
      existingKeys.add(identityKey);
    }

    return nextRegions.sort(compareRegions);
  }

  function upsertRegionSnapshot(region: Partial<DataRegion> | null): DataRegion | null {
    const snapshot = (region && typeof region === 'object' ? region : null) as Partial<DataRegion> | null;
    const numericRegionId = Number(snapshot?.id || 0);
    if (!snapshot || !Number.isInteger(numericRegionId)) return null;

    let mergedRegion: DataRegion | null = null;
    dataSettings.update((current) => {
      const regions = Array.isArray(current?.regions) ? current.regions as DataRegion[] : [];
      const existingRegion = regions.find((item) => Number(item?.id || 0) === numericRegionId) || null;
      mergedRegion = {
        ...(existingRegion && typeof existingRegion === 'object' ? existingRegion : {}),
        ...snapshot
      } as DataRegion;

      const nextRegions = [
        ...regions.filter((item) => Number(item?.id || 0) !== numericRegionId),
        mergedRegion
      ].sort(compareRegions);

      return {
        ...current,
        regions: nextRegions
      };
    });

    return mergedRegion;
  }

  function removeRegionSnapshot(regionId) {
    const numericRegionId = Number(regionId || 0);
    if (!Number.isInteger(numericRegionId)) return false;

    let removed = false;
    dataSettings.update((current) => {
      const regions = Array.isArray(current?.regions) ? (current.regions as DataRegion[]) : [];
      const nextRegions = regions.filter((item) => {
        const shouldKeep = Number(item?.id || 0) !== numericRegionId;
        if (!shouldKeep) {
          removed = true;
        }
        return shouldKeep;
      });

      if (!removed) return current;
      return {
        ...current,
        regions: nextRegions
      };
    });

    return removed;
  }

  function selectRegionLocally(region: DataRegion | null, options: { resetRuns?: boolean } = {}) {
    const nextRegion = region && typeof region === 'object' ? region : null;
    const numericRegionId = Number(nextRegion?.id || 0);
    const nextSelectedRegionId = Number.isInteger(numericRegionId) && numericRegionId > 0 ? numericRegionId : null;
    const resetRuns = options.resetRuns !== false;

    selectedDataRegionId.set(nextSelectedRegionId);
    regionDraft.set(createRegionDraft(nextRegion));
    regionResolveBusy.set(false);
    regionExtractCandidates.set([]);

    if (!resetRuns) return;

    regionRunsRequestToken += 1;
    regionRunsLoading.set(false);
    regionRuns.set([]);
    regionRunsTotal.set(0);
    regionRunsPageCount.set(0);
    regionRunsPage.set(1);
    regionRunsStatus.set('');
  }

  async function refreshDataSettingsInBackground(options: LooseRecord = {}) {
    const { selectedRegionId = null, preserveStatus = true, silent = true } = options;
    const preservedStatus = get(dataStatus);

    try {
      const currentSettings = get(dataSettings);
      const data = await apiJson('/api/admin/app-settings/data');
      const nextSettings = normalizeDataSettings(data?.item, currentSettings);
      nextSettings.regions = mergePendingOptimisticRegions(nextSettings.regions as DataRegion[]);

      dataSettings.set(nextSettings);
      seedFilterTagAllowlistDraft(nextSettings.filterTags);
      seedFilterPresetItems(nextSettings.filterPresets, {
        preserveSelection: true,
        skipDraftSync: get(filterPresetDirty)
      });
      initialized.set(true);

      const numericSelectedRegionId = Number(selectedRegionId || 0);
      if (Number.isInteger(numericSelectedRegionId) && numericSelectedRegionId > 0) {
        const currentSelectedRegionId = Number(get(selectedDataRegionId) || 0);
        const currentDraftRegionId = Number(get(regionDraft)?.id || 0);
        if (currentSelectedRegionId === numericSelectedRegionId || currentDraftRegionId === numericSelectedRegionId) {
          const refreshedRegion =
            nextSettings.regions.find((item) => Number(item?.id || 0) === numericSelectedRegionId) || null;
          if (refreshedRegion) {
            selectRegionLocally(refreshedRegion, { resetRuns: false });
            await loadRegionRuns(numericSelectedRegionId);
          }
        }
      }

      if (preserveStatus) {
        dataStatus.set(preservedStatus);
      }
      return true;
    } catch (error) {
      if (!silent) {
        dataStatus.set(msg(error, dataT('status.loadSettingsFailed')));
      } else if (preserveStatus) {
        dataStatus.set(preservedStatus);
      }
      return false;
    }
  }

  function confirmDiscardFilterTagChanges() {
    if (!filterSettingsController.confirmDiscardFilterTagChanges()) return false;
    return filterPresetController.confirmDiscardFilterPresetChanges();
  }

  function ensureFilterTagChangesDiscarded() {
    return confirmDiscardFilterTagChanges();
  }

  function toggleFilterTagSelection(key, checked) {
    return filterSettingsController.toggleFilterTagSelection(key, checked);
  }

  function resetFilterTagAllowlistToDefault() {
    return filterSettingsController.resetFilterTagAllowlistToDefault();
  }

  async function loadRegionRuns(regionId: number | string = get(selectedDataRegionId), page: number | string = get(regionRunsPage)) {
    const numericRegionId = Number(regionId || 0);
    if (!Number.isInteger(numericRegionId) || numericRegionId <= 0) {
      regionRunsRequestToken += 1;
      regionRunsLoading.set(false);
      regionRuns.set([]);
      regionRunsTotal.set(0);
      regionRunsPageCount.set(0);
      regionRunsPage.set(1);
      regionRunsStatus.set('');
      return;
    }

    const normalizedPage = Math.max(1, Math.trunc(Number(page) || 1));
    const requestToken = ++regionRunsRequestToken;
    regionRunsLoading.set(true);
    regionRunsStatus.set('');
    try {
      const query = new URLSearchParams({
        page: String(normalizedPage),
        limit: String(REGION_RUNS_PAGE_SIZE)
      });
      const data = await apiJson(`/api/admin/app-settings/data/regions/${numericRegionId}/runs?${query.toString()}`);
      if (requestToken !== regionRunsRequestToken) return;

      const total = Math.max(0, Number(data?.total || 0));
      const pageSize = Math.max(1, Math.trunc(Number(data?.pageSize || REGION_RUNS_PAGE_SIZE) || REGION_RUNS_PAGE_SIZE));
      const pageCount = Math.max(0, Number(data?.pageCount || 0) || (total > 0 ? Math.ceil(total / pageSize) : 0));
      const responsePage = Number.isInteger(Number(data?.page)) && Number(data.page) > 0
        ? Number(data.page)
        : normalizedPage;
      const items = Array.isArray(data?.items) ? data.items : [];

      regionRuns.set(items);
      regionRunsTotal.set(total);
      regionRunsPageCount.set(pageCount);
      regionRunsPage.set(pageCount > 0 ? Math.min(responsePage, pageCount) : 1);
    } catch (error) {
      if (requestToken !== regionRunsRequestToken) return;
      regionRuns.set([]);
      regionRunsTotal.set(0);
      regionRunsPageCount.set(0);
      regionRunsStatus.set(msg(error, dataT('status.loadHistoryFailed')));
    } finally {
      if (requestToken === regionRunsRequestToken) {
        regionRunsLoading.set(false);
      }
    }
  }

  async function selectDataRegion(region: DataRegion | null, options: { openEditor?: boolean; resetRuns?: boolean } = {}) {
    if (isOptimisticRegion(region)) return;

    const shouldOpenEditor = options.openEditor !== false && Boolean(region);
    const resetRuns = options.resetRuns !== false;
    const numericRegionId = Number(region?.id || 0);
    const nextSelectedRegionId = Number.isInteger(numericRegionId) && numericRegionId > 0 ? numericRegionId : null;

    selectedDataRegionId.set(nextSelectedRegionId);
    regionDraft.set(createRegionDraft(region || null));
    regionResolveBusy.set(false);
    regionExtractCandidates.set([]);
    if (shouldOpenEditor) {
      regionEditorOpen.set(true);
    }

    if (nextSelectedRegionId) {
      if (resetRuns) {
        regionRunsRequestToken += 1;
        regionRunsLoading.set(false);
        regionRuns.set([]);
        regionRunsTotal.set(0);
        regionRunsPageCount.set(0);
        regionRunsPage.set(1);
        regionRunsStatus.set('');
      }
      await loadRegionRuns(nextSelectedRegionId, resetRuns ? 1 : get(regionRunsPage));
      return;
    }

    regionRunsRequestToken += 1;
    regionRunsLoading.set(false);
    regionRuns.set([]);
    regionRunsTotal.set(0);
    regionRunsPageCount.set(0);
    regionRunsPage.set(1);
    regionRunsStatus.set('');
  }

  async function loadDataSettings(options: LooseRecord = {}) {
    const {
      selectedRegionId = null,
      preserveSelection = true,
      ignoreUnsavedFilterTags = false,
      openEditor = get(regionEditorOpen)
    } = options;
    if (!ignoreUnsavedFilterTags && !ensureFilterTagChangesDiscarded()) {
      return false;
    }

    dataLoading.set(true);
    dataStatus.set(dataT('status.loadingSettings'));

    try {
      const currentSettings = get(dataSettings);
      const data = await apiJson('/api/admin/app-settings/data');
      const nextSettings = normalizeDataSettings(data?.item, currentSettings);
      nextSettings.regions = mergePendingOptimisticRegions(nextSettings.regions as DataRegion[]);

      dataSettings.set(nextSettings);
      seedFilterTagAllowlistDraft(nextSettings.filterTags);
      seedFilterPresetItems(nextSettings.filterPresets, {
        preserveSelection: true
      });

      const nextSelectedRegionId =
        selectedRegionId != null
          ? Number(selectedRegionId || 0)
          : preserveSelection
            ? Number(get(selectedDataRegionId) || 0)
            : 0;
      const hasSelectedRegion = Number.isInteger(nextSelectedRegionId) && nextSelectedRegionId > 0;
      const selectedRegion = hasSelectedRegion
        ? getRegionById(nextSelectedRegionId)
          || nextSettings.regions.find((item) => Number(item?.id || 0) === nextSelectedRegionId && !isOptimisticRegion(item))
          || null
        : null;

      const shouldResetRuns = selectedRegionId != null ? true : !preserveSelection;
      await selectDataRegion(selectedRegion, {
        openEditor: hasSelectedRegion ? openEditor : false,
        resetRuns: shouldResetRuns
      });
      dataStatus.set('');
      initialized.set(true);
      return true;
    } catch (error) {
      dataStatus.set(msg(error, dataT('status.loadSettingsFailed')));
      return false;
    } finally {
      dataLoading.set(false);
    }
  }

  async function ensureLoaded(options = {}) {
    if (get(initialized) || get(dataLoading)) return true;
    return loadDataSettings(options);
  }

  async function saveFilterTagAllowlist() {
    return filterSettingsController.saveFilterTagAllowlist();
  }

  function getFilterPresetById(id) {
    return filterPresetController.getFilterPresetById(id);
  }

  function patchFilterPresetDraft(patch: Partial<FilterPresetDraft> = {}) {
    return filterPresetController.patchFilterPresetDraft(patch);
  }

  function setFilterPresetDraftLayers(layers: FilterPresetLayer[] = []) {
    return filterPresetController.setFilterPresetDraftLayers(layers);
  }

  function startNewFilterPresetDraft() {
    return filterPresetController.startNewFilterPresetDraft();
  }

  function selectFilterPresetById(id) {
    return filterPresetController.selectFilterPresetById(id);
  }

  async function loadFilterPresets(options: { preserveSelection?: boolean; ignoreUnsaved?: boolean } = {}) {
    return filterPresetController.loadFilterPresets(options);
  }

  async function saveFilterPreset() {
    return filterPresetController.saveFilterPreset();
  }

  async function deleteFilterPreset(id = null) {
    return filterPresetController.deleteFilterPreset(id);
  }

  function startNewRegionDraft() {
    if (!ensureFilterTagChangesDiscarded()) return false;

    selectedDataRegionId.set(null);
    regionDraft.set(createRegionDraft());
    regionResolveBusy.set(false);
    regionExtractCandidates.set([]);
    regionRunsRequestToken += 1;
    regionRunsLoading.set(false);
    regionRuns.set([]);
    regionRunsTotal.set(0);
    regionRunsPageCount.set(0);
    regionRunsPage.set(1);
    regionRunsStatus.set('');
    dataStatus.set('');
    regionEditorOpen.set(true);
    return true;
  }

  function handleRegionSearchQueryInput(event) {
    return mapRegionController.handleRegionSearchQueryInput(event);
  }

  async function resolveRegionExtractCandidates() {
    return mapRegionController.resolveRegionExtractCandidates();
  }

  async function saveDataRegion(event) {
    event?.preventDefault?.();
    if (!ensureFilterTagChangesDiscarded()) return;
    if (get(regionSaving) || get(regionDeleting)) return;

    const currentDraft = get(regionDraft);
    const isNewRegion = !currentDraft.id;
    const draftSnapshot = { ...currentDraft };
    const payload = {
      ...(currentDraft.id ? { id: currentDraft.id } : {}),
      name: String(currentDraft.name || '').trim(),
      slug: String(currentDraft.slug || '').trim(),
      sourceType: 'extract',
      searchQuery: String(currentDraft.searchQuery || '').trim(),
      extractSource: String(currentDraft.extractSource || '').trim(),
      extractId: String(currentDraft.extractId || '').trim(),
      extractLabel: String(currentDraft.extractLabel || '').trim(),
      enabled: Boolean(currentDraft.enabled),
      autoSyncEnabled: Boolean(currentDraft.autoSyncEnabled),
      autoSyncOnStart: Boolean(currentDraft.autoSyncOnStart),
      autoSyncIntervalHours: Number(currentDraft.autoSyncIntervalHours || 0),
      pmtilesMinZoom: Number(currentDraft.pmtilesMinZoom || 0),
      pmtilesMaxZoom: Number(currentDraft.pmtilesMaxZoom || 0),
      sourceLayer: String(currentDraft.sourceLayer || '').trim()
    };

    regionSaving.set(true);
    dataStatus.set(dataT('status.savingRegion'));

    let optimisticRegionId = null;

    try {
      if (isNewRegion) {
        const optimisticRegion = upsertRegionSnapshot(
          buildRegionSnapshot(null, currentDraft, {
            id: nextOptimisticRegionId--,
            lastSyncStatus: 'queued',
            lastSyncError: null,
            __optimistic: true
          })
        );

        if (optimisticRegion) {
          optimisticRegionId = Number(optimisticRegion.id || 0);
          rememberOptimisticRegion(optimisticRegion);
        }

        selectRegionLocally(null);
      }

      const data = await apiJson('/api/admin/app-settings/data/regions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ region: payload })
      });
      const savedRegion = data?.item || null;
      const numericRegionId = Number(savedRegion?.id || currentDraft.id || 0);
      const nextRegion = upsertRegionSnapshot(
        buildRegionSnapshot(savedRegion, currentDraft, isNewRegion
          ? {
            lastSyncStatus: 'queued',
            lastSyncError: null,
            __optimistic: false
          }
          : {})
      );

      if (optimisticRegionId != null) {
        forgetOptimisticRegion(optimisticRegionId);
        removeRegionSnapshot(optimisticRegionId);
      }

      if (isNewRegion) {
        try {
          if (!Number.isInteger(numericRegionId) || numericRegionId <= 0) {
            throw new Error(dataT('status.regionSavedQueueFailed'));
          }

          await apiJson(`/api/admin/app-settings/data/regions/${numericRegionId}/sync-now`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({})
          });
          dataStatus.set(dataT('status.regionSavedQueued'));
        } catch (error) {
          const errorText = msg(error, dataT('status.regionSavedQueueFailed'));
          const failedRegion = upsertRegionSnapshot(
            buildRegionSnapshot(nextRegion || getRegionById(numericRegionId), draftSnapshot, {
              lastSyncStatus: 'failed',
              lastSyncError: errorText,
              __optimistic: false
            })
          );
          if (failedRegion && Number(get(selectedDataRegionId) || 0) === numericRegionId) {
            selectRegionLocally(failedRegion, { resetRuns: false });
          }
          dataStatus.set(errorText);
        }
      } else {
        if (nextRegion) {
          selectRegionLocally(nextRegion, { resetRuns: false });
        }
        dataStatus.set(dataT('status.regionSaved'));
      }

      if (Number.isInteger(numericRegionId) && numericRegionId > 0) {
        if (!isNewRegion) {
          void refreshDataSettingsInBackground({
            selectedRegionId: numericRegionId,
            preserveStatus: true
          });
        }
      }
    } catch (error) {
      if (isNewRegion) {
        regionDraft.set(createRegionDraft(draftSnapshot));
      }
      if (optimisticRegionId != null) {
        forgetOptimisticRegion(optimisticRegionId);
        removeRegionSnapshot(optimisticRegionId);
      }
      dataStatus.set(msg(error, dataT('status.saveRegionFailed')));
    } finally {
      regionSaving.set(false);
    }
  }

  async function deleteDataRegion(regionId) {
    if (!ensureFilterTagChangesDiscarded()) return;
    const numericRegionId = Number(regionId || 0);
    if (!Number.isInteger(numericRegionId) || numericRegionId <= 0 || get(regionDeleting)) return;

    const region = getRegionById(numericRegionId);
    const label = String(region?.name || region?.slug || `#${numericRegionId}`).trim();
    if (typeof window !== 'undefined') {
      const confirmed = window.confirm(dataT('confirmDelete', { label }));
      if (!confirmed) return;
    }

    regionDeleting.set(true);
    dataStatus.set(dataT('status.deletingRegion'));

    try {
      await apiJson(`/api/admin/app-settings/data/regions/${numericRegionId}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' }
      });
      closeRegionEditor();
      await loadDataSettings({
        selectedRegionId: null,
        preserveSelection: false,
        openEditor: false
      });
      dataStatus.set(dataT('status.regionDeleted'));
    } catch (error) {
      dataStatus.set(msg(error, dataT('status.deleteRegionFailed')));
    } finally {
      regionDeleting.set(false);
    }
  }

  async function syncRegionNow(regionId) {
    if (!ensureFilterTagChangesDiscarded()) return;
    const numericRegionId = Number(regionId || 0);
    if (!Number.isInteger(numericRegionId) || numericRegionId <= 0) return;

    regionSyncBusy.set(true);
    dataStatus.set(dataT('status.queueingSync'));

    try {
      const optimisticRegion = upsertRegionSnapshot(
        buildRegionSnapshot(getRegionById(numericRegionId), null, {
          lastSyncStatus: 'queued',
          lastSyncError: null
        })
      );
      if (optimisticRegion && Number(get(selectedDataRegionId) || 0) === numericRegionId) {
        selectRegionLocally(optimisticRegion, { resetRuns: false });
      }

      await apiJson(`/api/admin/app-settings/data/regions/${numericRegionId}/sync-now`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      });
      dataStatus.set(dataT('status.queuedSync'));
      void refreshDataSettingsInBackground({
        selectedRegionId: numericRegionId,
        preserveStatus: true
      });
    } catch (error) {
      const errorText = msg(error, dataT('status.syncFailed'));
      const failedRegion = upsertRegionSnapshot(
        buildRegionSnapshot(getRegionById(numericRegionId), null, {
          lastSyncStatus: 'failed',
          lastSyncError: errorText
        })
      );
      if (failedRegion && Number(get(selectedDataRegionId) || 0) === numericRegionId) {
        selectRegionLocally(failedRegion, { resetRuns: false });
      }
      dataStatus.set(errorText);
    } finally {
      regionSyncBusy.set(false);
    }
  }

  function getRegionExtractPrimaryText(region) {
    return String(region?.extractLabel || region?.searchQuery || '').trim() || '---';
  }

  function getRegionExtractSecondaryText(region) {
    if (region?.extractId && region?.extractSource) {
      return `${region.extractSource} · ${region.extractId}`;
    }
    return String(region?.extractResolutionError || '').trim();
  }

  function getRegionExtractSummaryText(region) {
    const primary = getRegionExtractPrimaryText(region);
    const secondary = getRegionExtractSecondaryText(region);
    if (!secondary) return primary;
    if (!primary || primary === '---') return secondary;
    return `${primary} · ${secondary}`;
  }

  function getRegionSyncState(region) {
    return mapRegionController.getRegionSyncState(region);
  }

  function getRegionStatusMeta(status, context = null) {
    const code = String(status || 'idle')
      .trim()
      .toLowerCase();
    if (code === 'running') return { text: dataT('runStatus.running'), tone: 'running' };
    if (code === 'queued') return { text: dataT('runStatus.queued'), tone: 'queued' };
    if (code === 'failed' || code === 'abandoned') return { text: dataT('runStatus.failed'), tone: 'failed' };
    if (code === 'success') return { text: dataT('runStatus.success'), tone: 'success' };
    if (code === 'idle' && context?.lastSuccessfulSyncAt) return { text: dataT('runStatus.success'), tone: 'success' };
    return { text: dataT('runStatus.planned'), tone: 'idle' };
  }

  function formatRunTriggerReason(reason) {
    const code = String(reason || 'manual')
      .trim()
      .toLowerCase();
    if (code === 'scheduled') return dataT('triggers.scheduled');
    if (code === 'startup') return dataT('triggers.startup');
    return dataT('triggers.manual');
  }

  function getBootstrapStatusLabel(completed) {
    return completed ? dataT('summary.bootstrapDone') : dataT('summary.bootstrapPending');
  }

  function getRegionEnabledLabel(enabled) {
    return enabled ? dataT('list.enabled') : dataT('list.disabled');
  }

  function getRegionSyncModeLabel(region) {
    return region?.autoSyncEnabled
      ? dataT('list.everyHours', { hours: Number(region?.autoSyncIntervalHours || 0) })
      : dataT('list.manualOnly');
  }

  function formatStorageBytes(value, options: LooseRecord = {}) {
    const { fallback = '---' } = options;
    const bytes = Number(value);
    if (!Number.isFinite(bytes) || bytes < 0) return fallback;
    if (bytes === 0) return '0 B';

    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let size = bytes;
    let unitIndex = 0;

    while (size >= 1024 && unitIndex < units.length - 1) {
      size /= 1024;
      unitIndex += 1;
    }

    const digits = size >= 100 || unitIndex === 0 ? 0 : size >= 10 ? 1 : 2;
    return `${size.toFixed(digits)} ${units[unitIndex]}`;
  }

  function getFilterTagDraftClass(state) {
    return filterSettingsController.getFilterTagDraftClass(state);
  }

  function closeRegionEditor() {
    regionEditorOpen.set(false);
  }

  function isFilterTagSelected(key) {
    return filterSettingsController.isFilterTagSelected(key);
  }

  return {
    dataSettings,
    dataLoading,
    dataStatus,
    filterTagAllowlistDraft,
    filterTagAllowlistSaving,
    storageSummary,
    sortedAvailableFilterTagKeys,
    filterTagAllowlistDirty,
    filtersDirty,
    filterTagDraftStateByKey,
    filterPresetItems,
    selectedFilterPresetId,
    selectedFilterPreset,
    filterPresetDraft,
    filterPresetDraftCanonical,
    filterPresetDraftJsonPreview,
    filterPresetDirty,
    filterPresetLoading,
    filterPresetSaving,
    filterPresetDeleting,
    regionDraft,
    regionSaving,
    regionDeleting,
    regionSyncBusy,
    regionResolveBusy,
    regionExtractCandidates,
    selectedDataRegionId,
    regionRuns,
    regionRunsLoading,
    regionRunsStatus,
    regionRunsPage,
    regionRunsPageCount,
    regionRunsTotal,
    regionEditorOpen,
    initialized,
    applyRegionExtractCandidate,
    confirmDiscardFilterTagChanges,
    ensureFilterTagChangesDiscarded,
    ensureLoaded,
    formatRunTriggerReason,
    formatStorageBytes,
    getBootstrapStatusLabel,
    getFilterTagDraftClass,
    getFilterPresetById,
    getRegionById,
    getRegionEnabledLabel,
    getRegionExtractPrimaryText,
    getRegionExtractSecondaryText,
    getRegionExtractSummaryText,
    getRegionSyncState,
    getRegionStatusMeta,
    getRegionSyncModeLabel,
    getMapRegionFeatureMeta,
    handleRegionSearchQueryInput,
    isFilterTagSelected,
    loadFilterPresets,
    loadDataSettings,
    loadRegionRuns,
    patchFilterPresetDraft,
    patchRegionDraft,
    findRegionByMapFeature,
    applyRegionDraftFromMapFeature,
    resetFilterTagAllowlistToDefault,
    resolveRegionExtractCandidates,
    saveDataRegion,
    saveFilterPreset,
    saveFilterTagAllowlist,
    selectFilterPresetById,
    selectDataRegion,
    setFilterPresetDraftLayers,
    startNewFilterPresetDraft,
    startNewRegionDraft,
    closeRegionEditor,
    syncRegionNow,
    toggleFilterTagSelection,
    deleteDataRegion,
    deleteFilterPreset
  };
}
