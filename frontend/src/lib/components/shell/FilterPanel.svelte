<script>
  import { createEventDispatcher, onDestroy, onMount } from 'svelte';
  import { fly } from 'svelte/transition';
  import CloseIcon from '$lib/components/icons/CloseIcon.svelte';
  import { FILTER_PRESETS } from '$lib/constants/filter-presets';
  import {
    APPEARANCE_FILTER_TAG_KEYS,
    APPEARANCE_FILTER_TAG_PREFIXES,
    FILTER_TAG_LABEL_KEYS,
    PRIORITY_FILTER_TAG_KEYS
  } from '$lib/constants/filter-tags';
  import { t, translateNow } from '$lib/i18n/index';
  import { apiJson } from '$lib/services/http';
  import {
    buildingFilterLayers,
    buildingFilterRuntime,
    createBuildingFilterLayerDraft,
    createBuildingFilterLayersFromPreset,
    createBuildingFilterRuleDraft,
    getNextBuildingFilterLayerColor,
    resetBuildingFilterLayers,
    setBuildingFilterLayers
  } from '$lib/stores/filters';

  export let open = false;
  export let visibleCount = 0;

  const dispatch = createEventDispatcher();
  const VALUELESS_FILTER_OPS = new Set(['exists', 'not_exists']);
  const NUMERIC_FILTER_OPS = new Set(['greater_than', 'greater_or_equals', 'less_than', 'less_or_equals']);

  let draftLayers = [];
  let filterTagKeys = [];
  let filterTagKeysRetryTimer = null;
  let dragLayerId = '';
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
    const nextLayers = [];
    for (const layer of sourceLayers) {
      nextLayers.push(createBuildingFilterLayerDraft(layer, nextLayers));
    }
    return reindexDraftLayers(nextLayers);
  }

  function reindexDraftLayers(layers) {
    return (Array.isArray(layers) ? layers : []).map((layer, index) => ({
      ...layer,
      priority: index,
      rules: Array.isArray(layer.rules) && layer.rules.length > 0
        ? layer.rules.map((rule) => ({
          id: String(rule?.id || createBuildingFilterRuleDraft().id),
          key: String(rule?.key || '').trim(),
          op: String(rule?.op || 'contains').trim(),
          value: String(rule?.value || '').trim()
        }))
        : [createBuildingFilterRuleDraft()]
    }));
  }

  function hasActiveRule(rule) {
    return String(rule?.key || '').trim().length > 0;
  }

  function hasActiveLayerRules(layer) {
    return Array.isArray(layer?.rules) && layer.rules.some((rule) => hasActiveRule(rule));
  }

  function closePanel() {
    dispatch('close');
  }

  function addLayer() {
    draftLayers = reindexDraftLayers([
      ...draftLayers,
      createBuildingFilterLayerDraft({
        color: getNextBuildingFilterLayerColor(draftLayers)
      }, draftLayers)
    ]);
  }

  function removeLayer(layerId) {
    const nextLayers = draftLayers.filter((layer) => layer.id !== layerId);
    draftLayers = nextLayers.length > 0 ? reindexDraftLayers(nextLayers) : [];
  }

  function updateLayer(layerId, patch) {
    draftLayers = reindexDraftLayers(draftLayers.map((layer) => (
      layer.id === layerId ? { ...layer, ...patch } : layer
    )));
  }

  function addRule(layerId) {
    draftLayers = draftLayers.map((layer) => {
      if (layer.id !== layerId) return layer;
      return {
        ...layer,
        rules: [...layer.rules, createBuildingFilterRuleDraft()]
      };
    });
  }

  function updateRule(layerId, ruleId, patch) {
    draftLayers = draftLayers.map((layer) => {
      if (layer.id !== layerId) return layer;
      return {
        ...layer,
        rules: layer.rules.map((rule) => (rule.id === ruleId ? { ...rule, ...patch } : rule))
      };
    });
  }

  function removeRule(layerId, ruleId) {
    draftLayers = draftLayers.map((layer) => {
      if (layer.id !== layerId) return layer;
      const nextRules = layer.rules.filter((rule) => rule.id !== ruleId);
      return {
        ...layer,
        rules: nextRules.length > 0 ? nextRules : [createBuildingFilterRuleDraft()]
      };
    });
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

  function handleDragStart(event, layerId) {
    dragLayerId = layerId;
    event.dataTransfer?.setData('text/plain', layerId);
    event.dataTransfer.effectAllowed = 'move';
  }

  function handleDragOver(event) {
    event.preventDefault();
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = 'move';
    }
  }

  function handleDrop(event, targetLayerId) {
    event.preventDefault();
    const sourceLayerId = dragLayerId || event.dataTransfer?.getData('text/plain') || '';
    dragLayerId = '';
    if (!sourceLayerId || sourceLayerId === targetLayerId) return;
    const sourceIndex = draftLayers.findIndex((layer) => layer.id === sourceLayerId);
    const targetIndex = draftLayers.findIndex((layer) => layer.id === targetLayerId);
    if (sourceIndex < 0 || targetIndex < 0) return;
    const nextLayers = [...draftLayers];
    const [movedLayer] = nextLayers.splice(sourceIndex, 1);
    nextLayers.splice(targetIndex, 0, movedLayer);
    draftLayers = reindexDraftLayers(nextLayers);
  }

  function handleDragEnd() {
    dragLayerId = '';
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

  function isValuelessFilterOp(op) {
    return VALUELESS_FILTER_OPS.has(String(op || ''));
  }

  function isNumericFilterOp(op) {
    return NUMERIC_FILTER_OPS.has(String(op || ''));
  }

  function getFilterModeLabel(mode) {
    return translateNow(`header.filterLayerMode.${String(mode || 'and')}`);
  }

  function getPresetLabel(preset) {
    return translateNow(preset?.labelKey) || String(preset?.fallbackLabel || '');
  }

  function describeRule(rule) {
    const keyLabel = getFilterTagDisplayName(rule?.key) || translateNow('header.tagKey');
    const opLabel = getFilterOpLabel(rule?.op);
    const value = String(rule?.value || '').trim();
    if (isValuelessFilterOp(rule?.op)) {
      return `${keyLabel} · ${opLabel}`;
    }
    return `${keyLabel} · ${opLabel}${value ? ` · ${value}` : ''}`;
  }

  function describeLayer(layer) {
    const modeLabel = getFilterModeLabel(layer?.mode);
    const rules = Array.isArray(layer?.rules) ? layer.rules.filter((rule) => hasActiveRule(rule)).slice(0, 2) : [];
    if (rules.length === 0) return modeLabel;
    const suffix = layer.rules.filter((rule) => hasActiveRule(rule)).length > rules.length
      ? ` +${layer.rules.filter((rule) => hasActiveRule(rule)).length - rules.length}`
      : '';
    return `${modeLabel} · ${rules.map((rule) => describeRule(rule)).join(' · ')}${suffix}`;
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
          {#each filterPreviewLayers as layer (layer.id)}
            <span class="ui-chip layer-pill" style={`--layer-color:${layer.color};`}>
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
        <button
          type="button"
          data-testid="filter-add-layer-button"
          class="ui-btn ui-btn-secondary ui-btn-xs"
          on:click={addLayer}
        >
          {$t('header.addLayer')}
        </button>
      </div>
      <div class="preset-list">
        {#each FILTER_PRESETS as preset (preset.id)}
          <button
            type="button"
            class="ui-btn ui-btn-secondary ui-btn-xs preset-chip"
            on:click={() => applyPreset(preset)}
          >
            {getPresetLabel(preset)}
          </button>
        {/each}
      </div>
    </div>

    <div class="rows" role="list">
      {#each draftLayers as layer, index (layer.id)}
        <section
          data-testid="filter-layer-card"
          class="layer-card"
          role="listitem"
          draggable="true"
          on:dragstart={(event) => handleDragStart(event, layer.id)}
          on:dragover={handleDragOver}
          on:drop={(event) => handleDrop(event, layer.id)}
          on:dragend={handleDragEnd}
        >
          <div class="layer-accent" style={`background:${layer.color};`}></div>
          <div class="layer-body">
            <div class="layer-head">
              <div class="layer-meta">
                <span class="drag-handle" aria-hidden="true">☰</span>
                <span class="layer-index">{String(index + 1).padStart(2, '0')}</span>
                <label class="color-swatch" style={`--swatch-color:${layer.color};`}>
                  <input
                    type="color"
                    value={layer.color}
                    aria-label={getFilterModeLabel(layer.mode)}
                    on:input={(event) => updateLayer(layer.id, { color: event.currentTarget.value })}
                  />
                  <span class="color-swatch-dot" aria-hidden="true"></span>
                </label>
              </div>
              <div class="layer-actions">
                <select
                  class="ui-field ui-field-xs mode-select"
                  value={layer.mode}
                  on:change={(event) => updateLayer(layer.id, { mode: event.currentTarget.value })}
                >
                  <option value="and">{getFilterModeLabel('and')}</option>
                  <option value="or">{getFilterModeLabel('or')}</option>
                  <option value="layer">{getFilterModeLabel('layer')}</option>
                </select>
                <button
                  type="button"
                  class="ui-btn ui-btn-secondary ui-btn-xs filter-remove-btn"
                  aria-label={$t('common.close')}
                  on:click={() => removeLayer(layer.id)}
                >
                  <CloseIcon width="14" height="14" />
                </button>
              </div>
            </div>

            <div class="rule-list">
              {#each layer.rules as rule (rule.id)}
                <div class="rule-row">
                  <div class="rule-fields">
                    <input
                      data-testid="filter-key-input"
                      class="ui-field ui-field-xs"
                      list="filter-tag-keys"
                      placeholder={$t('header.tagKey')}
                      value={rule.key}
                      on:input={(event) => updateRule(layer.id, rule.id, { key: event.currentTarget.value })}
                    />
                    <select
                      data-testid="filter-op-select"
                      class="ui-field ui-field-xs"
                      value={rule.op}
                      on:change={(event) => updateRule(layer.id, rule.id, { op: event.currentTarget.value })}
                    >
                      <option value="contains">{$t('header.op.contains')}</option>
                      <option value="equals">{$t('header.op.equals')}</option>
                      <option value="not_equals">{$t('header.op.not_equals')}</option>
                      <option value="starts_with">{$t('header.op.starts_with')}</option>
                      <option value="greater_than">{$t('header.op.greater_than')}</option>
                      <option value="greater_or_equals">{$t('header.op.greater_or_equals')}</option>
                      <option value="less_than">{$t('header.op.less_than')}</option>
                      <option value="less_or_equals">{$t('header.op.less_or_equals')}</option>
                      <option value="exists">{$t('header.op.exists')}</option>
                      <option value="not_exists">{$t('header.op.not_exists')}</option>
                    </select>
                    <input
                      data-testid="filter-value-input"
                      class="ui-field ui-field-xs"
                      placeholder={$t('header.tagValue')}
                      value={rule.value}
                      inputmode={isNumericFilterOp(rule.op) ? 'decimal' : 'text'}
                      on:input={(event) => updateRule(layer.id, rule.id, { value: event.currentTarget.value })}
                      disabled={isValuelessFilterOp(rule.op)}
                    />
                  </div>
                  <button
                    type="button"
                    class="ui-btn ui-btn-secondary ui-btn-xs filter-remove-btn rule-remove-btn"
                    aria-label={$t('common.close')}
                    on:click={() => removeRule(layer.id, rule.id)}
                  >
                    <CloseIcon width="14" height="14" />
                  </button>
                </div>
              {/each}
            </div>

            <button
              type="button"
              class="ui-btn ui-btn-secondary ui-btn-xs layer-add-rule"
              on:click={() => addRule(layer.id)}
            >
              {$t('header.addRule')}
            </button>
          </div>
        </section>
      {/each}
    </div>

    <div class="filter-actions">
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

  .preset-section,
  .rows {
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

  .layer-card {
    display: grid;
    grid-template-columns: 0.42rem minmax(0, 1fr);
    border-radius: 1rem;
    border: 1px solid var(--panel-border);
    background: color-mix(in srgb, var(--panel-solid) 76%, transparent);
    overflow: hidden;
  }

  .layer-accent {
    min-height: 100%;
  }

  .layer-body {
    padding: 0.85rem;
    display: grid;
    gap: 0.75rem;
  }

  .layer-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
  }

  .layer-meta,
  .layer-actions {
    display: flex;
    align-items: center;
    gap: 0.45rem;
  }

  .drag-handle,
  .layer-index {
    font-size: 0.74rem;
    font-weight: 800;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--muted);
  }

  .drag-handle {
    cursor: grab;
    user-select: none;
  }

  .color-swatch {
    position: relative;
    flex: 0 0 auto;
    display: inline-grid;
    place-items: center;
    width: 1.3rem;
    height: 1.3rem;
    cursor: pointer;
  }

  .color-swatch input {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    margin: 0;
    border: 0;
    padding: 0;
    background: transparent;
    opacity: 0;
    appearance: none;
    -webkit-appearance: none;
    cursor: pointer;
  }

  .color-swatch-dot {
    width: 100%;
    height: 100%;
    border-radius: 999px;
    border: 1px solid color-mix(in srgb, var(--panel-border) 80%, transparent);
    background: var(--swatch-color, var(--accent));
    box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.22);
    pointer-events: none;
  }

  .color-swatch input:focus-visible + .color-swatch-dot {
    outline: 2px solid color-mix(in srgb, var(--accent) 72%, white);
    outline-offset: 2px;
  }

  .rule-list {
    display: grid;
    gap: 0.55rem;
  }

  .rule-row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 0.45rem;
    align-items: start;
  }

  .rule-fields {
    display: grid;
    grid-template-columns: minmax(0, 1.15fr) minmax(0, 0.85fr) minmax(0, 1.15fr);
    gap: 0.5rem;
  }

  .mode-select {
    min-width: 5rem;
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

  .layer-add-rule {
    justify-self: flex-start;
  }

  @media (max-width: 720px) {
    .filter-panel {
      right: auto;
      left: 0.5rem;
      width: calc(100vw - 1rem);
    }

    .rule-row {
      grid-template-columns: 1fr;
    }

    .rule-fields {
      grid-template-columns: 1fr;
    }

    .preset-head,
    .layer-head {
      align-items: flex-start;
      flex-direction: column;
    }
  }
</style>
