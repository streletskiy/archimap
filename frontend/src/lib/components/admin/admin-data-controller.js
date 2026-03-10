import { derived, get, writable } from 'svelte/store';

import { translateNow } from '$lib/i18n/index';
import { apiJson } from '$lib/services/http';

const DATA_I18N_PREFIX = 'admin.data';

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
    }
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
    }
  };
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

export function createAdminDataController() {
  const dataSettings = writable(createEmptyDataSettings());
  const dataLoading = writable(false);
  const dataStatus = writable('');
  const filterTagAllowlistDraft = writable([]);
  const filterTagAllowlistSaving = writable(false);
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

  const sortedAvailableFilterTagKeys = derived(dataSettings, ($dataSettings) =>
    sortFilterTagKeys($dataSettings?.filterTags?.availableKeys, getSavedFilterTagAllowlist($dataSettings))
  );

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

  function seedFilterTagAllowlistDraft(filterTags = null) {
    const current = filterTags && typeof filterTags === 'object' ? filterTags : {};
    filterTagAllowlistDraft.set(Array.isArray(current.allowlist) ? [...current.allowlist] : []);
  }

  function patchRegionDraft(patch) {
    regionDraft.update((current) => ({
      ...current,
      ...(patch && typeof patch === 'object' ? patch : {})
    }));
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

  function getRegionById(regionId) {
    return get(dataSettings).regions.find((item) => Number(item?.id || 0) === Number(regionId)) || null;
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

      dataSettings.set(nextSettings);
      seedFilterTagAllowlistDraft(nextSettings.filterTags);

      const nextSelectedRegionId =
        selectedRegionId != null
          ? Number(selectedRegionId || 0)
          : preserveSelection
            ? Number(get(selectedDataRegionId) || 0)
            : 0;
      const selectedRegion = getRegionById(nextSelectedRegionId) || nextSettings.regions[0] || null;

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

  async function saveDataRegion(event) {
    event?.preventDefault?.();
    if (!ensureFilterTagChangesDiscarded()) return;

    regionSaving.set(true);
    dataStatus.set(dataT('status.savingRegion'));

    try {
      const currentDraft = get(regionDraft);
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
      const data = await apiJson('/api/admin/app-settings/data/regions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ region: payload })
      });
      const savedRegion = data?.item || null;

      await loadDataSettings({
        selectedRegionId: savedRegion?.id || currentDraft.id || null,
        preserveSelection: false
      });
      dataStatus.set(dataT('status.regionSaved'));
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
      await apiJson(`/api/admin/app-settings/data/regions/${numericRegionId}/sync-now`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      });
      await loadDataSettings({
        selectedRegionId: numericRegionId,
        preserveSelection: false
      });
      dataStatus.set(dataT('status.queuedSync'));
    } catch (error) {
      dataStatus.set(msg(error, dataT('status.syncFailed')));
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

  function getRegionStatusMeta(status) {
    const code = String(status || 'idle')
      .trim()
      .toLowerCase();
    if (code === 'running') return { text: dataT('runStatus.running'), tone: 'running' };
    if (code === 'queued') return { text: dataT('runStatus.queued'), tone: 'queued' };
    if (code === 'failed' || code === 'abandoned') return { text: dataT('runStatus.failed'), tone: 'failed' };
    if (code === 'success') return { text: dataT('runStatus.success'), tone: 'success' };
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
    if (state === 'enabled_pending') return 'filter-tag-option-enabled-pending';
    if (state === 'disabled_pending') return 'filter-tag-option-disabled-pending';
    return 'filter-tag-option-unchanged';
  }

  function isFilterTagSelected(key) {
    return get(filterTagAllowlistDraft).includes(String(key || '').trim());
  }

  return {
    dataSettings,
    dataLoading,
    dataStatus,
    filterTagAllowlistDraft,
    filterTagAllowlistSaving,
    sortedAvailableFilterTagKeys,
    filterTagAllowlistDirty,
    filterTagDraftStateByKey,
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
    getRegionById,
    getRegionEnabledLabel,
    getRegionExtractPrimaryText,
    getRegionExtractSecondaryText,
    getRegionStatusMeta,
    getRegionSyncModeLabel,
    handleRegionSearchQueryInput,
    isFilterTagSelected,
    loadDataSettings,
    patchRegionDraft,
    resetFilterTagAllowlistToDefault,
    resolveRegionExtractCandidates,
    saveDataRegion,
    saveFilterTagAllowlist,
    selectDataRegion,
    startNewRegionDraft,
    syncRegionNow,
    toggleFilterTagSelection,
    deleteDataRegion
  };
}
