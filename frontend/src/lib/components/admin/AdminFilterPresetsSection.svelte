<script>
  import { UiButton, UiInput, UiScrollArea } from '$lib/components/base';
  import FilterLayersEditor from '$lib/components/filters/FilterLayersEditor.svelte';
  import { availableLocales, locale, t } from '$lib/i18n/index';
  import { formatUiDate } from '$lib/utils/edit-ui';

  export let controller;

  const dataSettings = controller.dataSettings;
  const dataLoading = controller.dataLoading;
  const filterPresetItems = controller.filterPresetItems;
  const selectedFilterPresetId = controller.selectedFilterPresetId;
  const filterPresetDraft = controller.filterPresetDraft;
  const filterPresetDraftJsonPreview = controller.filterPresetDraftJsonPreview;
  const filterPresetDirty = controller.filterPresetDirty;
  const filterPresetLoading = controller.filterPresetLoading;
  const filterPresetSaving = controller.filterPresetSaving;
  const filterPresetDeleting = controller.filterPresetDeleting;
  const presetNameLocales = Array.isArray(availableLocales) && availableLocales.length > 0
    ? availableLocales
    : ['en'];

  function getPresetLabel(preset) {
    const currentLocale = String($locale || 'en').trim().toLowerCase();
    const localized = String(preset?.nameI18n?.[currentLocale] || '').trim();
    return localized || String(preset?.name || preset?.key || '').trim() || `#${Number(preset?.id || 0)}`;
  }

  function getPresetNameByLocale(preset, localeCode) {
    const normalizedLocale = String(localeCode || '').trim().toLowerCase();
    if (!normalizedLocale) return '';
    return String(preset?.nameI18n?.[normalizedLocale] || '').trim();
  }

  function handlePresetNameI18nInput(localeCode, value) {
    const normalizedLocale = String(localeCode || '').trim().toLowerCase();
    if (!normalizedLocale) return;
    const nextValue = String(value || '').trim();
    const currentNameI18n = $filterPresetDraft?.nameI18n && typeof $filterPresetDraft.nameI18n === 'object'
      ? $filterPresetDraft.nameI18n
      : {};
    const nextNameI18n = {
      ...currentNameI18n
    };
    if (nextValue) {
      nextNameI18n[normalizedLocale] = nextValue;
    } else {
      delete nextNameI18n[normalizedLocale];
    }

    const fallbackName = String(nextNameI18n.en || Object.values(nextNameI18n)[0] || '').trim();
    controller.patchFilterPresetDraft({
      nameI18n: nextNameI18n,
      name: fallbackName
    });
  }

  function handlePresetLayersChange(event) {
    const layers = Array.isArray(event?.detail?.layers) ? event.detail.layers : [];
    controller.setFilterPresetDraftLayers(layers);
  }
</script>

<section class="flex flex-col gap-4 rounded-2xl border ui-border ui-surface-base p-4 min-w-0 min-h-0 overflow-hidden">
  <div class="flex flex-wrap items-start justify-between gap-3">
    <div class="space-y-1">
      <h3 class="text-base font-bold ui-text-strong">{$t('admin.data.filterPresets.title')}</h3>
      <p class="text-sm ui-text-muted">{$t('admin.data.filterPresets.description')}</p>
    </div>
    <div class="flex flex-wrap gap-2">
      <UiButton
        type="button"
        variant="secondary"
        size="xs"
        disabled={$filterPresetLoading || $filterPresetSaving || $filterPresetDeleting}
        onclick={() => controller.loadFilterPresets({ preserveSelection: true })}
      >{$t('common.refresh')}</UiButton>
      <UiButton
        type="button"
        variant="secondary"
        size="xs"
        disabled={$filterPresetSaving || $filterPresetDeleting}
        onclick={controller.startNewFilterPresetDraft}
      >{$t('admin.data.filterPresets.create')}</UiButton>
    </div>
  </div>

  <div class="flex flex-wrap gap-2 text-xs ui-text-subtle">
    <span class="rounded-full ui-surface-soft px-2 py-1">{$t('admin.data.filterPresets.source')}: {$dataSettings.filterPresets.source}</span>
    <span class="rounded-full ui-surface-soft px-2 py-1">
      {$t('admin.data.filterPresets.count', { count: $filterPresetItems.length })}
    </span>
    {#if $filterPresetDraft.updatedAt}
      <span class="rounded-full ui-surface-soft px-2 py-1">
        {$t('admin.data.filterPresets.updatedAt')}: {formatUiDate($filterPresetDraft.updatedAt)}
      </span>
    {/if}
    {#if $filterPresetDraft.updatedBy}
      <span class="rounded-full ui-surface-soft px-2 py-1">
        {$t('admin.data.filterPresets.updatedBy')}: {$filterPresetDraft.updatedBy}
      </span>
    {/if}
  </div>

  {#if $filterPresetDirty}
    <div class="filter-tag-unsaved-warning rounded-xl px-3 py-2 text-sm">
      {$t('admin.data.filterPresets.unsavedWarning')}
    </div>
  {/if}

  <div class="preset-layout">
    <aside class="preset-list-panel rounded-xl border ui-border ui-surface-base p-3">
      <h4 class="text-sm font-semibold ui-text-strong mb-2">{$t('admin.data.filterPresets.listTitle')}</h4>
      {#if $filterPresetLoading && $filterPresetItems.length === 0}
        <p class="text-sm ui-text-muted">{$t('admin.data.filterPresets.loading')}</p>
      {:else if $filterPresetItems.length === 0}
        <p class="text-sm ui-text-muted">{$t('admin.data.filterPresets.empty')}</p>
      {:else}
        <UiScrollArea
          className="max-h-[28rem]"
          contentClassName="grid gap-2"
        >
          {#each $filterPresetItems as preset (preset.id)}
            <button
              type="button"
              class="preset-list-item"
              data-selected={Number($selectedFilterPresetId || 0) === Number(preset.id || 0)}
              onclick={() => controller.selectFilterPresetById(preset.id)}
            >
              <strong>{getPresetLabel(preset)}</strong>
              <span>{preset.key}</span>
            </button>
          {/each}
        </UiScrollArea>
      {/if}
    </aside>

    <div class="preset-editor-panel rounded-xl border ui-border ui-surface-base p-3">
      <div class="grid gap-2 sm:grid-cols-2">
        <div class="grid gap-2 sm:col-span-2">
          <span class="ui-text-subtle text-sm">{$t('admin.data.filterPresets.fields.nameI18nTitle')}</span>
          <div class="grid gap-2 sm:grid-cols-2">
            {#each presetNameLocales as localeCode (localeCode)}
              <label class="grid gap-1 text-sm">
                <span class="ui-text-subtle">
                  {$t('admin.data.filterPresets.fields.nameLocale', { locale: $t(`locale.${localeCode}`) })}
                </span>
                <UiInput
                  value={getPresetNameByLocale($filterPresetDraft, localeCode)}
                  size="xs"
                  disabled={$filterPresetSaving || $filterPresetDeleting}
                  placeholder={$t('admin.data.filterPresets.fields.nameLocalePlaceholder', { locale: localeCode })}
                  oninput={(event) => handlePresetNameI18nInput(localeCode, event.currentTarget.value)}
                />
              </label>
            {/each}
          </div>
        </div>
        <label class="grid gap-1 text-sm sm:col-span-2">
          <span class="ui-text-subtle">{$t('admin.data.filterPresets.fields.key')}</span>
          <UiInput
            value={$filterPresetDraft.key}
            size="xs"
            disabled={$filterPresetSaving || $filterPresetDeleting}
            placeholder={$t('admin.data.filterPresets.fields.keyPlaceholder')}
            oninput={(event) => controller.patchFilterPresetDraft({ key: event.currentTarget.value })}
          />
        </label>
      </div>

      <label class="grid gap-1 text-sm mt-2">
        <span class="ui-text-subtle">{$t('admin.data.filterPresets.fields.description')}</span>
        <UiInput
          value={$filterPresetDraft.description}
          size="xs"
          disabled={$filterPresetSaving || $filterPresetDeleting}
          placeholder={$t('admin.data.filterPresets.fields.descriptionPlaceholder')}
          oninput={(event) => controller.patchFilterPresetDraft({ description: event.currentTarget.value })}
        />
      </label>

      <div class="mt-3 grid gap-2">
        <h4 class="text-sm font-semibold ui-text-strong">{$t('admin.data.filterPresets.visualEditorTitle')}</h4>
        <FilterLayersEditor
          layers={$filterPresetDraft.layers}
          filterTagKeys={$dataSettings.filterTags.availableKeys}
          filterTagKeysLoading={$dataLoading}
          selectContentClassName="ui-floating-layer-map-filter max-h-72"
          colorPickerContentClassName="ui-floating-layer-map-filter"
          addLayerButtonLabel={$t('header.addLayer')}
          loadingTagKeysLabel={$t('admin.data.filterPresets.tagKeysLoading')}
          emptyTagKeysLabel={$t('admin.data.filterPresets.tagKeysEmpty')}
          disabled={$filterPresetSaving || $filterPresetDeleting}
          on:change={handlePresetLayersChange}
        />
      </div>

      <div class="mt-3 grid gap-2">
        <h4 class="text-sm font-semibold ui-text-strong">{$t('admin.data.filterPresets.rawTitle')}</h4>
        <UiScrollArea
          className="max-h-[15rem] rounded-xl border ui-border ui-surface-soft p-2"
          contentClassName="block"
        >
          <pre class="preset-json-preview">{$filterPresetDraftJsonPreview}</pre>
        </UiScrollArea>
      </div>

      <div class="mt-3 flex flex-wrap gap-2">
        <UiButton
          type="button"
          disabled={$filterPresetSaving || $filterPresetDeleting}
          onclick={controller.saveFilterPreset}
        >
          {#if $filterPresetSaving}
            {$t('admin.data.filterPresets.saving')}
          {:else}
            {$t('admin.data.filterPresets.save')}
          {/if}
        </UiButton>
        <UiButton
          type="button"
          variant="secondary"
          disabled={!$selectedFilterPresetId || $filterPresetSaving || $filterPresetDeleting}
          onclick={() => controller.deleteFilterPreset($selectedFilterPresetId)}
        >
          {#if $filterPresetDeleting}
            {$t('admin.data.filterPresets.deleting')}
          {:else}
            {$t('admin.data.filterPresets.delete')}
          {/if}
        </UiButton>
      </div>
    </div>
  </div>
</section>

<style>
  .filter-tag-unsaved-warning {
    border: 1px solid #fcd34d;
    background: #fffbeb;
    color: #92400e;
  }

  :global(html[data-theme='dark']) .filter-tag-unsaved-warning {
    border-color: #b45309;
    background: #3f2a05;
    color: #fcd34d;
  }

  .preset-layout {
    display: grid;
    gap: 0.75rem;
    grid-template-columns: minmax(14rem, 16rem) minmax(0, 1fr);
    align-items: start;
  }

  .preset-list-item {
    width: 100%;
    border: 1px solid var(--panel-border);
    border-radius: 0.75rem;
    padding: 0.55rem 0.65rem;
    display: grid;
    gap: 0.2rem;
    text-align: left;
    background: var(--panel-solid);
    color: var(--fg);
    transition:
      border-color 140ms ease,
      background-color 140ms ease;
  }

  .preset-list-item strong {
    font-size: 0.86rem;
    color: var(--fg-strong);
  }

  .preset-list-item span {
    font-size: 0.76rem;
    color: var(--muted);
  }

  .preset-list-item[data-selected='true'] {
    border-color: color-mix(in srgb, var(--accent) 64%, var(--panel-border));
    background: color-mix(in srgb, var(--accent-soft) 64%, var(--panel-solid));
  }

  .preset-json-preview {
    margin: 0;
    font-size: 0.72rem;
    line-height: 1.4;
    white-space: pre;
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace;
    color: var(--fg);
  }

  @media (max-width: 980px) {
    .preset-layout {
      grid-template-columns: 1fr;
    }
  }
</style>
