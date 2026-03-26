import { DEFAULT_LOCALE, SUPPORTED_LOCALES } from '$lib/i18n/config';
import { createBuildingFilterLayerDraft } from '$lib/stores/filters';
import { normalizeFilterLayerMode, normalizeFilterLayers } from '$lib/components/map/filter-pipeline-utils';
import type {
  AdminDataSettings,
  FilterPreset as ApiFilterPreset,
  FilterPresetDraft,
  FilterPresetLayer,
  FilterPresetRule,
  FilterPresetState,
  Region,
  RegionDraft,
  RegionResolutionStatus
} from '$shared/types';

const MAP_REGION_NAME_KEYS = Object.freeze(['Name', 'name']);
const MAP_REGION_SLUG_KEYS = Object.freeze(['Slug', 'slug']);
const MAP_REGION_EXTRACT_ID_KEYS = Object.freeze(['ExtractId', 'extractId', 'extract_id']);
const MAP_REGION_EXTRACT_SOURCE_KEYS = Object.freeze(['ExtractSource', 'extractSource', 'extract_source']);
const FILTER_PRESET_LOCALE_RE = /^[a-z]{2,8}(?:-[a-z0-9]{2,8})*$/i;
const FILTER_PRESET_NAME_LOCALES = Object.freeze([...(Array.isArray(SUPPORTED_LOCALES) ? SUPPORTED_LOCALES : [])]);

export type DataTranslator = (key: string, params?: LooseRecord) => string;

function createEmptyFilterPresetState(): FilterPresetState {
  return {
    source: 'db',
    items: []
  };
}

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

function createRegionDraft(region: Partial<Region> | null = null): RegionDraft {
  return {
    id: Number(region?.id || 0) || null,
    name: String(region?.name || ''),
    slug: String(region?.slug || ''),
    searchQuery: String(region?.searchQuery || ''),
    extractSource: String(region?.extractSource || ''),
    extractId: String(region?.extractId || ''),
    extractLabel: String(region?.extractLabel || ''),
    extractResolutionStatus: normalizeRegionResolutionStatus(region?.extractResolutionStatus, 'needs_resolution'),
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

function normalizeRegionResolutionStatus(
  value: unknown,
  fallbackValue: RegionResolutionStatus = 'needs_resolution'
): RegionResolutionStatus {
  const raw = String(value || fallbackValue || '').trim().toLowerCase();
  if (raw === 'resolved' || raw === 'needs_resolution' || raw === 'resolution_required' || raw === 'resolution_error') {
    return raw as RegionResolutionStatus;
  }
  return fallbackValue;
}

function normalizeFilterPresetKey(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

function normalizeFilterPresetLocale(localeValue) {
  const normalized = String(localeValue || '')
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
  const source = nameI18n && typeof nameI18n === 'object' && !Array.isArray(nameI18n)
    ? nameI18n
    : {};
  const normalized: Record<string, string> = {};
  for (const [rawLocale, rawName] of Object.entries(source)) {
    const localeValue = normalizeFilterPresetLocale(rawLocale);
    if (!localeValue) continue;
    const name = normalizeFilterPresetName(rawName);
    if (!name) continue;
    normalized[localeValue] = name;
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

  for (const localeValue of FILTER_PRESET_NAME_LOCALES) {
    const name = normalizeFilterPresetName(source?.[localeValue]);
    if (name) return name;
  }

  for (const value of Object.values(source)) {
    const name = normalizeFilterPresetName(value);
    if (name) return name;
  }

  return normalizeFilterPresetName(fallback);
}

function normalizeFilterPresetRule(
  rule: Partial<FilterPresetLayer['rules'][number]> | LooseRecord = {},
  options: LooseRecord = {}
): FilterPresetRule {
  const normalized: FilterPresetRule = {
    key: String(rule?.key || '').trim(),
    op: String(rule?.op || 'contains').trim(),
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

  return source.map((layer, index, list) =>
    createBuildingFilterLayerDraft(
      {
        ...layer,
        priority: Number.isFinite(Number(layer?.priority)) ? Number(layer.priority) : index,
        rules:
          Array.isArray(layer?.rules) && layer.rules.length > 0
            ? layer.rules.map((rule) => normalizeFilterPresetRule(rule, { preserveId: true }))
            : [normalizeFilterPresetRule({}, { preserveId: true })]
      },
      list.slice(0, index)
    )
  );
}

function normalizeFilterPresetLayersForSave(layers: Array<Partial<FilterPresetLayer> | LooseRecord> = [], options: LooseRecord = {}) {
  const dataT = typeof options?.dataT === 'function' ? options.dataT : (key) => key;
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
      mode: normalizeFilterLayerMode(layer?.mode),
      rules: (Array.isArray(layer?.rules) ? layer.rules : []).map((rule) => normalizeFilterPresetRule(rule))
    })),
    error: null
  };
}

function normalizeFilterPresetItem(preset: ApiFilterPreset | FilterPresetDraft | LooseRecord | null = null): FilterPresetDraft {
  const source = (preset && typeof preset === 'object' ? preset : {}) as Partial<FilterPresetDraft> & LooseRecord;
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

function buildFilterPresetDraftRecord(draft: FilterPresetDraft | LooseRecord | null = null): FilterPresetDraft {
  const source = (draft && typeof draft === 'object' ? draft : {}) as Partial<FilterPresetDraft> & LooseRecord;
  return normalizeFilterPresetItem({
    ...source,
    layers: source.layers
  });
}

function createFilterPresetDraft(preset: FilterPresetDraft | LooseRecord | null = null): FilterPresetDraft {
  return buildFilterPresetDraftRecord(preset);
}

function getFilterPresetDisplayName(preset, localeValue = DEFAULT_LOCALE) {
  const source = preset && typeof preset === 'object' ? preset : {};
  const nameI18n = normalizeFilterPresetNameI18n(source?.nameI18n, source?.name);
  const targetLocale = normalizeFilterPresetLocale(localeValue) || DEFAULT_LOCALE;
  return normalizeFilterPresetName(nameI18n[targetLocale])
    || normalizeFilterPresetName(source?.name)
    || getPreferredFilterPresetName(nameI18n);
}

function getRecordTextValue(record: LooseRecord | null, keys: readonly string[] = []) {
  const source = record && typeof record === 'object' ? record : {};
  const byLowercaseKey = new Map(Object.entries(source).map(([key, value]) => [String(key || '').toLowerCase(), value]));

  for (const key of Array.isArray(keys) ? keys : []) {
    const direct = source[key];
    const value = direct ?? byLowercaseKey.get(String(key || '').toLowerCase());
    if (value == null) continue;
    const text = String(value).trim();
    if (text) return text;
  }

  return '';
}

function slugifyLoose(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function normalizeLookupValue(value) {
  return String(value || '').trim().toLowerCase();
}

function buildRegionExtractIdentity(extractSource, extractId) {
  const normalizedExtractId = normalizeLookupValue(extractId);
  if (!normalizedExtractId) return '';
  return `${normalizeLookupValue(extractSource) || 'osmfr'}:${normalizedExtractId}`;
}

function normalizeDataSettings(nextSettings: AdminDataSettings | LooseRecord | null, fallback: AdminDataSettings | LooseRecord): AdminDataSettings {
  const value = (nextSettings && typeof nextSettings === 'object' ? nextSettings : fallback) as Partial<AdminDataSettings> & LooseRecord;
  return {
    source: String(value?.source || 'db'),
    bootstrap: {
      completed: Boolean(value?.bootstrap?.completed),
      source: value?.bootstrap?.source ? String(value.bootstrap.source) : null
    },
    regions: Array.isArray(value?.regions) ? (value.regions as Region[]) : [],
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
        ? (value.filterPresets.items as Array<ApiFilterPreset | FilterPresetDraft | LooseRecord>)
          .map((item) => normalizeFilterPresetItem(item))
          .filter((item) => item.id != null)
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

function getSavedFilterTagAllowlist(dataSettings: LooseRecord) {
  return Array.isArray(dataSettings?.filterTags?.allowlist) ? dataSettings.filterTags.allowlist : [];
}

function buildFilterTagDraftStateByKey(keys: readonly string[] = [], saved: readonly string[] = [], draft: readonly string[] = []) {
  const result: LooseRecord = {};
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

function sortFilterPresetItems(items: FilterPresetDraft[] = []): FilterPresetDraft[] {
  return [...(Array.isArray(items) ? items : [])].sort((left, right) => {
    const leftName = String(getFilterPresetDisplayName(left, DEFAULT_LOCALE) || left?.key || '').trim();
    const rightName = String(getFilterPresetDisplayName(right, DEFAULT_LOCALE) || right?.key || '').trim();
    const byName = leftName.localeCompare(rightName, 'en', { sensitivity: 'base' });
    if (byName !== 0) return byName;
    return Number(left?.id || 0) - Number(right?.id || 0);
  });
}

export {
  MAP_REGION_NAME_KEYS,
  MAP_REGION_SLUG_KEYS,
  MAP_REGION_EXTRACT_ID_KEYS,
  MAP_REGION_EXTRACT_SOURCE_KEYS,
  FILTER_PRESET_LOCALE_RE,
  FILTER_PRESET_NAME_LOCALES,
  createEmptyFilterPresetState,
  createEmptyDataSettings,
  createRegionDraft,
  normalizeFilterPresetKey,
  normalizeFilterPresetLocale,
  normalizeFilterPresetName,
  normalizeFilterPresetNameI18n,
  getPreferredFilterPresetName,
  normalizeFilterPresetRule,
  normalizeFilterPresetLayersForDraft,
  normalizeFilterPresetLayersForSave,
  normalizeFilterPresetItem,
  buildFilterPresetDraftRecord,
  createFilterPresetDraft,
  getFilterPresetDisplayName,
  getRecordTextValue,
  slugifyLoose,
  normalizeLookupValue,
  buildRegionExtractIdentity,
  normalizeDataSettings,
  normalizeStorageBytes,
  buildStorageSummary,
  getSavedFilterTagAllowlist,
  buildFilterTagDraftStateByKey,
  sortFilterTagKeys,
  sortFilterPresetItems
};
