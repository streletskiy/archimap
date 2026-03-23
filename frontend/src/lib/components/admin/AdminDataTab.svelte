<script>
  import { onDestroy } from 'svelte';

  import {
    UiButton,
    UiCheckbox,
    UiInput,
    UiPressableCard,
    UiRadioGroup,
    UiRadioGroupItem,
    UiScrollArea,
    UiTable,
    UiTableBody,
    UiTableCell,
    UiTableHead,
    UiTableHeader,
    UiTableRow
  } from '$lib/components/base';
  import AdminDataRegionMap from './AdminDataRegionMap.svelte';
  import { t } from '$lib/i18n/index';
  import { formatUiDate } from '$lib/utils/edit-ui';

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
  const REGION_LIST_BATCH_SIZE = 24;

  let regions = [];
  let selectedRegion;
  let draftHasValues;
  let initialLoadRequested;
  let visibleRegionCount = REGION_LIST_BATCH_SIZE;
  let visibleRegions;
  let regionListScroller;
  let regionListSentinel;
  let regionListObserver = null;
  let lastRegionListKey;
  let selectedExtractCandidateValue;

  function updateRegionDraftField(field, value) {
    controller.patchRegionDraft({ [field]: value });
  }

  function getExtractCandidateValue(candidate) {
    return `${String(candidate?.extractSource || '').trim()}::${String(candidate?.extractId || '').trim()}`;
  }

  function handleExtractCandidateChange(event) {
    const nextValue = String(event.detail?.value || '').trim();
    if (!nextValue) return;
    const candidate = $regionExtractCandidates.find((item) => getExtractCandidateValue(item) === nextValue);
    if (candidate) {
      controller.applyRegionExtractCandidate(candidate);
    }
  }

  function formatBounds(bounds) {
    if (!bounds) return $t('admin.data.form.boundsUnknown');
    return `${bounds.west.toFixed(4)}, ${bounds.south.toFixed(4)} .. ${bounds.east.toFixed(4)}, ${bounds.north.toFixed(4)}`;
  }

  function buildRegionListKey(items) {
    return (Array.isArray(items) ? items : []).map((region) => Number(region?.id || 0)).join(':');
  }

  function resetVisibleRegionCount(total) {
    const numericTotal = Math.max(0, Number(total || 0));
    visibleRegionCount = numericTotal > 0 ? Math.min(REGION_LIST_BATCH_SIZE, numericTotal) : REGION_LIST_BATCH_SIZE;
  }

  function clampVisibleRegionCount(total) {
    const numericTotal = Math.max(0, Number(total || 0));
    if (numericTotal === 0) {
      if (visibleRegionCount !== REGION_LIST_BATCH_SIZE) {
        visibleRegionCount = REGION_LIST_BATCH_SIZE;
      }
      return;
    }

    if (visibleRegionCount < REGION_LIST_BATCH_SIZE) {
      visibleRegionCount = Math.min(REGION_LIST_BATCH_SIZE, numericTotal);
      return;
    }

    if (visibleRegionCount > numericTotal) {
      visibleRegionCount = numericTotal;
    }
  }

  function ensureSelectedRegionVisible(selectedRegionId, items) {
    const numericSelectedRegionId = Number(selectedRegionId || 0);
    if (!Number.isInteger(numericSelectedRegionId) || numericSelectedRegionId <= 0) return;

    const selectedIndex = (Array.isArray(items) ? items : []).findIndex((item) => Number(item?.id || 0) === numericSelectedRegionId);
    if (selectedIndex < 0 || selectedIndex < visibleRegionCount) return;

    visibleRegionCount = Math.min(
      items.length,
      Math.ceil((selectedIndex + 1) / REGION_LIST_BATCH_SIZE) * REGION_LIST_BATCH_SIZE
    );
  }

  function loadMoreRegions() {
    if (visibleRegionCount >= regions.length) return;
    visibleRegionCount = Math.min(regions.length, visibleRegionCount + REGION_LIST_BATCH_SIZE);
  }

  function destroyRegionListObserver() {
    if (!regionListObserver) return;
    regionListObserver.disconnect();
    regionListObserver = null;
  }

  function setupRegionListObserver() {
    destroyRegionListObserver();

    if (!regionListScroller || !regionListSentinel || typeof IntersectionObserver === 'undefined') return;

    regionListObserver = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          loadMoreRegions();
        }
      },
      {
        root: regionListScroller,
        rootMargin: '0px 0px 180px 0px',
        threshold: 0.1
      }
    );

    regionListObserver.observe(regionListSentinel);
  }

  $: regions = Array.isArray($dataSettings?.regions) ? $dataSettings.regions : [];

  $: selectedRegion = $regionDraft.id
    ? regions.find((item) => Number(item?.id || 0) === Number($regionDraft.id)) || null
    : null;

  $: draftHasValues = Boolean(
    $regionDraft.id
      || String($regionDraft.name || '').trim()
      || String($regionDraft.slug || '').trim()
      || String($regionDraft.extractId || '').trim()
      || String($regionDraft.searchQuery || '').trim()
  );

  $: if (isMasterAdmin && !initialLoadRequested && !$initialized) {
    initialLoadRequested = true;
    void controller.ensureLoaded({ preserveSelection: true });
  }
  $: void initialLoadRequested;

  $: {
    const nextRegionListKey = buildRegionListKey(regions);
    if (nextRegionListKey !== lastRegionListKey) {
      lastRegionListKey = nextRegionListKey;
      resetVisibleRegionCount(regions.length);
    }
    void lastRegionListKey;
  }

  $: clampVisibleRegionCount(regions.length);
  $: ensureSelectedRegionVisible($selectedDataRegionId, regions);
  $: visibleRegions = regions.slice(0, visibleRegionCount);
  $: selectedExtractCandidateValue = $regionDraft.extractSource && $regionDraft.extractId
    ? getExtractCandidateValue({
      extractSource: $regionDraft.extractSource,
      extractId: $regionDraft.extractId
    })
    : '';

  $: if (!regionListScroller || !regionListSentinel) {
    destroyRegionListObserver();
  }

  $: if (regionListScroller && regionListSentinel && visibleRegions.length > 0 && visibleRegionCount < regions.length) {
    setupRegionListObserver();
  }

  $: if (visibleRegionCount >= regions.length || regions.length === 0) {
    destroyRegionListObserver();
  }

  onDestroy(() => {
    destroyRegionListObserver();
  });
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
          disabled={$dataLoading || $regionSaving || $regionDeleting || $regionSyncBusy}>{$t('common.refresh')}</UiButton
        >
        <UiButton
          type="button"
          variant="secondary"
          size="xs"
          onclick={controller.startNewRegionDraft}
          disabled={$regionSaving || $regionDeleting || $regionSyncBusy}>{$t('admin.data.newRegion')}</UiButton
        >
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

    <form class="data-form-card space-y-3 rounded-2xl p-3 min-w-0" on:submit={controller.saveDataRegion}>
      <div class="flex flex-wrap items-center justify-between gap-2">
        <div class="min-w-0 space-y-0.5">
          <h4 class="text-sm font-semibold ui-text-strong">
            {$regionDraft.id ? $t('admin.data.form.editTitle') : $t('admin.data.form.newTitle')}
          </h4>
          <p class="text-xs ui-text-muted">{$t('admin.data.form.description')}</p>
        </div>
        {#if draftHasValues}
          <UiButton
            type="button"
            variant="secondary"
            size="xs"
            onclick={controller.startNewRegionDraft}
            disabled={$regionSaving || $regionDeleting || $regionSyncBusy}>{$t('admin.data.form.resetSelection')}</UiButton
          >
        {/if}
      </div>

      {#if !$regionDraft.id && !$regionDraft.extractId}
        <div class="rounded-xl border ui-border ui-surface-brand px-3 py-3 text-sm ui-text-body">
          {$t('admin.data.form.mapHint')}
        </div>
      {/if}

      <div class="grid gap-3 xl:grid-cols-[minmax(0,1.25fr)_minmax(0,0.75fr)]">
        <div class="space-y-3 min-w-0">
          <div class="flex flex-wrap items-center gap-3 min-w-0">
            <label class="flex min-w-[16rem] flex-[1.45] items-center gap-2 text-sm ui-text-body">
              <span class="shrink-0 text-[11px] font-semibold uppercase tracking-wide ui-text-muted">{$t('admin.data.form.regionName')}</span>
              <UiInput
                size="xs"
                className="min-w-0 flex-1"
                value={$regionDraft.name}
                on:input={(event) => updateRegionDraftField('name', event.currentTarget.value)}
                placeholder={$t('admin.data.form.regionNamePlaceholder')}
              />
            </label>
            <label class="flex min-w-[14rem] flex-[1.1] items-center gap-2 text-sm ui-text-body">
              <span class="shrink-0 text-[11px] font-semibold uppercase tracking-wide ui-text-muted">{$t('admin.data.form.slug')}</span>
              <UiInput
                size="xs"
                className="min-w-0 flex-1"
                value={$regionDraft.slug}
                on:input={(event) => updateRegionDraftField('slug', event.currentTarget.value)}
                placeholder={$t('admin.data.form.slugPlaceholder')}
              />
            </label>
            <div class="flex min-w-[8rem] items-center gap-2 rounded-xl border ui-border ui-surface-soft px-3 py-2">
              <span class="shrink-0 text-[11px] font-semibold uppercase tracking-wide ui-text-muted">{$t('common.id')}</span>
              <span class="truncate text-sm font-semibold ui-text-strong">{$regionDraft.id ? `#${$regionDraft.id}` : '---'}</span>
            </div>
          </div>

          <div class="rounded-xl border ui-border ui-surface-base px-3 py-2.5">
            <p class="text-xs font-semibold uppercase tracking-wide ui-text-muted">{$t('admin.data.form.selectedExtract')}</p>
            {#if $regionDraft.extractId && $regionDraft.extractSource}
              <p class="mt-2 text-sm font-medium ui-text-strong break-words line-clamp-3">
                {String($regionDraft.extractLabel || $regionDraft.name || $regionDraft.extractId || '').trim()}
              </p>
              <p class="mt-1 text-xs ui-text-subtle break-all line-clamp-2">{$regionDraft.extractSource} · {$regionDraft.extractId}</p>
            {:else}
              <p class="mt-2 text-sm ui-text-subtle">{$t('admin.data.form.selectedExtractEmpty')}</p>
            {/if}
          </div>

          <details class="rounded-xl border ui-border ui-surface-base px-3 py-2.5">
            <summary class="cursor-pointer text-sm font-semibold ui-text-strong">
              {$t('admin.data.form.advancedTitle')}
            </summary>

            <div class="mt-3 space-y-3">
              <div class="space-y-2 text-sm ui-text-body">
                <label class="space-y-1 block">
                  <span>{$t('admin.data.form.searchQuery')}</span>
                  <div class="flex flex-col gap-2 sm:flex-row">
                    <UiInput
                      className="flex-1"
                      value={$regionDraft.searchQuery}
                      on:input={controller.handleRegionSearchQueryInput}
                      placeholder={$t('admin.data.form.searchQueryPlaceholder')}
                    />
                    <UiButton
                      type="button"
                      variant="secondary"
                      onclick={controller.resolveRegionExtractCandidates}
                      disabled={$regionResolveBusy || $regionSaving || $regionDeleting}
                    >
                      {$regionResolveBusy ? $t('admin.data.form.resolvingExtract') : $t('admin.data.form.resolveExtract')}
                    </UiButton>
                  </div>
                </label>

                {#if $regionDraft.extractResolutionStatus !== 'resolved' && $regionDraft.extractResolutionError}
                  <p class="text-xs ui-text-danger break-words">{$regionDraft.extractResolutionError}</p>
                {/if}
              </div>

              {#if $regionExtractCandidates.length > 0}
                <div class="space-y-2 rounded-xl border ui-border px-3 py-2.5">
                  <p class="text-xs font-semibold uppercase tracking-wide ui-text-muted">{$t('admin.data.form.extractCandidates')}</p>
                  <UiRadioGroup
                    value={selectedExtractCandidateValue}
                    onchange={handleExtractCandidateChange}
                    className="space-y-2"
                  >
                    {#each $regionExtractCandidates as candidate (`extract-candidate-${candidate.extractSource}-${candidate.extractId}`)}
                      <label class="block cursor-pointer rounded-lg border ui-border px-3 py-2">
                        <div class="flex items-start gap-3">
                          <UiRadioGroupItem value={getExtractCandidateValue(candidate)} name="region-extract-candidate" />
                          <div class="min-w-0">
                            <p class="font-medium ui-text-strong break-words">{candidate.extractLabel}</p>
                            <p class="text-xs ui-text-subtle break-all">{candidate.extractSource} · {candidate.extractId}</p>
                          </div>
                        </div>
                      </label>
                    {/each}
                  </UiRadioGroup>
                </div>
              {/if}

              <div class="grid gap-3 md:grid-cols-2">
                <label class="space-y-1 text-sm ui-text-body">
                  <span>{$t('admin.data.form.sourceLayer')}</span>
                  <UiInput
                    value={$regionDraft.sourceLayer}
                    on:input={(event) => updateRegionDraftField('sourceLayer', event.currentTarget.value)}
                    placeholder={$t('admin.data.form.sourceLayerPlaceholder')}
                  />
                </label>
                <label class="space-y-1 text-sm ui-text-body">
                  <span>{$t('admin.data.form.autoSyncIntervalHours')}</span>
                  <UiInput
                    type="number"
                    min="0"
                    max="8760"
                    value={$regionDraft.autoSyncIntervalHours}
                    on:input={(event) => updateRegionDraftField('autoSyncIntervalHours', Number(event.currentTarget.value || 0))}
                  />
                </label>
                <label class="space-y-1 text-sm ui-text-body">
                  <span>{$t('admin.data.form.pmtilesMinZoom')}</span>
                  <UiInput
                    type="number"
                    min="0"
                    max="22"
                    value={$regionDraft.pmtilesMinZoom}
                    on:input={(event) => updateRegionDraftField('pmtilesMinZoom', Number(event.currentTarget.value || 0))}
                  />
                </label>
                <label class="space-y-1 text-sm ui-text-body">
                  <span>{$t('admin.data.form.pmtilesMaxZoom')}</span>
                  <UiInput
                    type="number"
                    min="0"
                    max="22"
                    value={$regionDraft.pmtilesMaxZoom}
                    on:input={(event) => updateRegionDraftField('pmtilesMaxZoom', Number(event.currentTarget.value || 0))}
                  />
                </label>
              </div>

              <div class="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
                <label class="flex items-center gap-2 text-sm ui-text-body"
                  ><UiCheckbox
                    checked={$regionDraft.enabled}
                    onchange={(event) => updateRegionDraftField('enabled', event.detail.checked)}
                  />
                  {$t('admin.data.form.enabled')}</label
                >
                <label class="flex items-center gap-2 text-sm ui-text-body"
                  ><UiCheckbox
                    checked={$regionDraft.autoSyncEnabled}
                    onchange={(event) => updateRegionDraftField('autoSyncEnabled', event.detail.checked)}
                  />
                  {$t('admin.data.form.autoSyncEnabled')}</label
                >
                <label class="flex items-center gap-2 text-sm ui-text-body"
                  ><UiCheckbox
                    checked={$regionDraft.autoSyncOnStart}
                    onchange={(event) => updateRegionDraftField('autoSyncOnStart', event.detail.checked)}
                  />
                  {$t('admin.data.form.autoSyncOnStart')}</label
                >
              </div>
            </div>
          </details>
        </div>

        <div class="space-y-4 min-w-0">
          {#if $regionDraft.id}
            {@const selectedStatusMeta = controller.getRegionStatusMeta(selectedRegion?.lastSyncStatus, selectedRegion)}
            <div class="rounded-xl border ui-border ui-surface-base px-3 py-3 text-sm ui-text-body">
              <div class="flex flex-wrap items-center gap-2">
                <span class="font-semibold ui-text-strong">{$t('admin.data.form.currentStatus')}</span>
                <span
                  class="badge-pill data-status-pill rounded-full px-2.5 py-1 text-xs font-semibold"
                  data-tone={selectedStatusMeta.tone}>{selectedStatusMeta.text}</span
                >
              </div>
              <div class="mt-2 grid gap-1 text-xs ui-text-subtle">
                <p>{$t('admin.data.form.lastSync')}: {formatUiDate(selectedRegion?.lastSuccessfulSyncAt) || '---'}</p>
                <p>{$t('admin.data.form.nextSync')}: {formatUiDate(selectedRegion?.nextSyncAt) || '---'}</p>
                <p>{$t('admin.data.form.lastFinished')}: {formatUiDate(selectedRegion?.lastSyncFinishedAt) || '---'}</p>
                <p>{$t('admin.data.form.pmtilesSize')}: {controller.formatStorageBytes(selectedRegion?.pmtilesBytes)}</p>
                <p>
                  {$t('admin.data.form.dbSize')}:
                  {selectedRegion?.dbBytesApproximate ? '~' : ''}{controller.formatStorageBytes(selectedRegion?.dbBytes)}
                </p>
                <p class="break-words">{$t('admin.data.form.bounds')}: {formatBounds(selectedRegion?.bounds)}</p>
              </div>
              {#if selectedRegion?.lastSyncError}
                <p class="mt-2 text-xs ui-text-danger break-words">{selectedRegion.lastSyncError}</p>
              {/if}
            </div>
        {/if}

        <div class="flex flex-wrap gap-2">
          <UiButton
            type="submit"
            disabled={$regionSaving
              || $regionDeleting
              || !String($regionDraft.extractId || '').trim()
              || !String($regionDraft.extractSource || '').trim()
              || !String($regionDraft.name || '').trim()
              || !String($regionDraft.slug || '').trim()}
              >{$regionDraft.id ? $t('admin.data.form.saveRegion') : $t('admin.data.form.createRegion')}</UiButton
            >
            {#if $regionDraft.id}
              <UiButton
                type="button"
                variant="secondary"
                disabled={$regionSaving || $regionDeleting || $regionSyncBusy}
                onclick={() => controller.syncRegionNow($regionDraft.id)}>{$t('admin.data.form.syncNow')}</UiButton
              >
              <UiButton
                type="button"
                variant="danger"
                disabled={$regionSaving || $regionDeleting || $regionSyncBusy}
                onclick={() => controller.deleteDataRegion($regionDraft.id)}
                >{$regionDeleting ? $t('admin.data.form.deleting') : $t('admin.data.form.deleteRegion')}</UiButton
              >
            {/if}
          </div>
        </div>
      </div>
    </form>

    <section class="space-y-3 min-w-0">
      <div class="flex items-center justify-between gap-2">
        <h4 class="text-sm font-semibold uppercase tracking-wide ui-text-muted">{$t('admin.data.list.title')}</h4>
        <span class="text-xs ui-text-subtle">{Math.min(visibleRegions.length, regions.length)} / {regions.length}</span>
      </div>

      {#if $dataLoading}
        <p class="data-summary-card rounded-xl px-3 py-2 text-sm ui-text-subtle">{$t('admin.data.list.loading')}</p>
      {:else if regions.length === 0}
        <p class="rounded-xl border border-dashed ui-border-strong px-3 py-4 text-sm ui-text-subtle">
          {$t('admin.data.list.empty')}
        </p>
      {:else}
        <UiScrollArea
          className="ui-scroll-surface max-h-[34rem] rounded-xl"
          contentClassName="space-y-2 p-2"
          bind:viewportRef={regionListScroller}
        >
          {#each visibleRegions as region (`data-region-${region.id}`)}
            {@const statusMeta = controller.getRegionStatusMeta(region.lastSyncStatus, region)}
            {@const extractSummary = controller.getRegionExtractSummaryText(region)}
            <UiPressableCard
              selected={$selectedDataRegionId === region.id}
              className="data-region-card"
              onclick={() => controller.selectDataRegion(region)}
            >
              <div class="flex flex-wrap items-start justify-between gap-2">
                <div class="min-w-0 flex-1">
                  <div class="flex flex-wrap items-center gap-x-2 gap-y-1 min-w-0">
                    <p class="font-semibold ui-text-strong break-words truncate">{region.name}</p>
                    <span class="text-xs ui-text-subtle break-words">#{region.id} · {region.slug}</span>
                  </div>
                  <p class="mt-0.5 text-xs ui-text-subtle break-words sm:truncate" title={extractSummary}>{extractSummary}</p>
                </div>
                <span
                  class="badge-pill data-status-pill shrink-0 rounded-full px-2.5 py-1 text-xs font-semibold"
                  data-tone={statusMeta.tone}>{statusMeta.text}</span
                >
              </div>

              <div class="data-region-meta mt-1.5 flex flex-wrap gap-2 text-xs ui-text-subtle">
                <span class="rounded-full ui-surface-soft px-2 py-1">{$t('admin.data.list.lastSync')}: {formatUiDate(region.lastSuccessfulSyncAt) || '---'}</span>
                <span class="rounded-full ui-surface-soft px-2 py-1">{$t('admin.data.list.nextSync')}: {formatUiDate(region.nextSyncAt) || '---'}</span>
                <span class="rounded-full ui-surface-soft px-2 py-1">{$t('admin.data.list.pmtilesSize')}: {controller.formatStorageBytes(region.pmtilesBytes)}</span>
                <span class="rounded-full ui-surface-soft px-2 py-1">
                  {$t('admin.data.list.dbSize')}: {region.dbBytesApproximate ? '~' : ''}{controller.formatStorageBytes(region.dbBytes)}
                </span>
                <span class="rounded-full ui-surface-soft px-2 py-1">{controller.getRegionEnabledLabel(region.enabled)}</span>
              </div>

              {#if region.lastSyncError}
                <p class="mt-2 text-xs ui-text-danger break-words">{region.lastSyncError}</p>
              {/if}
            </UiPressableCard>
          {/each}

          {#if visibleRegionCount < regions.length}
            <div class="data-region-list-sentinel" bind:this={regionListSentinel} aria-hidden="true"></div>
          {/if}
        </UiScrollArea>
      {/if}
    </section>

    <section class="data-history-card rounded-2xl p-4 min-w-0">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <h4 class="text-base font-bold ui-text-strong">{$t('admin.data.history.title')}</h4>
        {#if $regionRunsLoading}
          <span class="text-sm ui-text-subtle">{$t('admin.data.history.loading')}</span>
        {/if}
      </div>

      {#if $regionRunsStatus}
        <p class="mt-2 text-sm ui-text-muted">{$regionRunsStatus}</p>
      {/if}

      {#if $selectedDataRegionId && $regionRuns.length > 0}
        <div class="mt-3">
          <UiTable framed={false}>
            <UiTableHeader>
              <UiTableRow className="hover:[&>th]:bg-transparent">
                <UiTableHead>{$t('admin.data.history.run')}</UiTableHead>
                <UiTableHead>{$t('admin.data.history.trigger')}</UiTableHead>
                <UiTableHead>{$t('admin.data.history.status')}</UiTableHead>
                <UiTableHead>{$t('admin.data.history.requested')}</UiTableHead>
                <UiTableHead>{$t('admin.data.history.finished')}</UiTableHead>
                <UiTableHead>{$t('admin.data.history.features')}</UiTableHead>
              </UiTableRow>
            </UiTableHeader>
            <UiTableBody>
              {#each $regionRuns as run (`region-run-${run.id}`)}
                {@const runStatusMeta = controller.getRegionStatusMeta(run.status, run)}
                <UiTableRow>
                  <UiTableCell className="font-medium ui-text-strong">#{run.id}</UiTableCell>
                  <UiTableCell className="ui-text-muted">{controller.formatRunTriggerReason(run.triggerReason)}</UiTableCell>
                  <UiTableCell
                    ><span
                      class="badge-pill data-status-pill rounded-full px-2.5 py-1 text-xs font-semibold"
                      data-tone={runStatusMeta.tone}>{runStatusMeta.text}</span
                    ></UiTableCell
                  >
                  <UiTableCell className="ui-text-muted">{formatUiDate(run.requestedAt || run.startedAt) || '---'}</UiTableCell>
                  <UiTableCell className="ui-text-muted">{formatUiDate(run.finishedAt) || '---'}</UiTableCell>
                  <UiTableCell className="ui-text-muted">{run.activeFeatureCount ?? run.importedFeatureCount ?? '---'}</UiTableCell>
                </UiTableRow>
                {#if run.error}
                  <UiTableRow className="ui-surface-danger-soft">
                    <UiTableCell colspan="6" className="text-xs ui-text-danger">{run.error}</UiTableCell>
                  </UiTableRow>
                {/if}
              {/each}
            </UiTableBody>
          </UiTable>
        </div>
      {:else if !$selectedDataRegionId}
        <p class="mt-3 text-sm ui-text-subtle">{$t('admin.data.history.selectRegionHint')}</p>
      {/if}
    </section>
  </section>
{/if}

<style>
  .data-summary-card,
  .data-form-card,
  .data-history-card {
    border: 1px solid var(--panel-border);
    background: var(--panel-solid);
    box-shadow: var(--shadow-soft);
  }

  .data-region-list-sentinel {
    min-height: 1px;
  }

  .data-status-pill {
    border: 1px solid transparent;
  }

  .data-status-pill[data-tone='idle'] {
    background: #e2e8f0;
    color: #334155;
  }

  .data-status-pill[data-tone='queued'] {
    background: #dbeafe;
    color: #1d4ed8;
  }

  .data-status-pill[data-tone='running'] {
    background: #fef3c7;
    color: #92400e;
  }

  .data-status-pill[data-tone='success'] {
    background: #d1fae5;
    color: #047857;
  }

  .data-status-pill[data-tone='failed'] {
    background: #ffe4e6;
    color: #be123c;
  }

  :global(html[data-theme='dark']) .data-status-pill[data-tone='idle'] {
    background: #18233a;
    color: #dbe5f2;
  }

  :global(html[data-theme='dark']) .data-status-pill[data-tone='queued'] {
    background: #10213b;
    color: #93c5fd;
  }

  :global(html[data-theme='dark']) .data-status-pill[data-tone='running'] {
    background: #3f2a05;
    color: #fcd34d;
  }

  :global(html[data-theme='dark']) .data-status-pill[data-tone='success'] {
    background: #064e3b;
    color: #6ee7b7;
  }

  :global(html[data-theme='dark']) .data-status-pill[data-tone='failed'] {
    background: #4c1024;
    color: #fda4af;
  }
</style>
