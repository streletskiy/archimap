<script>
  import { onMount } from 'svelte';

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
        <button
          type="button"
          class="ui-btn ui-btn-secondary ui-btn-xs"
          on:click={() => controller.loadDataSettings({ preserveSelection: true })}
          disabled={$dataLoading || $filterTagAllowlistSaving}>{$t('common.refresh')}</button
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
      <div class="max-h-[28rem] overflow-auto rounded-xl border ui-border ui-surface-base p-3">
        <div class="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
          {#each $sortedAvailableFilterTagKeys as key (key)}
            {@const draftState = $filterTagDraftStateByKey[key] || 'unchanged'}
            <label
              class={`filter-tag-option ${controller.getFilterTagDraftClass(draftState)} flex w-full items-center gap-2 rounded-lg border px-3 py-2 text-sm`}
            >
              <input
                type="checkbox"
                checked={$filterTagAllowlistDraft.includes(key)}
                on:change={(event) => controller.toggleFilterTagSelection(key, event.currentTarget.checked)}
              />
              <span class="break-all">{key}</span>
            </label>
          {/each}
        </div>
      </div>
    {/if}

    <div class="flex flex-wrap gap-2">
      <button
        type="button"
        class="ui-btn ui-btn-secondary"
        disabled={$dataLoading || $filterTagAllowlistSaving}
        on:click={controller.resetFilterTagAllowlistToDefault}>{$t('admin.data.filterTags.resetDefaults')}</button
      >
      <button
        type="button"
        class="ui-btn ui-btn-primary"
        disabled={$dataLoading || $filterTagAllowlistSaving}
        on:click={controller.saveFilterTagAllowlist}>{$t('admin.data.filterTags.save')}</button
      >
    </div>
  </section>
{/if}

<style>
  @import './admin-tabs.css';
</style>
