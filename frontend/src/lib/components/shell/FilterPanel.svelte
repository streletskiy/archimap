<script>
  import { createEventDispatcher, onDestroy, onMount } from 'svelte';
  import { fly } from 'svelte/transition';
  import { UiButton, UiColorPicker, UiInput, UiSelect } from '$lib/components/base';
  import CloseIcon from '$lib/components/icons/CloseIcon.svelte';
  import {
    FILTER_LAYER_BASE_COLOR,
    FILTER_LAYER_COLOR_PALETTE,
    FILTER_PRESETS
  } from '$lib/constants/filter-presets';
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
  let filterModeItems = [];
  let filterOpItems = [];
  let filterTagItems = [];
  const filterLayerColorSwatches = [
    FILTER_LAYER_BASE_COLOR,
    ...FILTER_LAYER_COLOR_PALETTE
  ].filter((color, index, colors) => colors.indexOf(color) === index);

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
  $: filterModeItems = [
    { value: 'and', label: $t('header.filterLayerMode.and') },
    { value: 'or', label: $t('header.filterLayerMode.or') },
    { value: 'layer', label: $t('header.filterLayerMode.layer') }
  ];
  $: filterOpItems = [
    { value: 'contains', label: $t('header.op.contains') },
    { value: 'equals', label: $t('header.op.equals') },
    { value: 'not_equals', label: $t('header.op.not_equals') },
    { value: 'starts_with', label: $t('header.op.starts_with') },
    { value: 'greater_than', label: $t('header.op.greater_than') },
    { value: 'greater_or_equals', label: $t('header.op.greater_or_equals') },
    { value: 'less_than', label: $t('header.op.less_than') },
    { value: 'less_or_equals', label: $t('header.op.less_or_equals') },
    { value: 'exists', label: $t('header.op.exists') },
    { value: 'not_exists', label: $t('header.op.not_exists') }
  ];
  $: filterTagItems = sortFilterTagKeys([
    ...Object.keys(FILTER_TAG_LABEL_KEYS),
    ...filterTagKeys,
    ...collectDraftRuleKeys(draftLayers)
  ]).map((key) => ({
    value: key,
    label: getFilterTagOptionLabel(key)
  }));

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

  function collectDraftRuleKeys(layers) {
    return (Array.isArray(layers) ? layers : []).flatMap((layer) => (
      Array.isArray(layer?.rules)
        ? layer.rules.map((rule) => String(rule?.key || '').trim()).filter(Boolean)
        : []
    ));
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

  function getFilterTagOptionLabel(tagKey) {
    const key = String(tagKey || '').trim();
    if (!key) return '';
    const displayName = getFilterTagDisplayName(key);
    return displayName === key ? key : `${key} - ${displayName}`;
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
        <UiButton
          type="button"
          data-testid="filter-add-layer-button"
          variant="secondary"
          size="xs"
          onclick={addLayer}
        >
          {$t('header.addLayer')}
        </UiButton>
      </div>
      <div class="preset-list">
        {#each FILTER_PRESETS as preset (preset.id)}
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
    </div>

    <div class="rows" role="list">
      {#each draftLayers as layer, index (layer.id)}
        <section
          data-testid="filter-layer-card"
          class="layer-card"
          style:--layer-color={layer.color}
          role="listitem"
          draggable="true"
          on:dragstart={(event) => handleDragStart(event, layer.id)}
          on:dragover={handleDragOver}
          on:drop={(event) => handleDrop(event, layer.id)}
          on:dragend={handleDragEnd}
        >
          <div class="layer-accent"></div>
          <div class="layer-body">
            <div class="layer-head">
              <div class="layer-meta">
                <span class="drag-handle" aria-hidden="true">☰</span>
                <span class="layer-index">{String(index + 1).padStart(2, '0')}</span>
                <UiColorPicker
                  value={layer.color}
                  label={$t('header.layerColor')}
                  swatches={filterLayerColorSwatches}
                  contentClassName="ui-floating-layer-map-filter"
                  onchange={(event) => updateLayer(layer.id, { color: event.detail.value })}
                />
              </div>
              <div class="layer-actions">
                <UiSelect
                  value={layer.mode}
                  items={filterModeItems}
                  size="xs"
                  className="min-w-[5.25rem]"
                  contentClassName="ui-floating-layer-map-filter"
                  onchange={(event) => updateLayer(layer.id, { mode: event.detail.value })}
                />
                <UiButton
                  type="button"
                  variant="secondary"
                  size="square-sm"
                  className="inline-flex h-8 w-8 min-h-8 min-w-8 items-center justify-center rounded-[0.65rem] p-0 text-[0]"
                  aria-label={$t('common.close')}
                  onclick={() => removeLayer(layer.id)}
                >
                  <CloseIcon width="14" height="14" />
                </UiButton>
              </div>
            </div>

            <div class="rule-list">
              {#each layer.rules as rule, ruleIndex (rule.id)}
                <div class="rule-item">
                  <div class="rule-item-head">
                    <span class="rule-item-index">{String(ruleIndex + 1).padStart(2, '0')}</span>
                    <span class="rule-item-label">{$t('header.ruleItem')}</span>
                  </div>
                  <div class="rule-row">
                    <div class="rule-fields">
                      <div data-testid="filter-key-input">
                        <UiSelect
                          items={filterTagItems}
                          value={rule.key || null}
                          size="xs"
                          placeholder={$t('header.tagKey')}
                          contentClassName="ui-floating-layer-map-filter max-h-72"
                          disabled={filterTagItems.length === 0}
                          onchange={(event) => updateRule(layer.id, rule.id, { key: String(event.detail.value || '').trim() })}
                        />
                      </div>
                      <UiSelect
                        data-testid="filter-op-select"
                        items={filterOpItems}
                        value={rule.op}
                        size="xs"
                        className="min-w-[9rem]"
                        contentClassName="ui-floating-layer-map-filter"
                        onchange={(event) => updateRule(layer.id, rule.id, { op: event.detail.value })}
                      />
                      <UiInput
                        data-testid="filter-value-input"
                        size="xs"
                        placeholder={$t('header.tagValue')}
                        value={rule.value}
                        inputmode={isNumericFilterOp(rule.op) ? 'decimal' : 'text'}
                        oninput={(event) => updateRule(layer.id, rule.id, { value: event.currentTarget.value })}
                        disabled={isValuelessFilterOp(rule.op)}
                      />
                    </div>
                    <UiButton
                      type="button"
                      variant="secondary"
                      size="square-sm"
                      className="inline-flex h-8 w-8 min-h-8 min-w-8 items-center justify-center rounded-[0.65rem] p-0 text-[0]"
                      aria-label={$t('common.close')}
                      onclick={() => removeRule(layer.id, rule.id)}
                    >
                      <CloseIcon width="14" height="14" />
                    </UiButton>
                  </div>
                </div>
              {/each}
            </div>

            <UiButton
              type="button"
              variant="secondary"
              size="xs"
              className="justify-self-start"
              onclick={() => addRule(layer.id)}
            >
              {$t('header.addRule')}
            </UiButton>
          </div>
        </section>
      {/each}
    </div>

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
    background: var(--layer-color, var(--accent));
  }

  .layer-body {
    padding: 0.85rem;
    display: grid;
    gap: 0.75rem;
  }

  .layer-head {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    align-items: start;
    gap: 0.75rem;
  }

  .layer-meta,
  .layer-actions {
    display: flex;
    align-items: center;
    gap: 0.45rem;
  }

  .layer-meta {
    min-width: 0;
    flex-wrap: wrap;
  }

  .layer-actions {
    display: grid;
    grid-auto-flow: column;
    grid-auto-columns: max-content;
    align-items: start;
    justify-content: end;
    justify-self: end;
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

  .rule-list {
    display: grid;
    gap: 0.55rem;
  }

  .rule-item {
    display: grid;
    gap: 0.55rem;
    padding: 0.65rem;
    border: 1px solid color-mix(in srgb, var(--panel-border) 86%, transparent);
    border-radius: 0.9rem;
    background: color-mix(in srgb, var(--panel-solid) 88%, transparent);
  }

  .rule-item-head {
    display: flex;
    align-items: center;
    gap: 0.45rem;
    min-width: 0;
  }

  .rule-item-index,
  .rule-item-label {
    font-size: 0.7rem;
    font-weight: 800;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--muted);
  }

  .rule-row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 0.5rem;
    align-items: center;
  }

  .rule-fields {
    display: grid;
    grid-template-columns: minmax(0, 1.15fr) minmax(8.75rem, 0.9fr) minmax(0, 1.15fr);
    gap: 0.5rem;
    align-items: center;
  }

  .rule-fields > * {
    min-width: 0;
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

    .rule-item {
      padding: 0.6rem;
    }

    .preset-head {
      align-items: flex-start;
      flex-direction: column;
    }

    .layer-head {
      grid-template-columns: 1fr;
    }

    .layer-actions {
      justify-content: start;
      justify-self: start;
    }
  }
</style>
