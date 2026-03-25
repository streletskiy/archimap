<script>
  import AdminDataHistorySection from './AdminDataHistorySection.svelte';
  import AdminDataRegionList from './AdminDataRegionList.svelte';
  import AdminDataRegionMap from './AdminDataRegionMap.svelte';
  import AdminDataForm from './AdminDataForm.svelte';
  import { t } from '$lib/i18n/index';
  import { UiButton } from '$lib/components/base';

  export let controller;
  export let isMasterAdmin = false;

  const dataSettings = controller.dataSettings;
  const dataLoading = controller.dataLoading;
  const dataStatus = controller.dataStatus;
  const storageSummary = controller.storageSummary;
  const regionDraft = controller.regionDraft;
  const regionSaving = controller.regionSaving;
  const regionDeleting = controller.regionDeleting;
  const regionSyncBusy = controller.regionSyncBusy;
  const regionResolveBusy = controller.regionResolveBusy;
  const regionExtractCandidates = controller.regionExtractCandidates;
  const selectedDataRegionId = controller.selectedDataRegionId;
  const regionRuns = controller.regionRuns;
  const regionRunsLoading = controller.regionRunsLoading;
  const regionRunsStatus = controller.regionRunsStatus;
  const initialized = controller.initialized;

  let regions;
  let selectedRegion;
  let initialLoadRequested;

  $: regions = Array.isArray($dataSettings?.regions) ? $dataSettings.regions : [];
  $: selectedRegion = $regionDraft.id
    ? regions.find((item) => Number(item?.id || 0) === Number($regionDraft.id)) || null
    : null;

  $: if (isMasterAdmin && !initialLoadRequested && !$initialized) {
    initialLoadRequested = true;
    void controller.ensureLoaded({ preserveSelection: true });
  }
  $: void initialLoadRequested;
</script>

{#if !isMasterAdmin}
  <p class="mt-3 text-sm ui-text-muted">{$t('admin.settings.masterOnly')}</p>
{:else}
  <section class="mt-3 flex flex-col space-y-4 rounded-2xl border ui-border ui-surface-base p-4 min-w-0 min-h-0 overflow-hidden">
    <div class="flex flex-wrap items-start justify-between gap-3">
      <div class="space-y-1">
        <h3 class="text-base font-bold ui-text-strong">{$t('admin.data.title')}</h3>
        <p class="text-sm ui-text-muted">{$t('admin.data.subtitle')}</p>
      </div>
      <div class="flex flex-wrap gap-2">
        <UiButton
          type="button"
          variant="secondary"
          size="xs"
          onclick={() => controller.loadDataSettings({ preserveSelection: true })}
          disabled={$dataLoading || $regionSaving || $regionDeleting || $regionSyncBusy}
        >
          {$t('common.refresh')}
        </UiButton>
        <UiButton
          type="button"
          variant="secondary"
          size="xs"
          onclick={controller.startNewRegionDraft}
          disabled={$regionSaving || $regionDeleting || $regionSyncBusy}
        >
          {$t('admin.data.newRegion')}
        </UiButton>
      </div>
    </div>

    <div class="grid gap-3">
      <article class="data-summary-card rounded-xl p-3 text-sm ui-text-body">
        <p><strong>{$t('admin.data.summary.regionsCountLabel')}:</strong> {regions.length}</p>
        <p><strong>{$t('admin.data.summary.totalPmtilesSizeLabel')}:</strong> {controller.formatStorageBytes($storageSummary.totalPmtilesBytes)}</p>
        <p>
          <strong>{$t('admin.data.summary.totalDbSizeLabel')}:</strong>
          {$storageSummary.totalDbBytesApproximate ? '~' : ''}{controller.formatStorageBytes($storageSummary.totalDbBytes)}
        </p>
      </article>
    </div>

    <AdminDataRegionMap
      {controller}
      {regions}
      draft={$regionDraft}
      selectedRegionId={$selectedDataRegionId}
      disabled={$regionSaving || $regionDeleting || $regionSyncBusy}
    />

    {#if $dataStatus}
      <p class="text-sm ui-text-muted">{$dataStatus}</p>
    {/if}

    <AdminDataForm
      {controller}
      regionDraft={regionDraft}
      regionExtractCandidates={regionExtractCandidates}
      {selectedRegion}
      regionSaving={$regionSaving}
      regionDeleting={$regionDeleting}
      regionSyncBusy={$regionSyncBusy}
      regionResolveBusy={$regionResolveBusy}
    />

    <AdminDataRegionList
      {controller}
      {regions}
      selectedDataRegionId={$selectedDataRegionId}
      dataLoading={$dataLoading}
    />

    <AdminDataHistorySection
      {controller}
      selectedDataRegionId={$selectedDataRegionId}
      regionRuns={$regionRuns}
      regionRunsLoading={$regionRunsLoading}
      regionRunsStatus={$regionRunsStatus}
    />
  </section>
{/if}

<style>
  .data-summary-card {
    border: 1px solid var(--panel-border);
    background: var(--panel-solid);
    box-shadow: var(--shadow-soft);
  }
</style>
