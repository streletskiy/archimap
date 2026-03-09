<script>
  import { createEventDispatcher, onDestroy, onMount } from 'svelte';
  import { fly } from 'svelte/transition';
  import CloseIcon from '$lib/components/icons/CloseIcon.svelte';
  import { apiJson } from '$lib/services/http';
  import {
    buildingFilterRules,
    buildingFilterRuntime,
    resetBuildingFilterRules,
    setBuildingFilterRules
  } from '$lib/stores/filters';
  import { t, translateNow } from '$lib/i18n/index';

  export let open = false;
  export let visibleCount = 0;

  const dispatch = createEventDispatcher();

  let filterRows = [{ id: 1, key: '', op: 'contains', value: '' }];
  let filterTagKeys = [];
  let filterTagKeysRetryTimer = null;

  const FILTER_TAG_LABEL_KEYS = Object.freeze({
    architect: 'header.filterLabels.architect',
    'building:architecture': 'header.filterLabels.building_architecture',
    style: 'header.filterLabels.style',
    year_built: 'header.filterLabels.year_built',
    year_of_construction: 'header.filterLabels.year_of_construction',
    start_date: 'header.filterLabels.start_date',
    'building:start_date': 'header.filterLabels.building_start_date',
    'building:year': 'header.filterLabels.building_year',
    'building:levels': 'header.filterLabels.building_levels',
    levels: 'header.filterLabels.levels',
    'building:colour': 'header.filterLabels.building_colour',
    'building:material': 'header.filterLabels.building_material',
    'building:prefabricated': 'header.filterLabels.building_prefabricated',
    'building:height': 'header.filterLabels.building_height',
    'roof:colour': 'header.filterLabels.roof_colour',
    'roof:shape': 'header.filterLabels.roof_shape',
    'roof:levels': 'header.filterLabels.roof_levels',
    'roof:orientation': 'header.filterLabels.roof_orientation',
    height: 'header.filterLabels.height',
    colour: 'header.filterLabels.colour',
    material: 'header.filterLabels.material',
    name: 'header.filterLabels.name',
    'name:ru': 'header.filterLabels.name_ru',
    'name:en': 'header.filterLabels.name_en',
    address: 'header.filterLabels.address',
    'addr:full': 'header.filterLabels.addr_full',
    'addr:city': 'header.filterLabels.addr_city',
    'addr:street': 'header.filterLabels.addr_street',
    'addr:housenumber': 'header.filterLabels.addr_housenumber',
    'addr:postcode': 'header.filterLabels.addr_postcode',
    amenity: 'header.filterLabels.amenity',
    building: 'header.filterLabels.building'
  });

  const PRIORITY_FILTER_TAG_KEYS = Object.freeze([
    'architect',
    'building:architecture',
    'style',
    'year_built',
    'year_of_construction',
    'start_date',
    'building:start_date',
    'building:year',
    'building:levels',
    'levels'
  ]);

  const APPEARANCE_FILTER_TAG_KEYS = Object.freeze([
    'building:colour',
    'building:material',
    'building:height',
    'roof:colour',
    'roof:shape',
    'roof:levels',
    'roof:orientation',
    'height',
    'colour',
    'material'
  ]);

  const APPEARANCE_FILTER_TAG_PREFIXES = Object.freeze([
    'roof:',
    'facade:',
    'building:facade',
    'building:cladding',
    'building:colour',
    'building:material',
    'building:height',
    'building:shape'
  ]);

  $: activeFilterCount = Array.isArray($buildingFilterRules) ? $buildingFilterRules.length : 0;
  $: draftFilterCount = filterRows.filter((row) => String(row?.key || '').trim().length > 0).length;
  $: visibleCount = open ? draftFilterCount : activeFilterCount;
  $: filterPreviewRules = Array.isArray($buildingFilterRules) ? $buildingFilterRules.slice(0, 3) : [];

  function closePanel() {
    dispatch('close');
  }

  function addFilterRow() {
    const nextId = Math.max(0, ...filterRows.map((row) => Number(row.id) || 0)) + 1;
    filterRows = [...filterRows, { id: nextId, key: '', op: 'contains', value: '' }];
  }

  function updateFilterRow(id, patch) {
    filterRows = filterRows.map((row) => (row.id === id ? { ...row, ...patch } : row));
  }

  function removeFilterRow(id) {
    if (filterRows.length <= 1) {
      filterRows = [{ id: 1, key: '', op: 'contains', value: '' }];
      return;
    }
    filterRows = filterRows.filter((row) => row.id !== id);
  }

  function applyFilters() {
    setBuildingFilterRules(filterRows);
  }

  function resetFilters() {
    filterRows = [{ id: 1, key: '', op: 'contains', value: '' }];
    resetBuildingFilterRules();
  }

  function getFilterRuntimeLabel(runtime) {
    const statusCode = String(runtime?.statusCode || 'idle');
    if (statusCode === 'refining') return $t('header.filterStatus.refining');
    if (statusCode === 'too_many_matches') return $t('header.filterStatus.tooMany');
    if (statusCode === 'truncated') return $t('header.filterStatus.truncated');
    if (statusCode === 'invalid') return $t('header.filterStatus.invalid');
    if (statusCode === 'applied') return $t('header.filterStatus.applied');
    return $t('header.filterStatus.idle');
  }

  function getFilterRuntimeStats(runtime) {
    const count = Number(runtime?.count || 0);
    const elapsedMs = Number(runtime?.elapsedMs || 0);
    return `${$t('header.filterStatus.count')}: ${count}  ${$t('header.filterStatus.elapsed')}: ${elapsedMs}ms`;
  }

  function getFilterOpLabel(op) {
    const normalized = String(op || 'contains');
    if (normalized === 'equals') return translateNow('header.op.equals');
    if (normalized === 'not_equals') return translateNow('header.op.not_equals');
    if (normalized === 'starts_with') return translateNow('header.op.starts_with');
    if (normalized === 'exists') return translateNow('header.op.exists');
    if (normalized === 'not_exists') return translateNow('header.op.not_exists');
    return translateNow('header.op.contains');
  }

  function describeRule(rule) {
    const keyLabel = getFilterTagDisplayName(rule?.key) || translateNow('header.tagKey');
    const opLabel = getFilterOpLabel(rule?.op);
    const value = String(rule?.value || '').trim();
    if (['exists', 'not_exists'].includes(String(rule?.op || ''))) {
      return `${keyLabel} · ${opLabel}`;
    }
    return `${keyLabel} · ${opLabel}${value ? ` · ${value}` : ''}`;
  }

  function getFilterTagDisplayName(tagKey) {
    const key = String(tagKey || '').trim();
    if (!key) return '';
    const labelKey = FILTER_TAG_LABEL_KEYS[key];
    if (!labelKey) return key;
    return translateNow(labelKey);
  }

  function getFilterTagGroupRank(tagKey) {
    const key = String(tagKey || '').trim();
    if (!key) return 2;
    if (PRIORITY_FILTER_TAG_KEYS.includes(key)) return 0;
    if (APPEARANCE_FILTER_TAG_KEYS.includes(key)) return 1;
    if (APPEARANCE_FILTER_TAG_PREFIXES.some((prefix) => key.startsWith(prefix))) return 1;
    return 2;
  }

  function sortFilterTagKeys(keys) {
    return [...new Set((Array.isArray(keys) ? keys : []).map((key) => String(key || '').trim()).filter(Boolean))]
      .sort((a, b) => {
        const aGroup = getFilterTagGroupRank(a);
        const bGroup = getFilterTagGroupRank(b);
        if (aGroup !== bGroup) return aGroup - bGroup;
        const aLabel = getFilterTagDisplayName(a);
        const bLabel = getFilterTagDisplayName(b);
        return aLabel.localeCompare(bLabel, 'ru');
      });
  }

  function scheduleFilterTagKeysRetry(delayMs = 1500) {
    if (filterTagKeysRetryTimer) {
      clearTimeout(filterTagKeysRetryTimer);
    }
    filterTagKeysRetryTimer = setTimeout(() => {
      filterTagKeysRetryTimer = null;
      loadFilterTagKeys();
    }, delayMs);
  }

  async function loadFilterTagKeys() {
    try {
      const payload = await apiJson('/api/filter-tag-keys');
      const keys = Array.isArray(payload?.keys) ? payload.keys : [];
      const warmingUp = Boolean(payload?.warmingUp);
      filterTagKeys = sortFilterTagKeys(keys);
      if (warmingUp && filterTagKeys.length === 0) {
        scheduleFilterTagKeysRetry(1500);
      }
    } catch {
      scheduleFilterTagKeysRetry(2500);
    }
  }

  function handleFilterTagKeysChanged() {
    loadFilterTagKeys();
  }

  onMount(() => {
    if (typeof window !== 'undefined') {
      window.addEventListener('archimap:filter-tag-keys-changed', handleFilterTagKeysChanged);
    }
    loadFilterTagKeys();
  });

  onDestroy(() => {
    if (filterTagKeysRetryTimer) {
      clearTimeout(filterTagKeysRetryTimer);
      filterTagKeysRetryTimer = null;
    }
    if (typeof window !== 'undefined') {
      window.removeEventListener('archimap:filter-tag-keys-changed', handleFilterTagKeysChanged);
    }
  });
</script>

{#if open}
  <div
    id="filter-shell"
    data-testid="filter-panel"
    class="filter-panel"
    in:fly={{ x: -10, y: -8, duration: 190, opacity: 0.2 }}
    out:fly={{ x: -10, y: -8, duration: 170, opacity: 0.2 }}
  >
    <div class="panel-head">
      <div>
        <p class="ui-kicker">OSM</p>
        <h4>{$t('header.filterTitle')}</h4>
      </div>
      <button
        type="button"
        class="ui-btn ui-btn-secondary ui-btn-xs ui-btn-close"
        aria-label={$t('header.closeFilter')}
        on:click={closePanel}
      >
        <CloseIcon class="ui-close-icon" />
      </button>
    </div>
    <div class="filter-runtime" data-filter-runtime-status={$buildingFilterRuntime.statusCode}>
      <strong>{$t('header.filterStatus.label')}: {getFilterRuntimeLabel($buildingFilterRuntime)}</strong>
      <span>{getFilterRuntimeStats($buildingFilterRuntime)}</span>
      {#if activeFilterCount > 0}
        <div class="filter-preview-list">
          {#each filterPreviewRules as rule (`${rule.key}:${rule.op}:${rule.value}`)}
            <span class="ui-chip rule-pill">{describeRule(rule)}</span>
          {/each}
          {#if activeFilterCount > filterPreviewRules.length}
            <span class="ui-chip rule-pill">+{activeFilterCount - filterPreviewRules.length}</span>
          {/if}
        </div>
      {/if}
    </div>
    <div class="rows">
      {#each filterRows as row, index (row.id)}
        <section data-testid="filter-rule-card" class="rule-card">
          <div class="rule-card-head">
            <span class="rule-index">{String(index + 1).padStart(2, '0')}</span>
            <button
              type="button"
              class="ui-btn ui-btn-secondary ui-btn-xs filter-remove-btn"
              aria-label={$t('common.close')}
              on:click={() => removeFilterRow(row.id)}
            >
              <CloseIcon width="14" height="14" />
            </button>
          </div>

          <div class="rule-fields">
            <input
              data-testid="filter-key-input"
              class="ui-field ui-field-xs"
              list="filter-tag-keys"
              placeholder={$t('header.tagKey')}
              value={row.key}
              on:input={(event) => updateFilterRow(row.id, { key: event.currentTarget.value })}
            />
            <select
              data-testid="filter-op-select"
              class="ui-field ui-field-xs"
              value={row.op}
              on:change={(event) => updateFilterRow(row.id, { op: event.currentTarget.value })}
            >
              <option value="contains">{$t('header.op.contains')}</option>
              <option value="equals">{$t('header.op.equals')}</option>
              <option value="not_equals">{$t('header.op.not_equals')}</option>
              <option value="starts_with">{$t('header.op.starts_with')}</option>
              <option value="exists">{$t('header.op.exists')}</option>
              <option value="not_exists">{$t('header.op.not_exists')}</option>
            </select>
            <input
              data-testid="filter-value-input"
              class="ui-field ui-field-xs"
              placeholder={$t('header.tagValue')}
              value={row.value}
              on:input={(event) => updateFilterRow(row.id, { value: event.currentTarget.value })}
              disabled={row.op === 'exists' || row.op === 'not_exists'}
            />
          </div>
        </section>
      {/each}
    </div>
    <div class="filter-actions">
      <button
        type="button"
        data-testid="filter-add-button"
        class="ui-btn ui-btn-secondary ui-btn-xs"
        on:click={addFilterRow}
      >
        {$t('header.addRule')}
      </button>
      <button
        type="button"
        data-testid="filter-reset-button"
        class="ui-btn ui-btn-secondary ui-btn-xs"
        on:click={resetFilters}
      >
        {$t('header.resetRules')}
      </button>
      <button
        type="button"
        data-testid="filter-apply-button"
        class="ui-btn ui-btn-primary ui-btn-xs"
        on:click={applyFilters}
      >
        {$t('header.applyRules')}
      </button>
    </div>
    <datalist id="filter-tag-keys">
      {#each filterTagKeys as key (key)}
        <option value={key} label={getFilterTagDisplayName(key)}>{getFilterTagDisplayName(key)}</option>
      {/each}
    </datalist>
  </div>
{/if}

<style>
  .filter-panel {
    position: absolute;
    top: calc(100% + 0.5rem);
    left: 0.75rem;
    width: min(35rem, calc(100vw - 1.5rem));
    max-height: min(40rem, calc(100vh - 7rem));
    overflow: auto;
    padding: 0.8rem;
    display: grid;
    gap: 0.8rem;
    border: 1px solid var(--panel-border);
    border-radius: 1.2rem;
    background: color-mix(in srgb, var(--panel-solid) 88%, transparent);
    box-shadow: var(--shadow-panel);
    backdrop-filter: blur(18px);
    pointer-events: auto;
    z-index: 2;
  }

  .panel-head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 0.75rem;
  }

  .panel-head h4 {
    margin: 0.18rem 0 0;
    color: var(--fg-strong);
    font-size: 1rem;
  }

  .rows {
    display: grid;
    gap: 0.65rem;
  }

  .filter-runtime {
    display: grid;
    gap: 0.35rem;
    padding: 0.75rem 0.85rem;
    border-radius: 1rem;
    border: 1px solid color-mix(in srgb, var(--accent) 18%, var(--panel-border));
    background: color-mix(in srgb, var(--accent-soft) 76%, var(--panel-solid));
    color: var(--accent-ink);
    font-size: 0.78rem;
    line-height: 1.35;
  }

  .filter-runtime strong {
    font-size: 0.84rem;
  }

  .filter-runtime[data-filter-runtime-status='too_many_matches'],
  .filter-runtime[data-filter-runtime-status='truncated'] {
    border-color: rgba(245, 158, 11, 0.42);
    background: rgba(245, 158, 11, 0.12);
    color: #9a3412;
  }

  .filter-runtime[data-filter-runtime-status='invalid'] {
    border-color: rgba(225, 29, 72, 0.3);
    background: rgba(225, 29, 72, 0.1);
    color: #9f1239;
  }

  .filter-preview-list {
    display: flex;
    flex-wrap: wrap;
    gap: 0.45rem;
    margin-top: 0.25rem;
  }

  .rule-pill {
    background: color-mix(in srgb, var(--panel-solid) 82%, transparent);
  }

  .rule-card {
    padding: 0.85rem;
    border-radius: 1rem;
    border: 1px solid var(--panel-border);
    background: color-mix(in srgb, var(--panel-solid) 76%, transparent);
    display: grid;
    gap: 0.65rem;
  }

  .rule-card-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  .rule-index {
    font-size: 0.72rem;
    font-weight: 800;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--muted);
  }

  .rule-fields {
    display: grid;
    grid-template-columns: minmax(0, 1.1fr) minmax(0, 0.9fr) minmax(0, 1.1fr);
    gap: 0.5rem;
  }

  .filter-actions {
    display: flex;
    gap: 0.45rem;
    flex-wrap: wrap;
  }

  .filter-remove-btn {
    width: 2rem;
    height: 2rem;
    min-width: 2rem;
    min-height: 2rem;
    padding: 0;
    border-radius: 0.65rem;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-size: 0;
    line-height: 0;
  }

  @media (max-width: 768px) {
    .filter-panel {
      left: 0.75rem;
      right: 0.75rem;
      width: auto;
    }

    .rule-fields {
      grid-template-columns: 1fr;
    }
  }
</style>
