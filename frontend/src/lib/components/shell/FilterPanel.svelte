<script>
  import { createEventDispatcher, onDestroy, onMount } from 'svelte';
  import { fly } from 'svelte/transition';

  import { UiButton } from '$lib/components/base';
  import FilterLayersEditor from '$lib/components/filters/FilterLayersEditor.svelte';
  import CloseIcon from '$lib/components/icons/CloseIcon.svelte';
  import { locale, t, translateNow } from '$lib/i18n/index';
  import { apiJson } from '$lib/services/http';
  import {
    buildingFilterLayers,
    buildingFilterRuntime,
    createBuildingFilterLayerDraft,
    createBuildingFilterLayersFromPreset,
    resetBuildingFilterLayers,
    setBuildingFilterLayers
  } from '$lib/stores/filters';

  export let open = false;
  export let visibleCount = 0;

  const dispatch = createEventDispatcher();
  const VALUELESS_FILTER_OPS = new Set(['exists', 'not_exists']);

  let draftLayers = [];
  let filterTagKeys = [];
  let filterTagKeysLoading = false;
  let filterTagKeysError = '';
  let filterTagKeysRetryTimer = null;
  let filterPresets = [];
  let filterPresetsLoading = false;
  let filterPresetsError = '';
  let filterPresetsRetryTimer = null;
  let panelWasOpen = false;

  $: if (open && !panelWasOpen) {
    draftLayers = buildDraftLayers($buildingFilterLayers);
    panelWasOpen = true;
  }

  $: if (!open && panelWasOpen) {
    panelWasOpen = false;
  }

  $: activeFilterCount = Array.isArray($buildingFilterLayers) ? $buildingFilterLayers.length : 0;
  $: draftFilterCount = draftLayers.filter((layer) => hasActiveLayerRules(layer)).length;
  $: visibleCount = open ? draftFilterCount : activeFilterCount;
  $: filterPreviewLayers = Array.isArray($buildingFilterLayers) ? $buildingFilterLayers.slice(0, 3) : [];

  function buildDraftLayers(layers) {
    const sourceLayers = Array.isArray(layers) && layers.length > 0 ? layers : [{}];
    return sourceLayers.map((layer, index, source) => createBuildingFilterLayerDraft({
      ...layer,
      priority: index
    }, source.slice(0, index)));
  }

  function hasActiveLayerRules(layer) {
    return Array.isArray(layer?.rules)
      && layer.rules.some((rule) => String(rule?.key || '').trim().length > 0);
  }

  function closePanel() {
    dispatch('close');
  }

  function handleEditorChange(event) {
    const nextLayers = Array.isArray(event?.detail?.layers) ? event.detail.layers : [];
    draftLayers = nextLayers;
  }

  function applyFilters() {
    setBuildingFilterLayers(draftLayers);
  }

  function resetFilters() {
    draftLayers = buildDraftLayers([]);
    resetBuildingFilterLayers();
  }

  function applyPreset(preset) {
    const presetLayers = createBuildingFilterLayersFromPreset(preset);
    draftLayers = buildDraftLayers(presetLayers);
    setBuildingFilterLayers(presetLayers);
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
    if (normalized === 'greater_than') return translateNow('header.op.greater_than');
    if (normalized === 'greater_or_equals') return translateNow('header.op.greater_or_equals');
    if (normalized === 'less_than') return translateNow('header.op.less_than');
    if (normalized === 'less_or_equals') return translateNow('header.op.less_or_equals');
    if (normalized === 'exists') return translateNow('header.op.exists');
    if (normalized === 'not_exists') return translateNow('header.op.not_exists');
    return translateNow('header.op.contains');
  }

  function getFilterModeLabel(mode) {
    return translateNow(`header.filterLayerMode.${String(mode || 'and')}`);
  }

  function getPresetLabel(preset) {
    const currentLocale = String($locale || 'en').trim().toLowerCase();
    const localized = String(preset?.nameI18n?.[currentLocale] || '').trim();
    return localized || String(preset?.name || preset?.key || '').trim();
  }

  function describeRule(rule) {
    const keyLabel = String(rule?.key || '').trim() || translateNow('header.tagKey');
    const opLabel = getFilterOpLabel(rule?.op);
    const value = String(rule?.value || '').trim();
    if (VALUELESS_FILTER_OPS.has(String(rule?.op || ''))) {
      return `${keyLabel} · ${opLabel}`;
    }
    return `${keyLabel} · ${opLabel}${value ? ` · ${value}` : ''}`;
  }

  function describeLayer(layer) {
    const modeLabel = getFilterModeLabel(layer?.mode);
    const activeRules = Array.isArray(layer?.rules)
      ? layer.rules.filter((rule) => String(rule?.key || '').trim().length > 0)
      : [];
    const rules = activeRules.slice(0, 2);
    if (rules.length === 0) return modeLabel;
    const suffix = activeRules.length > rules.length ? ` +${activeRules.length - rules.length}` : '';
    return `${modeLabel} · ${rules.map((rule) => describeRule(rule)).join(' · ')}${suffix}`;
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
    filterTagKeysLoading = true;
    filterTagKeysError = '';
    try {
      const payload = await apiJson('/api/filter-tag-keys');
      const keys = Array.isArray(payload?.keys) ? payload.keys : [];
      const warmingUp = Boolean(payload?.warmingUp);
      filterTagKeys = keys;
      if (warmingUp && filterTagKeys.length === 0) {
        scheduleFilterTagKeysRetry(1500);
      }
    } catch {
      filterTagKeysError = $t('header.filterTagKeysLoadFailed');
      scheduleFilterTagKeysRetry(2500);
    } finally {
      filterTagKeysLoading = false;
    }
  }

  function scheduleFilterPresetsRetry(delayMs = 2500) {
    if (filterPresetsRetryTimer) {
      clearTimeout(filterPresetsRetryTimer);
    }
    filterPresetsRetryTimer = setTimeout(() => {
      filterPresetsRetryTimer = null;
      loadFilterPresets();
    }, delayMs);
  }

  async function loadFilterPresets() {
    filterPresetsLoading = true;
    filterPresetsError = '';
    try {
      const payload = await apiJson('/api/filter-presets');
      filterPresets = Array.isArray(payload?.items) ? payload.items : [];
    } catch {
      filterPresetsError = $t('header.presets.loadFailed');
      scheduleFilterPresetsRetry(3000);
    } finally {
      filterPresetsLoading = false;
    }
  }

  function handleFilterTagKeysChanged() {
    loadFilterTagKeys();
  }

  function handleFilterPresetsChanged() {
    loadFilterPresets();
  }

  onMount(() => {
    if (typeof window !== 'undefined') {
      window.addEventListener('archimap:filter-tag-keys-changed', handleFilterTagKeysChanged);
      window.addEventListener('archimap:filter-presets-changed', handleFilterPresetsChanged);
    }
    loadFilterTagKeys();
    loadFilterPresets();
  });

  onDestroy(() => {
    if (filterTagKeysRetryTimer) {
      clearTimeout(filterTagKeysRetryTimer);
      filterTagKeysRetryTimer = null;
    }
    if (filterPresetsRetryTimer) {
      clearTimeout(filterPresetsRetryTimer);
      filterPresetsRetryTimer = null;
    }
    if (typeof window !== 'undefined') {
      window.removeEventListener('archimap:filter-tag-keys-changed', handleFilterTagKeysChanged);
      window.removeEventListener('archimap:filter-presets-changed', handleFilterPresetsChanged);
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
      <UiButton
        type="button"
        variant="secondary"
        size="close"
        aria-label={$t('header.closeFilter')}
        onclick={closePanel}
      >
        <CloseIcon class="ui-close-icon" />
      </UiButton>
    </div>

    <div class="filter-runtime" data-filter-runtime-status={$buildingFilterRuntime.statusCode}>
      <strong>{$t('header.filterStatus.label')}: {getFilterRuntimeLabel($buildingFilterRuntime)}</strong>
      <span>{getFilterRuntimeStats($buildingFilterRuntime)}</span>
      {#if activeFilterCount > 0}
        <div class="filter-preview-list">
          {#each filterPreviewLayers as layer (layer.id)}
            <span class="ui-chip layer-pill" style:--layer-color={layer.color}>
              {describeLayer(layer)}
            </span>
          {/each}
          {#if activeFilterCount > filterPreviewLayers.length}
            <span class="ui-chip layer-pill">+{activeFilterCount - filterPreviewLayers.length}</span>
          {/if}
        </div>
      {/if}
    </div>

    <div class="preset-section">
      <div class="preset-head">
        <span class="section-label">{$t('header.presets.title')}</span>
      </div>
      {#if filterPresetsError}
        <p class="text-xs text-red-600">{filterPresetsError}</p>
      {/if}
      {#if filterPresetsLoading && filterPresets.length === 0}
        <p class="text-xs ui-text-subtle">{$t('header.presets.loading')}</p>
      {:else if filterPresets.length === 0}
        <p class="text-xs ui-text-subtle">{$t('header.presets.empty')}</p>
      {:else}
        <div class="preset-list">
          {#each filterPresets as preset (preset.id)}
            <UiButton
              type="button"
              variant="secondary"
              size="xs"
              onclick={() => applyPreset(preset)}
            >
              {getPresetLabel(preset)}
            </UiButton>
          {/each}
        </div>
      {/if}
    </div>

    <FilterLayersEditor
      layers={draftLayers}
      {filterTagKeys}
      {filterTagKeysLoading}
      {filterTagKeysError}
      selectContentClassName="ui-floating-layer-map-filter max-h-72"
      colorPickerContentClassName="ui-floating-layer-map-filter"
      addLayerButtonLabel={$t('header.addLayer')}
      addLayerButtonTestId="filter-add-layer-button"
      loadingTagKeysLabel={$t('header.filterTagKeysLoading')}
      emptyTagKeysLabel={$t('header.filterTagKeysEmpty')}
      on:change={handleEditorChange}
    />

    <div class="filter-actions">
      <UiButton
        type="button"
        data-testid="filter-reset-button"
        variant="secondary"
        size="xs"
        onclick={resetFilters}
      >
        {$t('header.resetRules')}
      </UiButton>
      <UiButton
        type="button"
        data-testid="filter-apply-button"
        size="xs"
        onclick={applyFilters}
      >
        {$t('header.applyRules')}
      </UiButton>
    </div>

  </div>
{/if}

<style>
  .filter-panel {
    position: absolute;
    top: calc(100% + 0.5rem);
    right: 0.75rem;
    width: min(39rem, calc(100vw - 1.5rem));
    max-height: min(42rem, calc(100vh - 7rem));
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

  .filter-preview-list,
  .preset-list,
  .filter-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 0.45rem;
  }

  .layer-pill {
    border-left: 0.26rem solid var(--layer-color, var(--accent));
    background: color-mix(in srgb, var(--panel-solid) 82%, transparent);
  }

  .preset-section {
    display: grid;
    gap: 0.65rem;
  }

  .preset-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
  }

  .section-label {
    font-size: 0.78rem;
    font-weight: 700;
    color: var(--muted);
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }

  @media (max-width: 720px) {
    .filter-panel {
      right: auto;
      left: 0.5rem;
      width: calc(100vw - 1rem);
    }

    .preset-head {
      align-items: flex-start;
      flex-direction: column;
    }
  }
</style>
