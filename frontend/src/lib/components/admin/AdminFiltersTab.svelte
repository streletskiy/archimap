<script>
  import { onMount } from 'svelte';

  import { UiButton, UiCheckbox, UiScrollArea } from '$lib/components/base';
  import { t } from '$lib/i18n/index';
  import { formatUiDate } from '$lib/utils/edit-ui';

  export let controller;
  export let isMasterAdmin = false;

  const dataSettings = controller.dataSettings;
  const dataLoading = controller.dataLoading;
  const dataStatus = controller.dataStatus;
  const filterTagAllowlistDraft = controller.filterTagAllowlistDraft;
  const filterTagAllowlistSaving = controller.filterTagAllowlistSaving;
  const sortedAvailableFilterTagKeys = controller.sortedAvailableFilterTagKeys;
  const filterTagAllowlistDirty = controller.filterTagAllowlistDirty;
  const filterTagDraftStateByKey = controller.filterTagDraftStateByKey;

  onMount(() => {
    if (!isMasterAdmin) return;
    void controller.ensureLoaded({ preserveSelection: true });
  });
</script>

{#if !isMasterAdmin}
  <p class="mt-3 text-sm ui-text-muted">{$t('admin.settings.masterOnly')}</p>
{:else}
  <section class="mt-3 space-y-4 rounded-2xl border ui-border ui-surface-base p-4 min-w-0">
    <div class="flex flex-wrap items-start justify-between gap-3">
      <div class="space-y-1">
        <h3 class="text-base font-bold ui-text-strong">{$t('admin.data.filterTags.title')}</h3>
        <p class="text-sm ui-text-muted">{$t('admin.data.filterTags.description')}</p>
      </div>
      <div class="flex flex-wrap gap-2">
        <UiButton
          type="button"
          variant="secondary"
          size="xs"
          onclick={() => controller.loadDataSettings({ preserveSelection: true })}
          disabled={$dataLoading || $filterTagAllowlistSaving}>{$t('common.refresh')}</UiButton
        >
      </div>
    </div>

    <div class="flex flex-wrap gap-2 text-xs ui-text-subtle">
      <span class="rounded-full ui-surface-soft px-2 py-1">{$t('admin.data.filterTags.source')}: {$dataSettings.filterTags.source}</span>
      <span class="rounded-full ui-surface-soft px-2 py-1">
        {$t('admin.data.filterTags.selectedCount', { count: $filterTagAllowlistDraft.length })}
      </span>
      <span class="rounded-full ui-surface-soft px-2 py-1">
        {$t('admin.data.filterTags.availableCount', { count: $dataSettings.filterTags.availableKeys.length })}
      </span>
      {#if $dataSettings.filterTags.updatedAt}
        <span class="rounded-full ui-surface-soft px-2 py-1">
          {$t('admin.data.filterTags.updatedAt')}: {formatUiDate($dataSettings.filterTags.updatedAt)}
        </span>
      {/if}
      {#if $dataSettings.filterTags.updatedBy}
        <span class="rounded-full ui-surface-soft px-2 py-1">
          {$t('admin.data.filterTags.updatedBy')}: {$dataSettings.filterTags.updatedBy}
        </span>
      {/if}
    </div>

    {#if $dataStatus}
      <p class="text-sm ui-text-muted">{$dataStatus}</p>
    {/if}

    {#if $filterTagAllowlistDirty}
      <div class="filter-tag-unsaved-warning rounded-xl px-3 py-2 text-sm">
        {$t('admin.data.filterTags.unsavedWarning')}
      </div>
    {/if}

    {#if $dataSettings.filterTags.availableKeys.length === 0}
      <p class="rounded-xl border border-dashed ui-border-strong px-3 py-4 text-sm ui-text-subtle">
        {$t('admin.data.filterTags.empty')}
      </p>
    {:else}
      <UiScrollArea
        className="max-h-[28rem] rounded-xl border ui-border ui-surface-base p-3"
        contentClassName="grid gap-2 sm:grid-cols-2 xl:grid-cols-3"
      >
          {#each $sortedAvailableFilterTagKeys as key (key)}
            {@const draftState = $filterTagDraftStateByKey[key] || 'unchanged'}
            <label
              class="filter-tag-option flex w-full items-center gap-2 rounded-lg border px-3 py-2 text-sm"
              data-draft-state={draftState}
            >
              <UiCheckbox
                checked={$filterTagAllowlistDraft.includes(key)}
                onchange={(event) => controller.toggleFilterTagSelection(key, event.detail.checked)}
              />
              <span class="break-all">{key}</span>
            </label>
          {/each}
      </UiScrollArea>
    {/if}

    <div class="flex flex-wrap gap-2">
      <UiButton
        type="button"
        variant="secondary"
        disabled={$dataLoading || $filterTagAllowlistSaving}
        onclick={controller.resetFilterTagAllowlistToDefault}>{$t('admin.data.filterTags.resetDefaults')}</UiButton
      >
      <UiButton
        type="button"
        disabled={$dataLoading || $filterTagAllowlistSaving}
        onclick={controller.saveFilterTagAllowlist}>{$t('admin.data.filterTags.save')}</UiButton
      >
    </div>
  </section>
{/if}

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

  .filter-tag-option {
    border-color: var(--panel-border);
    background: color-mix(in srgb, var(--panel-solid) 92%, transparent);
    color: var(--fg);
    transition:
      background-color 140ms ease,
      border-color 140ms ease,
      box-shadow 140ms ease;
  }

  .filter-tag-option[data-draft-state='unchanged'] {
    border-color: var(--panel-border);
    background: color-mix(in srgb, var(--panel-solid) 92%, transparent);
    color: var(--fg);
    box-shadow: none;
  }

  .filter-tag-option[data-draft-state='enabled_pending'] {
    border-color: #34d399;
    background: #dcfce7;
    box-shadow: inset 0 0 0 1px rgba(16, 185, 129, 0.22);
    color: #065f46;
  }

  .filter-tag-option[data-draft-state='disabled_pending'] {
    border-color: #fb7185;
    background: #ffe4e6;
    box-shadow: inset 0 0 0 1px rgba(225, 29, 72, 0.16);
    color: #9f1239;
  }

  :global(html[data-theme='dark']) .filter-tag-option[data-draft-state='enabled_pending'] {
    border-color: #34d399;
    background: #0b3b2e;
    box-shadow: inset 0 0 0 1px rgba(52, 211, 153, 0.24);
    color: #a7f3d0;
  }

  :global(html[data-theme='dark']) .filter-tag-option[data-draft-state='disabled_pending'] {
    border-color: #fb7185;
    background: #4a1524;
    box-shadow: inset 0 0 0 1px rgba(251, 113, 133, 0.22);
    color: #fecdd3;
  }

  :global(html[data-theme='dark']) .filter-tag-option[data-draft-state='unchanged'] {
    border-color: var(--panel-border);
    background: color-mix(in srgb, var(--panel-solid) 92%, transparent);
    color: var(--fg);
  }
</style>
