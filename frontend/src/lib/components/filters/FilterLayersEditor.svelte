<script>
  import { createEventDispatcher } from 'svelte';

  import { UiButton, UiColorPicker, UiInput, UiSelect } from '$lib/components/base';
  import CloseIcon from '$lib/components/icons/CloseIcon.svelte';
  import {
    APPEARANCE_FILTER_TAG_KEYS,
    APPEARANCE_FILTER_TAG_PREFIXES,
    FILTER_TAG_LABEL_KEYS,
    PRIORITY_FILTER_TAG_KEYS
  } from '$lib/constants/filter-tags';
  import {
    FILTER_LAYER_BASE_COLOR,
    FILTER_LAYER_COLOR_PALETTE
  } from '$lib/constants/filter-presets';
  import { t, translateNow } from '$lib/i18n/index';
  import {
    createBuildingFilterLayerDraft,
    createBuildingFilterRuleDraft,
    getNextBuildingFilterLayerColor
  } from '$lib/stores/filters';

  export let layers = [];
  export let filterTagKeys = [];
  export let filterTagKeysLoading = false;
  export let filterTagKeysLoadError = '';
  export let selectContentClassName = '';
  export let colorPickerContentClassName = '';
  export let addLayerButtonLabel = '';
  export let addLayerButtonTestId = '';
  export let loadingTagKeysLabel = '';
  export let emptyTagKeysLabel = '';
  export let disabled = false;

  const dispatch = createEventDispatcher();
  const VALUELESS_FILTER_OPS = new Set(['exists', 'not_exists']);
  const NUMERIC_FILTER_OPS = new Set(['greater_than', 'greater_or_equals', 'less_than', 'less_or_equals']);

  let dragLayerId = '';

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
  $: normalizedLayers = reindexDraftLayers(layers);
  $: filterTagItems = sortFilterTagKeys([
    ...Object.keys(FILTER_TAG_LABEL_KEYS),
    ...(Array.isArray(filterTagKeys) ? filterTagKeys : []),
    ...collectDraftRuleKeys(normalizedLayers)
  ]).map((key) => ({
    value: key,
    label: getFilterTagOptionLabel(key)
  }));

  const filterLayerColorSwatches = [
    FILTER_LAYER_BASE_COLOR,
    ...FILTER_LAYER_COLOR_PALETTE
  ].filter((color, index, colors) => colors.indexOf(color) === index);

  function emitLayers(nextLayers) {
    dispatch('change', {
      layers: reindexDraftLayers(nextLayers)
    });
  }

  function reindexDraftLayers(value) {
    return (Array.isArray(value) ? value : []).map((layer, index, sourceLayers) => createBuildingFilterLayerDraft({
      ...layer,
      priority: index,
      rules: Array.isArray(layer?.rules) && layer.rules.length > 0
        ? layer.rules.map((rule) => ({
          id: String(rule?.id || createBuildingFilterRuleDraft().id),
          key: String(rule?.key || '').trim(),
          op: String(rule?.op || 'contains').trim(),
          value: String(rule?.value || '').trim()
        }))
        : [createBuildingFilterRuleDraft()]
    }, sourceLayers.slice(0, index)));
  }

  function collectDraftRuleKeys(value) {
    return (Array.isArray(value) ? value : []).flatMap((layer) => (
      Array.isArray(layer?.rules)
        ? layer.rules.map((rule) => String(rule?.key || '').trim()).filter(Boolean)
        : []
    ));
  }

  function addLayer() {
    const current = reindexDraftLayers(layers);
    emitLayers([
      ...current,
      createBuildingFilterLayerDraft({
        color: getNextBuildingFilterLayerColor(current)
      }, current)
    ]);
  }

  function removeLayer(layerId) {
    const current = reindexDraftLayers(layers);
    emitLayers(current.filter((layer) => layer.id !== layerId));
  }

  function updateLayer(layerId, patch) {
    const current = reindexDraftLayers(layers);
    emitLayers(current.map((layer) => (
      layer.id === layerId ? { ...layer, ...patch } : layer
    )));
  }

  function addRule(layerId) {
    const current = reindexDraftLayers(layers);
    emitLayers(current.map((layer) => {
      if (layer.id !== layerId) return layer;
      return {
        ...layer,
        rules: [...layer.rules, createBuildingFilterRuleDraft()]
      };
    }));
  }

  function updateRule(layerId, ruleId, patch) {
    const current = reindexDraftLayers(layers);
    emitLayers(current.map((layer) => {
      if (layer.id !== layerId) return layer;
      return {
        ...layer,
        rules: layer.rules.map((rule) => (rule.id === ruleId ? { ...rule, ...patch } : rule))
      };
    }));
  }

  function removeRule(layerId, ruleId) {
    const current = reindexDraftLayers(layers);
    emitLayers(current.map((layer) => {
      if (layer.id !== layerId) return layer;
      const nextRules = layer.rules.filter((rule) => rule.id !== ruleId);
      return {
        ...layer,
        rules: nextRules.length > 0 ? nextRules : [createBuildingFilterRuleDraft()]
      };
    }));
  }

  function handleDragStart(event, layerId) {
    if (disabled) return;
    dragLayerId = layerId;
    event.dataTransfer?.setData('text/plain', layerId);
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = 'move';
    }
  }

  function handleDragOver(event) {
    if (disabled) return;
    event.preventDefault();
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = 'move';
    }
  }

  function handleDrop(event, targetLayerId) {
    if (disabled) return;
    event.preventDefault();
    const sourceLayerId = dragLayerId || event.dataTransfer?.getData('text/plain') || '';
    dragLayerId = '';
    if (!sourceLayerId || sourceLayerId === targetLayerId) return;
    const current = reindexDraftLayers(layers);
    const sourceIndex = current.findIndex((layer) => layer.id === sourceLayerId);
    const targetIndex = current.findIndex((layer) => layer.id === targetLayerId);
    if (sourceIndex < 0 || targetIndex < 0) return;
    const nextLayers = [...current];
    const [movedLayer] = nextLayers.splice(sourceIndex, 1);
    nextLayers.splice(targetIndex, 0, movedLayer);
    emitLayers(nextLayers);
  }

  function handleDragEnd() {
    dragLayerId = '';
  }

  function isValuelessFilterOp(op) {
    return VALUELESS_FILTER_OPS.has(String(op || ''));
  }

  function isNumericFilterOp(op) {
    return NUMERIC_FILTER_OPS.has(String(op || ''));
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
</script>

<div class="rows" role="list">
  {#if normalizedLayers.length === 0}
    <p class="rounded-xl border border-dashed ui-border-strong px-3 py-4 text-sm ui-text-subtle">
      {$t('header.noLayers')}
    </p>
  {:else}
    {#each normalizedLayers as layer, index (layer.id)}
      <section
        data-testid="filter-layer-card"
        class="layer-card"
        style:--layer-color={layer.color}
        role="listitem"
        draggable={!disabled}
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
                contentClassName={colorPickerContentClassName}
                disabled={disabled}
                onchange={(event) => updateLayer(layer.id, { color: event.detail.value })}
              />
            </div>
            <div class="layer-actions">
              <UiSelect
                value={layer.mode}
                items={filterModeItems}
                size="xs"
                className="min-w-[5.25rem]"
                contentClassName={selectContentClassName}
                disabled={disabled}
                onchange={(event) => updateLayer(layer.id, { mode: event.detail.value })}
              />
              <UiButton
                type="button"
                variant="secondary"
                size="square-sm"
                className="inline-flex h-8 w-8 min-h-8 min-w-8 items-center justify-center rounded-[0.65rem] p-0 text-[0]"
                aria-label={$t('common.close')}
                disabled={disabled}
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
                        contentClassName={selectContentClassName}
                        disabled={disabled || filterTagItems.length === 0}
                        onchange={(event) => updateRule(layer.id, rule.id, { key: String(event.detail.value || '').trim() })}
                      />
                    </div>
                    <UiSelect
                      data-testid="filter-op-select"
                      items={filterOpItems}
                      value={rule.op}
                      size="xs"
                      className="min-w-[9rem]"
                      contentClassName={selectContentClassName}
                      disabled={disabled}
                      onchange={(event) => updateRule(layer.id, rule.id, { op: event.detail.value })}
                    />
                    <UiInput
                      data-testid="filter-value-input"
                      size="xs"
                      placeholder={$t('header.tagValue')}
                      value={rule.value}
                      inputmode={isNumericFilterOp(rule.op) ? 'decimal' : 'text'}
                      disabled={disabled || isValuelessFilterOp(rule.op)}
                      oninput={(event) => updateRule(layer.id, rule.id, { value: event.currentTarget.value })}
                    />
                  </div>
                  <UiButton
                    type="button"
                    variant="secondary"
                    size="square-sm"
                    className="inline-flex h-8 w-8 min-h-8 min-w-8 items-center justify-center rounded-[0.65rem] p-0 text-[0]"
                    aria-label={$t('common.close')}
                    disabled={disabled}
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
            disabled={disabled}
            onclick={() => addRule(layer.id)}
          >
            {$t('header.addRule')}
          </UiButton>
        </div>
      </section>
    {/each}
  {/if}
</div>

{#if filterTagKeysLoadError}
  <p class="text-xs text-red-600">{filterTagKeysLoadError}</p>
{:else if filterTagKeysLoading && filterTagItems.length === 0 && loadingTagKeysLabel}
  <p class="text-xs ui-text-subtle">{loadingTagKeysLabel}</p>
{:else if !filterTagKeysLoading && filterTagItems.length === 0 && emptyTagKeysLabel}
  <p class="text-xs ui-text-subtle">{emptyTagKeysLabel}</p>
{/if}

<UiButton
  type="button"
  data-testid={addLayerButtonTestId || undefined}
  variant="secondary"
  size="xs"
  disabled={disabled}
  onclick={addLayer}
>
  {addLayerButtonLabel || $t('header.addLayer')}
</UiButton>

<style>
  .rows {
    display: grid;
    gap: 0.65rem;
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
    .rule-row {
      grid-template-columns: 1fr;
    }

    .rule-fields {
      grid-template-columns: 1fr;
    }

    .rule-item {
      padding: 0.6rem;
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
