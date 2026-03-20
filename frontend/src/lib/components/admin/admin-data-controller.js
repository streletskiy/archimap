import { derived, get, writable } from 'svelte/store';

import { locale, translateNow } from '$lib/i18n/index';
import { DEFAULT_LOCALE, SUPPORTED_LOCALES } from '$lib/i18n/config';
import { apiJson } from '$lib/services/http';
import { createBuildingFilterLayerDraft } from '$lib/stores/filters';
import { normalizeFilterLayers } from '$lib/components/map/filter-pipeline-utils';

const DATA_I18N_PREFIX = 'admin.data';
const MAP_REGION_NAME_KEYS = Object.freeze(['Name', 'name']);
const MAP_REGION_SLUG_KEYS = Object.freeze(['Slug', 'slug']);
const MAP_REGION_EXTRACT_ID_KEYS = Object.freeze(['ExtractId', 'extractId', 'extract_id']);
const MAP_REGION_EXTRACT_SOURCE_KEYS = Object.freeze(['ExtractSource', 'extractSource', 'extract_source']);
const FILTER_PRESET_LOCALE_RE = /^[a-z]{2,8}(?:-[a-z0-9]{2,8})*$/i;
const FILTER_PRESET_NAME_LOCALES = Object.freeze([...(Array.isArray(SUPPORTED_LOCALES) ? SUPPORTED_LOCALES : [])]);

const msg = (error, fallback) => String(error?.message || fallback);
const dataT = (key, params = {}) => translateNow(`${DATA_I18N_PREFIX}.${key}`, params);

function createEmptyDataSettings() {
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

function createRegionDraft(region = null) {
  return {
    id: Number(region?.id || 0) || null,
    name: String(region?.name || ''),
    slug: String(region?.slug || ''),
    searchQuery: String(region?.searchQuery || ''),
    extractSource: String(region?.extractSource || ''),
    extractId: String(region?.extractId || ''),
    extractLabel: String(region?.extractLabel || ''),
    extractResolutionStatus: String(region?.extractResolutionStatus || 'needs_resolution'),
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
  const normalized = {};
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
  const source = nameI18n && typeof nameI18n === 'object' ? nameI18n : {};
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

function normalizeFilterPresetRule(rule = {}, options = {}) {
  const normalized = {
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

function normalizeFilterPresetLayersForDraft(layers = []) {
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

function normalizeFilterPresetLayersForSave(layers = []) {
  const normalized = normalizeFilterLayers(Array.isArray(layers) ? layers : [], { preserveEmpty: false });
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
      mode: String(layer?.mode || 'layer').trim(),
      rules: (Array.isArray(layer?.rules) ? layer.rules : []).map((rule) => normalizeFilterPresetRule(rule))
    })),
    error: null
  };
}

function normalizeFilterPresetItem(preset = null) {
  const source = preset && typeof preset === 'object' ? preset : {};
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

function buildFilterPresetDraftRecord(draft = null) {
  const source = draft && typeof draft === 'object' ? draft : {};
  return normalizeFilterPresetItem({
    ...source,
    layers: source.layers
  });
}

function createFilterPresetDraft(preset = null) {
  return buildFilterPresetDraftRecord(preset);
}

function createEmptyFilterPresetState() {
  return {
    source: 'db',
    items: []
  };
}

function getFilterPresetDisplayName(preset = null, locale = DEFAULT_LOCALE) {
  const source = preset && typeof preset === 'object' ? preset : {};
  const nameI18n = normalizeFilterPresetNameI18n(source?.nameI18n, source?.name);
  const targetLocale = normalizeFilterPresetLocale(locale) || DEFAULT_LOCALE;
  return normalizeFilterPresetName(nameI18n[targetLocale])
    || normalizeFilterPresetName(source?.name)
    || getPreferredFilterPresetName(nameI18n);
}

function getRecordTextValue(record, keys = []) {
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

function normalizeDataSettings(nextSettings, fallback) {
  const value = nextSettings && typeof nextSettings === 'object' ? nextSettings : fallback;
  return {
    source: String(value?.source || 'db'),
    bootstrap: {
      completed: Boolean(value?.bootstrap?.completed),
      source: value?.bootstrap?.source ? String(value.bootstrap.source) : null
    },
    regions: Array.isArray(value?.regions) ? value.regions : [],
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

function getSavedFilterTagAllowlist(dataSettings) {
  return Array.isArray(dataSettings?.filterTags?.allowlist) ? dataSettings.filterTags.allowlist : [];
}

function buildFilterTagDraftStateByKey(keys = [], saved = [], draft = []) {
  const result = {};
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

function sortFilterTagKeys(keys = [], selected = []) {
  const selectedSet = new Set(Array.isArray(selected) ? selected : []);
  return [...(Array.isArray(keys) ? keys : [])].sort((left, right) => {
    const leftSelected = selectedSet.has(left);
    const rightSelected = selectedSet.has(right);
    if (leftSelected !== rightSelected) return leftSelected ? -1 : 1;
    return String(left || '').localeCompare(String(right || ''), 'en', { sensitivity: 'base' });
  });
}

function sortFilterPresetItems(items = []) {
  return [...(Array.isArray(items) ? items : [])].sort((left, right) => {
    const leftName = String(getFilterPresetDisplayName(left, DEFAULT_LOCALE) || left?.key || '').trim();
    const rightName = String(getFilterPresetDisplayName(right, DEFAULT_LOCALE) || right?.key || '').trim();
    const byName = leftName.localeCompare(rightName, 'en', { sensitivity: 'base' });
    if (byName !== 0) return byName;
    return Number(left?.id || 0) - Number(right?.id || 0);
  });
}

function createFilterSettingsController({
  dataSettings,
  dataStatus,
  filterTagAllowlistDraft,
  filterTagAllowlistSaving,
  filterTagAllowlistDirty,
  dataT
}) {
  function seedFilterTagAllowlistDraft(filterTags = null) {
    const current = filterTags && typeof filterTags === 'object' ? filterTags : {};
    filterTagAllowlistDraft.set(Array.isArray(current.allowlist) ? [...current.allowlist] : []);
  }

  function confirmDiscardFilterTagChanges() {
    if (!get(filterTagAllowlistDirty)) return true;
    if (typeof window === 'undefined') return false;
    return window.confirm(dataT('filterTags.confirmDiscard'));
  }

  function ensureFilterTagChangesDiscarded() {
    return confirmDiscardFilterTagChanges();
  }

  function toggleFilterTagSelection(key, checked) {
    const nextKey = String(key || '').trim();
    if (!nextKey) return;

    filterTagAllowlistDraft.update((current) => {
      if (checked) {
        return current.includes(nextKey) ? current : [...current, nextKey];
      }
      return current.filter((item) => item !== nextKey);
    });
  }

  function resetFilterTagAllowlistToDefault() {
    const currentSettings = get(dataSettings);
    const defaults = Array.isArray(currentSettings?.filterTags?.defaultAllowlist)
      ? currentSettings.filterTags.defaultAllowlist
      : [];
    const available = new Set(
      Array.isArray(currentSettings?.filterTags?.availableKeys) ? currentSettings.filterTags.availableKeys : []
    );
    filterTagAllowlistDraft.set(defaults.filter((key) => available.has(key)));
  }

  async function saveFilterTagAllowlist() {
    filterTagAllowlistSaving.set(true);
    dataStatus.set(dataT('status.savingFilterTags'));

    try {
      const payload = {
        allowlist: [...get(filterTagAllowlistDraft)]
      };
      const data = await apiJson('/api/admin/app-settings/data/filter-tag-allowlist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const saved = data?.item && typeof data.item === 'object' ? data.item : null;

      dataSettings.update((current) => ({
        ...current,
        filterTags: {
          ...current.filterTags,
          source: String(saved?.source || current.filterTags.source || 'default'),
          allowlist: Array.isArray(saved?.allowlist) ? saved.allowlist : [...get(filterTagAllowlistDraft)],
          defaultAllowlist: Array.isArray(saved?.defaultAllowlist)
            ? saved.defaultAllowlist
            : current.filterTags.defaultAllowlist,
          updatedBy: saved?.updatedBy ? String(saved.updatedBy) : null,
          updatedAt: saved?.updatedAt ? String(saved.updatedAt) : null
        }
      }));

      seedFilterTagAllowlistDraft(get(dataSettings).filterTags);
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('archimap:filter-tag-keys-changed'));
      }
      dataStatus.set(dataT('status.filterTagsSaved'));
    } catch (error) {
      dataStatus.set(msg(error, dataT('status.saveFilterTagsFailed')));
    } finally {
      filterTagAllowlistSaving.set(false);
    }
  }

  function getFilterTagDraftClass(state) {
    if (state === 'enabled_pending') return 'filter-tag-option-enabled-pending';
    if (state === 'disabled_pending') return 'filter-tag-option-disabled-pending';
    return 'filter-tag-option-unchanged';
  }

  function isFilterTagSelected(key) {
    return get(filterTagAllowlistDraft).includes(String(key || '').trim());
  }

  return {
    seedFilterTagAllowlistDraft,
    confirmDiscardFilterTagChanges,
    ensureFilterTagChangesDiscarded,
    toggleFilterTagSelection,
    resetFilterTagAllowlistToDefault,
    saveFilterTagAllowlist,
    getFilterTagDraftClass,
    isFilterTagSelected
  };
}

function createFilterPresetController({
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
}) {
  function applyFilterPresetItems(items = [], source = 'db') {
    const normalizedItems = sortFilterPresetItems(
      (Array.isArray(items) ? items : [])
        .map((item) => normalizeFilterPresetItem(item))
        .filter((item) => item.id != null)
    );
    filterPresetItems.set(normalizedItems);
    dataSettings.update((current) => ({
      ...current,
      filterPresets: {
        source: String(source || current?.filterPresets?.source || 'db'),
        items: normalizedItems
      }
    }));
    return normalizedItems;
  }

  function getFilterPresetById(id) {
    const numericId = Number(id || 0);
    if (!Number.isInteger(numericId) || numericId <= 0) return null;
    return get(filterPresetItems).find((item) => Number(item?.id || 0) === numericId) || null;
  }

  function selectFilterPresetLocally(preset) {
    const next = preset && typeof preset === 'object' ? preset : null;
    selectedFilterPresetId.set(next?.id ? Number(next.id) : null);
    filterPresetDraft.set(createFilterPresetDraft(next));
  }

  function confirmDiscardFilterPresetChanges() {
    if (!get(filterPresetDirty)) return true;
    if (typeof window === 'undefined') return false;
    return window.confirm(dataT('filterPresets.confirmDiscard'));
  }

  function ensureFilterPresetChangesDiscarded() {
    return confirmDiscardFilterPresetChanges();
  }

  function seedFilterPresetItems(filterPresets = null, options = {}) {
    const current = filterPresets && typeof filterPresets === 'object' ? filterPresets : {};
    const preserveSelection = options.preserveSelection !== false;
    const skipDraftSync = options.skipDraftSync === true;

    const items = applyFilterPresetItems(current.items, current.source || 'db');
    const currentSelectedId = preserveSelection ? Number(get(selectedFilterPresetId) || 0) : 0;
    const selected = items.find((item) => Number(item?.id || 0) === currentSelectedId)
      || items[0]
      || null;

    if (!selected) {
      selectedFilterPresetId.set(null);
      if (!skipDraftSync) {
        filterPresetDraft.set(createFilterPresetDraft());
      }
      return;
    }

    selectedFilterPresetId.set(Number(selected.id || 0));
    if (!skipDraftSync) {
      filterPresetDraft.set(createFilterPresetDraft(selected));
    }
  }

  function buildFilterPresetPayload(draft = null, options = {}) {
    const candidate = buildFilterPresetDraftRecord(draft || get(filterPresetDraft));
    const requireName = options.requireName !== false;
    const nameI18n = normalizeFilterPresetNameI18n(candidate.nameI18n, candidate.name);
    const name = normalizeFilterPresetName(candidate.name) || getPreferredFilterPresetName(nameI18n);
    const key = normalizeFilterPresetKey(candidate.key || name || getPreferredFilterPresetName(nameI18n));
    if (!key) {
      return {
        preset: null,
        error: dataT('filterPresets.errors.keyRequired')
      };
    }
    if (requireName && !name) {
      return {
        preset: null,
        error: dataT('filterPresets.errors.nameRequired')
      };
    }
    const normalizedLayers = normalizeFilterPresetLayersForSave(candidate.layers);
    if (normalizedLayers.error) {
      return {
        preset: null,
        error: normalizedLayers.error
      };
    }
    return {
      preset: {
        ...(candidate.id ? { id: candidate.id } : {}),
        key,
        name,
        nameI18n,
        description: String(candidate.description || '').trim() || null,
        layers: normalizedLayers.layers
      },
      error: null
    };
  }

  function getFilterPresetDraftCanonical() {
    const draft = get(filterPresetDraft);
    const nameI18n = normalizeFilterPresetNameI18n(draft?.nameI18n, draft?.name);
    const resolvedName = normalizeFilterPresetName(draft?.name) || getPreferredFilterPresetName(nameI18n);
    const payload = buildFilterPresetPayload(draft, { requireName: false });
    const item = payload.preset || {
      ...(draft?.id ? { id: draft.id } : {}),
      key: normalizeFilterPresetKey(draft?.key || resolvedName || ''),
      name: resolvedName,
      nameI18n,
      description: String(draft?.description || '').trim() || null,
      layers: []
    };
    return {
      ...item,
      createdAt: draft?.createdAt || null,
      updatedAt: draft?.updatedAt || null,
      updatedBy: draft?.updatedBy || null
    };
  }

  function getFilterPresetDraftJsonPreview() {
    return JSON.stringify(getFilterPresetDraftCanonical(), null, 2);
  }

  function patchFilterPresetDraft(patch = {}) {
    filterPresetDraft.update((current) => {
      const nextPatch = patch && typeof patch === 'object' ? patch : {};
      return {
        ...current,
        ...nextPatch
      };
    });
  }

  function setFilterPresetDraftLayers(layers = []) {
    patchFilterPresetDraft({
      layers: normalizeFilterPresetLayersForDraft(layers)
    });
  }

  function startNewFilterPresetDraft() {
    if (!ensureFilterPresetChangesDiscarded()) return false;
    selectedFilterPresetId.set(null);
    filterPresetDraft.set(createFilterPresetDraft());
    return true;
  }

  function selectFilterPresetById(id) {
    if (!ensureFilterPresetChangesDiscarded()) return false;
    const selected = getFilterPresetById(id);
    if (!selected) return false;
    selectFilterPresetLocally(selected);
    return true;
  }

  async function loadFilterPresets(options = {}) {
    const preserveSelection = options.preserveSelection !== false;
    const ignoreUnsaved = options.ignoreUnsaved === true;
    if (!ignoreUnsaved && !ensureFilterPresetChangesDiscarded()) {
      return false;
    }

    filterPresetLoading.set(true);
    dataStatus.set(dataT('status.loadingFilterPresets'));
    try {
      const data = await apiJson('/api/admin/app-settings/data/filter-presets');
      seedFilterPresetItems({
        source: String(data?.source || 'db'),
        items: Array.isArray(data?.items) ? data.items : []
      }, {
        preserveSelection
      });
      dataStatus.set('');
      return true;
    } catch (error) {
      dataStatus.set(msg(error, dataT('status.loadFilterPresetsFailed')));
      return false;
    } finally {
      filterPresetLoading.set(false);
    }
  }

  async function saveFilterPreset() {
    const payload = buildFilterPresetPayload();
    if (payload.error || !payload.preset) {
      dataStatus.set(payload.error || dataT('status.saveFilterPresetFailed'));
      return false;
    }

    filterPresetSaving.set(true);
    dataStatus.set(dataT('status.savingFilterPreset'));
    try {
      const data = await apiJson('/api/admin/app-settings/data/filter-presets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ preset: payload.preset })
      });
      const saved = normalizeFilterPresetItem(data?.item || {});
      if (!saved.id) {
        throw new Error(dataT('status.saveFilterPresetFailed'));
      }

      const nextItems = sortFilterPresetItems([
        ...get(filterPresetItems).filter((item) => Number(item?.id || 0) !== Number(saved.id || 0)),
        saved
      ]);
      applyFilterPresetItems(nextItems, 'db');
      selectFilterPresetLocally(saved);
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('archimap:filter-presets-changed'));
      }
      dataStatus.set(dataT('status.filterPresetSaved'));
      return true;
    } catch (error) {
      dataStatus.set(msg(error, dataT('status.saveFilterPresetFailed')));
      return false;
    } finally {
      filterPresetSaving.set(false);
    }
  }

  async function deleteFilterPreset(id = null) {
    const targetId = Number(id || get(selectedFilterPresetId) || 0);
    if (!Number.isInteger(targetId) || targetId <= 0 || get(filterPresetDeleting)) return false;

    const existing = getFilterPresetById(targetId);
    const label = String(getFilterPresetDisplayName(existing, get(locale)) || existing?.key || `#${targetId}`).trim();
    if (typeof window !== 'undefined') {
      const confirmed = window.confirm(dataT('filterPresets.confirmDelete', { label }));
      if (!confirmed) return false;
    }

    filterPresetDeleting.set(true);
    dataStatus.set(dataT('status.deletingFilterPreset'));
    try {
      await apiJson(`/api/admin/app-settings/data/filter-presets/${targetId}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' }
      });

      const nextItems = get(filterPresetItems).filter((item) => Number(item?.id || 0) !== targetId);
      applyFilterPresetItems(nextItems, 'db');
      const nextSelected = nextItems[0] || null;
      selectFilterPresetLocally(nextSelected);
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('archimap:filter-presets-changed'));
      }
      dataStatus.set(dataT('status.filterPresetDeleted'));
      return true;
    } catch (error) {
      dataStatus.set(msg(error, dataT('status.deleteFilterPresetFailed')));
      return false;
    } finally {
      filterPresetDeleting.set(false);
    }
  }

  return {
    seedFilterPresetItems,
    confirmDiscardFilterPresetChanges,
    ensureFilterPresetChangesDiscarded,
    getFilterPresetById,
    buildFilterPresetPayload,
    getFilterPresetDraftCanonical,
    getFilterPresetDraftJsonPreview,
    patchFilterPresetDraft,
    setFilterPresetDraftLayers,
    startNewFilterPresetDraft,
    selectFilterPresetById,
    loadFilterPresets,
    saveFilterPreset,
    deleteFilterPreset
  };
}

function createMapRegionController({
  dataSettings,
  dataStatus,
  regionDraft,
  regionResolveBusy,
  regionExtractCandidates,
  patchRegionDraft,
  dataT
}) {
  const regionLookupCache = new WeakMap();

  function getMapRegionFeatureMeta(feature) {
    const properties = feature?.properties && typeof feature.properties === 'object' ? feature.properties : {};
    const name = getRecordTextValue(properties, MAP_REGION_NAME_KEYS);
    const slug = getRecordTextValue(properties, MAP_REGION_SLUG_KEYS) || slugifyLoose(name);
    const extractId = getRecordTextValue(properties, MAP_REGION_EXTRACT_ID_KEYS);
    const extractSource = getRecordTextValue(properties, MAP_REGION_EXTRACT_SOURCE_KEYS) || 'osmfr';

    return {
      name,
      slug,
      extractSource,
      extractId
    };
  }

  function getRegionLookup(regions = []) {
    const items = Array.isArray(regions) ? regions : [];
    const cached = regionLookupCache.get(items);
    if (cached) return cached;

    const bySlug = new Map();
    const byExtractIdentity = new Map();
    const byExtractId = new Map();

    for (const region of items) {
      const slug = normalizeLookupValue(region?.slug);
      const extractId = normalizeLookupValue(region?.extractId);
      const extractIdentity = buildRegionExtractIdentity(region?.extractSource, region?.extractId);

      if (slug && !bySlug.has(slug)) {
        bySlug.set(slug, region);
      }

      if (extractIdentity && !byExtractIdentity.has(extractIdentity)) {
        byExtractIdentity.set(extractIdentity, region);
      }

      if (extractId) {
        const current = byExtractId.get(extractId);
        if (current) {
          current.push(region);
        } else {
          byExtractId.set(extractId, [region]);
        }
      }
    }

    const nextLookup = {
      bySlug,
      byExtractIdentity,
      byExtractId
    };
    regionLookupCache.set(items, nextLookup);
    return nextLookup;
  }

  function findRegionByMapFeature(feature, regions = null) {
    const items = Array.isArray(regions) ? regions : get(dataSettings).regions;
    const meta = getMapRegionFeatureMeta(feature);
    const featureSlug = normalizeLookupValue(meta.slug);
    const featureExtractSource = normalizeLookupValue(meta.extractSource);
    const featureExtractId = normalizeLookupValue(meta.extractId);
    const featureExtractIdentity = buildRegionExtractIdentity(meta.extractSource, meta.extractId);
    const lookup = getRegionLookup(items);

    if (featureSlug && lookup.bySlug.has(featureSlug)) {
      return lookup.bySlug.get(featureSlug) || null;
    }

    if (featureExtractIdentity && lookup.byExtractIdentity.has(featureExtractIdentity)) {
      return lookup.byExtractIdentity.get(featureExtractIdentity) || null;
    }

    if (featureExtractId) {
      const candidates = lookup.byExtractId.get(featureExtractId) || [];
      for (const region of candidates) {
        const regionExtractSource = normalizeLookupValue(region?.extractSource);
        if (!featureExtractSource || !regionExtractSource || regionExtractSource === featureExtractSource) {
          return region;
        }
      }
    }

    return null;
  }

  function applyRegionDraftFromMapFeature(feature) {
    const meta = getMapRegionFeatureMeta(feature);
    if (!meta.name && !meta.slug && !meta.extractId) return false;

    patchRegionDraft({
      name: meta.name,
      slug: meta.slug,
      searchQuery: meta.name || meta.slug || meta.extractId,
      extractSource: meta.extractSource || 'osmfr',
      extractId: meta.extractId,
      extractLabel: meta.name || meta.extractId,
      extractResolutionStatus: meta.extractId ? 'resolved' : 'needs_resolution',
      extractResolutionError: null
    });
    regionResolveBusy.set(false);
    regionExtractCandidates.set([]);
    dataStatus.set(meta.name ? dataT('status.mapRegionSelected', { name: meta.name }) : dataT('status.mapRegionSelectedFallback'));
    return true;
  }

  function clearRegionExtractSelection() {
    patchRegionDraft({
      extractSource: '',
      extractId: '',
      extractLabel: '',
      extractResolutionStatus: 'needs_resolution',
      extractResolutionError: null
    });
  }

  function applyRegionExtractCandidate(candidate, options = {}) {
    const next = candidate && typeof candidate === 'object' ? candidate : {};
    patchRegionDraft({
      extractSource: String(next.extractSource || '').trim(),
      extractId: String(next.extractId || '').trim(),
      extractLabel: String(next.extractLabel || '').trim(),
      extractResolutionStatus: 'resolved',
      extractResolutionError: null
    });
    if (options.setStatus !== false) {
      dataStatus.set(dataT('status.extractSelected'));
    }
  }

  function handleRegionSearchQueryInput(event) {
    const nextValue = String(event?.currentTarget?.value || '');
    const currentDraft = get(regionDraft);
    const searchChanged = nextValue !== String(currentDraft.searchQuery || '');

    patchRegionDraft({
      searchQuery: nextValue
    });
    if (searchChanged && (currentDraft.extractId || currentDraft.extractSource)) {
      clearRegionExtractSelection();
    }
    regionExtractCandidates.set([]);
  }

  async function resolveRegionExtractCandidates() {
    const query = String(get(regionDraft).searchQuery || '').trim();
    if (!query) {
      dataStatus.set(dataT('status.resolveExtractMissingQuery'));
      regionExtractCandidates.set([]);
      clearRegionExtractSelection();
      return;
    }

    regionResolveBusy.set(true);
    dataStatus.set(dataT('status.resolvingExtract'));

    try {
      const data = await apiJson('/api/admin/app-settings/data/regions/resolve-extract', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query })
      });
      const items = Array.isArray(data?.items) ? data.items : [];
      regionExtractCandidates.set(items);

      if (items.length === 1) {
        applyRegionExtractCandidate(items[0], { setStatus: false });
        dataStatus.set(dataT('status.extractResolvedSingle'));
        return;
      }

      clearRegionExtractSelection();
      dataStatus.set(
        items.length > 0 ? dataT('status.extractCandidatesLoaded', { count: items.length }) : dataT('status.resolveExtractNoMatches')
      );
    } catch (error) {
      regionExtractCandidates.set([]);
      clearRegionExtractSelection();
      dataStatus.set(msg(error, dataT('status.resolveExtractFailed')));
    } finally {
      regionResolveBusy.set(false);
    }
  }

  function getRegionSyncState(region) {
    const code = String(region?.lastSyncStatus || '')
      .trim()
      .toLowerCase();
    if (code === 'running' || code === 'queued') return 'syncing';
    if (code === 'success') return 'ready';
    if (code === 'idle' && region?.lastSuccessfulSyncAt) return 'ready';
    if (code === 'failed' || code === 'abandoned') return 'failed';
    return 'pending';
  }

  return {
    getMapRegionFeatureMeta,
    findRegionByMapFeature,
    applyRegionDraftFromMapFeature,
    applyRegionExtractCandidate,
    handleRegionSearchQueryInput,
    resolveRegionExtractCandidates,
    getRegionSyncState
  };
}

export function createAdminDataController() {
  const dataSettings = writable(createEmptyDataSettings());
  const dataLoading = writable(false);
  const dataStatus = writable('');
  const filterTagAllowlistDraft = writable([]);
  const filterTagAllowlistSaving = writable(false);
  const filterPresetItems = writable([]);
  const selectedFilterPresetId = writable(null);
  const filterPresetDraft = writable(createFilterPresetDraft());
  const filterPresetLoading = writable(false);
  const filterPresetSaving = writable(false);
  const filterPresetDeleting = writable(false);
  const regionDraft = writable(createRegionDraft());
  const regionSaving = writable(false);
  const regionDeleting = writable(false);
  const regionSyncBusy = writable(false);
  const regionResolveBusy = writable(false);
  const regionExtractCandidates = writable([]);
  const selectedDataRegionId = writable(null);
  const regionRuns = writable([]);
  const regionRunsLoading = writable(false);
  const regionRunsStatus = writable('');
  const initialized = writable(false);
  let nextOptimisticRegionId = -1;
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

  function patchRegionDraft(patch) {
    regionDraft.update((current) => ({
      ...current,
      ...(patch && typeof patch === 'object' ? patch : {})
    }));
  }

  const filterSettingsController = createFilterSettingsController({
    dataSettings,
    dataStatus,
    filterTagAllowlistDraft,
    filterTagAllowlistSaving,
    filterTagAllowlistDirty,
    dataT
  });

  const filterPresetController = createFilterPresetController({
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

  const mapRegionController = createMapRegionController({
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

  function seedFilterPresetItems(filterPresets = null, options = {}) {
    return filterPresetController.seedFilterPresetItems(filterPresets, options);
  }

  function getMapRegionFeatureMeta(feature) {
    return mapRegionController.getMapRegionFeatureMeta(feature);
  }

  function findRegionByMapFeature(feature, regions = null) {
    return mapRegionController.findRegionByMapFeature(feature, regions);
  }

  function applyRegionDraftFromMapFeature(feature) {
    return mapRegionController.applyRegionDraftFromMapFeature(feature);
  }

  function applyRegionExtractCandidate(candidate, options = {}) {
    return mapRegionController.applyRegionExtractCandidate(candidate, options);
  }

  function getRegionById(regionId) {
    return get(dataSettings).regions.find((item) => Number(item?.id || 0) === Number(regionId)) || null;
  }

  function buildRegionSnapshot(region, fallback = null, overrides = {}) {
    const source = region && typeof region === 'object' ? region : {};
    const base = fallback && typeof fallback === 'object' ? fallback : {};

    return {
      ...source,
      id: Number(source?.id || base?.id || 0) || null,
      name: String(source?.name || base?.name || ''),
      slug: String(source?.slug || base?.slug || ''),
      searchQuery: String(source?.searchQuery || base?.searchQuery || ''),
      extractSource: String(source?.extractSource || base?.extractSource || ''),
      extractId: String(source?.extractId || base?.extractId || ''),
      extractLabel: String(source?.extractLabel || base?.extractLabel || ''),
      extractResolutionStatus: String(
        source?.extractResolutionStatus || base?.extractResolutionStatus || 'resolved'
      ),
      extractResolutionError: source?.extractResolutionError ?? base?.extractResolutionError ?? null,
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
    };
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

  function compareRegions(left, right) {
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

  function mergePendingOptimisticRegions(regions = []) {
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

  function upsertRegionSnapshot(region) {
    const snapshot = region && typeof region === 'object' ? region : null;
    const numericRegionId = Number(snapshot?.id || 0);
    if (!snapshot || !Number.isInteger(numericRegionId)) return null;

    let mergedRegion = null;
    dataSettings.update((current) => {
      const regions = Array.isArray(current?.regions) ? current.regions : [];
      const existingRegion = regions.find((item) => Number(item?.id || 0) === numericRegionId) || null;
      mergedRegion = {
        ...(existingRegion && typeof existingRegion === 'object' ? existingRegion : {}),
        ...snapshot
      };

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
      const regions = Array.isArray(current?.regions) ? current.regions : [];
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

  function selectRegionLocally(region, options = {}) {
    const nextRegion = region && typeof region === 'object' ? region : null;
    const numericRegionId = Number(nextRegion?.id || 0);
    const nextSelectedRegionId = Number.isInteger(numericRegionId) && numericRegionId > 0 ? numericRegionId : null;
    const resetRuns = options.resetRuns !== false;

    selectedDataRegionId.set(nextSelectedRegionId);
    regionDraft.set(createRegionDraft(nextRegion));
    regionResolveBusy.set(false);
    regionExtractCandidates.set([]);

    if (!resetRuns) return;

    regionRunsLoading.set(false);
    regionRuns.set([]);
    regionRunsStatus.set(nextSelectedRegionId ? dataT('history.empty') : '');
  }

  async function refreshDataSettingsInBackground(options = {}) {
    const { selectedRegionId = null, preserveStatus = true, silent = true } = options;
    const preservedStatus = get(dataStatus);

    try {
      const currentSettings = get(dataSettings);
      const data = await apiJson('/api/admin/app-settings/data');
      const nextSettings = normalizeDataSettings(data?.item, currentSettings);
      nextSettings.regions = mergePendingOptimisticRegions(nextSettings.regions);

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

  async function loadRegionRuns(regionId) {
    const numericRegionId = Number(regionId || 0);
    if (!Number.isInteger(numericRegionId) || numericRegionId <= 0) {
      regionRuns.set([]);
      regionRunsStatus.set('');
      return;
    }

    regionRunsLoading.set(true);
    regionRunsStatus.set(dataT('status.loadingHistory'));
    try {
      const data = await apiJson(`/api/admin/app-settings/data/regions/${numericRegionId}/runs?limit=10`);
      const items = Array.isArray(data?.items) ? data.items : [];
      regionRuns.set(items);
      regionRunsStatus.set(items.length > 0 ? '' : dataT('history.empty'));
    } catch (error) {
      regionRuns.set([]);
      regionRunsStatus.set(msg(error, dataT('status.loadHistoryFailed')));
    } finally {
      regionRunsLoading.set(false);
    }
  }

  async function selectDataRegion(region) {
    if (isOptimisticRegion(region)) return;

    const numericRegionId = Number(region?.id || 0);
    const nextSelectedRegionId = Number.isInteger(numericRegionId) && numericRegionId > 0 ? numericRegionId : null;

    selectedDataRegionId.set(nextSelectedRegionId);
    regionDraft.set(createRegionDraft(region || null));
    regionResolveBusy.set(false);
    regionExtractCandidates.set([]);

    if (nextSelectedRegionId) {
      await loadRegionRuns(nextSelectedRegionId);
      return;
    }

    regionRunsLoading.set(false);
    regionRuns.set([]);
    regionRunsStatus.set('');
  }

  async function loadDataSettings(options = {}) {
    const { selectedRegionId = null, preserveSelection = true, ignoreUnsavedFilterTags = false } = options;
    if (!ignoreUnsavedFilterTags && !ensureFilterTagChangesDiscarded()) {
      return false;
    }

    dataLoading.set(true);
    dataStatus.set(dataT('status.loadingSettings'));

    try {
      const currentSettings = get(dataSettings);
      const data = await apiJson('/api/admin/app-settings/data');
      const nextSettings = normalizeDataSettings(data?.item, currentSettings);
      nextSettings.regions = mergePendingOptimisticRegions(nextSettings.regions);

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
      const selectedRegion =
        getRegionById(nextSelectedRegionId)
        || nextSettings.regions.find((item) => !isOptimisticRegion(item))
        || nextSettings.regions[0]
        || null;

      await selectDataRegion(selectedRegion);
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

  function patchFilterPresetDraft(patch = {}) {
    return filterPresetController.patchFilterPresetDraft(patch);
  }

  function setFilterPresetDraftLayers(layers = []) {
    return filterPresetController.setFilterPresetDraftLayers(layers);
  }

  function startNewFilterPresetDraft() {
    return filterPresetController.startNewFilterPresetDraft();
  }

  function selectFilterPresetById(id) {
    return filterPresetController.selectFilterPresetById(id);
  }

  async function loadFilterPresets(options = {}) {
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
    regionRunsLoading.set(false);
    regionRuns.set([]);
    regionRunsStatus.set('');
    dataStatus.set('');
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

    const currentDraft = get(regionDraft);
    const isNewRegion = !currentDraft.id;
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
        dataStatus.set(dataT('status.regionSavedQueued'));
        regionSaving.set(false);

        void (async () => {
          try {
            const data = await apiJson('/api/admin/app-settings/data/regions', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ region: payload })
            });
            const savedRegion = data?.item || null;
            const numericRegionId = Number(savedRegion?.id || 0);

            if (optimisticRegionId != null) {
              forgetOptimisticRegion(optimisticRegionId);
              removeRegionSnapshot(optimisticRegionId);
            }

            const queuedRegion = upsertRegionSnapshot(
              buildRegionSnapshot(savedRegion, currentDraft, {
                lastSyncStatus: 'queued',
                lastSyncError: null,
                __optimistic: false
              })
            );

            try {
              if (!Number.isInteger(numericRegionId) || numericRegionId <= 0) {
                throw new Error(dataT('status.regionSavedQueueFailed'));
              }

              await apiJson(`/api/admin/app-settings/data/regions/${numericRegionId}/sync-now`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({})
              });
            } catch (error) {
              const errorText = msg(error, dataT('status.regionSavedQueueFailed'));
              const failedRegion = upsertRegionSnapshot(
                buildRegionSnapshot(queuedRegion || getRegionById(numericRegionId), currentDraft, {
                  lastSyncStatus: 'failed',
                  lastSyncError: errorText,
                  __optimistic: false
                })
              );
              if (failedRegion && Number(get(selectedDataRegionId) || 0) === numericRegionId) {
                selectRegionLocally(failedRegion, { resetRuns: false });
              }
              dataStatus.set(errorText);
            } finally {
              if (Number.isInteger(numericRegionId) && numericRegionId > 0) {
                void refreshDataSettingsInBackground({
                  selectedRegionId: numericRegionId,
                  preserveStatus: true
                });
              }
            }
          } catch (error) {
            if (optimisticRegionId != null) {
              forgetOptimisticRegion(optimisticRegionId);
              removeRegionSnapshot(optimisticRegionId);
            }
            dataStatus.set(msg(error, dataT('status.saveRegionFailed')));
          }
        })();

        return;
      }

      const data = await apiJson('/api/admin/app-settings/data/regions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ region: payload })
      });
      const savedRegion = data?.item || null;
      const numericRegionId = Number(savedRegion?.id || currentDraft.id || 0);
      const optimisticRegion = upsertRegionSnapshot(buildRegionSnapshot(savedRegion, currentDraft));

      if (optimisticRegion) {
        selectRegionLocally(optimisticRegion, { resetRuns: false });
      }

      dataStatus.set(dataT('status.regionSaved'));

      if (Number.isInteger(numericRegionId) && numericRegionId > 0) {
        void refreshDataSettingsInBackground({
          selectedRegionId: numericRegionId,
          preserveStatus: true
        });
      }
    } catch (error) {
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
      await loadDataSettings({
        selectedRegionId: null,
        preserveSelection: false
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

  function formatStorageBytes(value, options = {}) {
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
    getRegionSyncState,
    getRegionStatusMeta,
    getRegionSyncModeLabel,
    getMapRegionFeatureMeta,
    handleRegionSearchQueryInput,
    isFilterTagSelected,
    loadFilterPresets,
    loadDataSettings,
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
    syncRegionNow,
    toggleFilterTagSelection,
    deleteDataRegion,
    deleteFilterPreset
  };
}
