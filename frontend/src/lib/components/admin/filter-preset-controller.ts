import { get, type Readable, type Writable } from 'svelte/store';

import { locale } from '$lib/i18n/index';
import { apiJson } from '$lib/services/http';

import {
  buildFilterPresetDraftRecord,
  createFilterPresetDraft,
  getFilterPresetDisplayName,
  getPreferredFilterPresetName,
  normalizeFilterPresetItem,
  normalizeFilterPresetKey,
  normalizeFilterPresetLayersForDraft,
  normalizeFilterPresetLayersForSave,
  normalizeFilterPresetName,
  normalizeFilterPresetNameI18n,
  sortFilterPresetItems
} from './admin-data.shared';

type DataTranslator = (key: string, params?: LooseRecord) => string;

type FilterPresetControllerArgs = {
  dataSettings: Writable<LooseRecord>;
  dataStatus: Writable<string>;
  filterPresetItems: Writable<ReturnType<typeof normalizeFilterPresetItem>[]>;
  selectedFilterPresetId: Writable<number | null>;
  filterPresetDraft: Writable<LooseRecord>;
  filterPresetLoading: Writable<boolean>;
  filterPresetSaving: Writable<boolean>;
  filterPresetDeleting: Writable<boolean>;
  filterPresetDirty: Readable<boolean>;
  dataT: DataTranslator;
};

const msg = (error, fallback) => String(error?.message || fallback);

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
}: FilterPresetControllerArgs) {
  function applyFilterPresetItems(items: LooseRecord[] = [], source = 'db') {
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

  function getFilterPresetById(id: number | string) {
    const numericId = Number(id || 0);
    if (!Number.isInteger(numericId) || numericId <= 0) return null;
    return get(filterPresetItems).find((item) => Number(item?.id || 0) === numericId) || null;
  }

  function selectFilterPresetLocally(preset: LooseRecord | null) {
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

  function seedFilterPresetItems(filterPresets: LooseRecord | null = null, options: LooseRecord = {}) {
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

  function buildFilterPresetPayload(draft: LooseRecord | null = null, options: LooseRecord = {}) {
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
    const normalizedLayers = normalizeFilterPresetLayersForSave(candidate.layers, { dataT });
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

  function patchFilterPresetDraft(patch: LooseRecord = {}) {
    filterPresetDraft.update((current) => {
      const nextPatch = patch && typeof patch === 'object' ? patch : {};
      return {
        ...current,
        ...nextPatch
      };
    });
  }

  function setFilterPresetDraftLayers(layers: LooseRecord[] = []) {
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

  async function loadFilterPresets(options: LooseRecord = {}) {
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

export { createFilterPresetController };

