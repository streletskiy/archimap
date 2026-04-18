<script>
  import AdminDataRegionList from './AdminDataRegionList.svelte';
  import AdminDataRegionMap from './AdminDataRegionMap.svelte';
  import AdminDataRegionModal from './AdminDataRegionModal.svelte';
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
  const regionSyncCancelBusy = controller.regionSyncCancelBusy;
  const regionResolveBusy = controller.regionResolveBusy;
  const regionExtractCandidates = controller.regionExtractCandidates;
  const selectedDataRegionId = controller.selectedDataRegionId;
  const regionRuns = controller.regionRuns;
  const regionRunsLoading = controller.regionRunsLoading;
  const regionRunsStatus = controller.regionRunsStatus;
  const regionRunsPage = controller.regionRunsPage;
  const regionRunsPageCount = controller.regionRunsPageCount;
  const regionRunsTotal = controller.regionRunsTotal;
  const regionEditorOpen = controller.regionEditorOpen;
  const countryCatalog = controller.countryCatalog;
  const countryCatalogLoading = controller.countryCatalogLoading;
  const countryAggregateBusy = controller.countryAggregateBusy;
  const initialized = controller.initialized;

  let countryPickerOpen = false;
  let selectedCountryId = '';

  async function toggleCountryPicker() {
    countryPickerOpen = !countryPickerOpen;
    if (countryPickerOpen) {
      await controller.loadCountryCatalog();
    }
  }

  async function submitCountryAggregate() {
    if (!selectedCountryId) return;
    const saved = await controller.addCountryAggregate(selectedCountryId);
    if (saved) {
      countryPickerOpen = false;
      selectedCountryId = '';
    }
  }

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
        <UiButton
          type="button"
          variant="secondary"
          size="xs"
          onclick={toggleCountryPicker}
          disabled={$regionSaving || $regionDeleting || $regionSyncBusy || $countryAggregateBusy}
        >
          {$t('admin.data.addCountry')}
        </UiButton>
      </div>
    </div>

    {#if countryPickerOpen}
      <div class="flex flex-wrap items-center gap-2 rounded-xl border ui-border ui-surface-soft p-3">
        <select
          class="min-w-[14rem] flex-1 rounded-md border ui-border px-2 py-1 text-sm"
          bind:value={selectedCountryId}
          disabled={$countryCatalogLoading || $countryAggregateBusy}
        >
          <option value="">{$t('admin.data.selectCountry')}</option>
          {#each $countryCatalog as country (country.countryId)}
            <option value={country.countryId}>
              {country.name}{country.subregions?.length ? ` (${country.subregions.length})` : ''}
            </option>
          {/each}
        </select>
        <UiButton
          type="button"
          variant="primary"
          size="xs"
          onclick={submitCountryAggregate}
          disabled={!selectedCountryId || $countryAggregateBusy || $countryCatalogLoading}
        >
          {$countryAggregateBusy ? $t('admin.data.creatingCountry') : $t('admin.data.addCountry')}
        </UiButton>
        <UiButton type="button" variant="secondary" size="xs" onclick={() => (countryPickerOpen = false)}>
          {$t('common.cancel')}
        </UiButton>
      </div>
    {/if}

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

    <AdminDataRegionList
      {controller}
      {regions}
      selectedDataRegionId={$selectedDataRegionId}
      dataLoading={$dataLoading}
    />

    <AdminDataRegionModal
      open={$regionEditorOpen}
      {controller}
      {regionDraft}
      {selectedRegion}
      {regionExtractCandidates}
      regionSaving={$regionSaving}
      regionDeleting={$regionDeleting}
      regionSyncBusy={$regionSyncBusy}
      regionSyncCancelBusy={$regionSyncCancelBusy}
      regionResolveBusy={$regionResolveBusy}
      selectedDataRegionId={$selectedDataRegionId}
      regionRuns={$regionRuns}
      regionRunsLoading={$regionRunsLoading}
      regionRunsStatus={$regionRunsStatus}
      regionRunsPage={$regionRunsPage}
      regionRunsPageCount={$regionRunsPageCount}
      regionRunsTotal={$regionRunsTotal}
      dataStatus={$dataStatus}
      closeDisabled={$regionSaving || $regionDeleting || $regionSyncBusy}
      onClose={controller.closeRegionEditor}
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
