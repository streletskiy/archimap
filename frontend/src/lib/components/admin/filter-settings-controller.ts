import { get, type Readable, type Writable } from 'svelte/store';

import { apiJson } from '$lib/services/http';

type DataTranslator = (key: string, params?: LooseRecord) => string;

type FilterSettingsControllerArgs = {
  dataSettings: Writable<LooseRecord>;
  dataStatus: Writable<string>;
  filterTagAllowlistDraft: Writable<string[]>;
  filterTagAllowlistSaving: Writable<boolean>;
  filterTagAllowlistDirty: Readable<boolean>;
  dataT: DataTranslator;
};

const msg = (error, fallback) => String(error?.message || fallback);

function createFilterSettingsController({
  dataSettings,
  dataStatus,
  filterTagAllowlistDraft,
  filterTagAllowlistSaving,
  filterTagAllowlistDirty,
  dataT
}: FilterSettingsControllerArgs) {
  function seedFilterTagAllowlistDraft(filterTags: LooseRecord | null = null) {
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

export { createFilterSettingsController };
