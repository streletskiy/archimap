<script>
  import { onDestroy } from 'svelte';

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
  let selectedRegion = null;
  let draftHasValues = false;
  let initialLoadRequested = false;
  let visibleRegionCount = REGION_LIST_BATCH_SIZE;
  let visibleRegions = [];
  let regionListScroller;
  let regionListSentinel;
  let regionListObserver = null;
  let lastRegionListKey = '';

  function updateRegionDraftField(field, value) {
    controller.patchRegionDraft({ [field]: value });
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

  $: {
    const nextRegionListKey = buildRegionListKey(regions);
    if (nextRegionListKey !== lastRegionListKey) {
      lastRegionListKey = nextRegionListKey;
      resetVisibleRegionCount(regions.length);
    }
  }

  $: clampVisibleRegionCount(regions.length);
  $: ensureSelectedRegionVisible($selectedDataRegionId, regions);
  $: visibleRegions = regions.slice(0, visibleRegionCount);

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
  <section class="mt-3 space-y-4 rounded-2xl border ui-border ui-surface-base p-4 min-w-0">
    <div class="flex flex-wrap items-start justify-between gap-3">
      <div class="space-y-1">
        <h3 class="text-base font-bold ui-text-strong">{$t('admin.data.title')}</h3>
        <p class="text-sm ui-text-muted">{$t('admin.data.subtitle')}</p>
      </div>
      <div class="flex flex-wrap gap-2">
        <button
          type="button"
          class="ui-btn ui-btn-secondary ui-btn-xs"
          on:click={() => controller.loadDataSettings({ preserveSelection: true })}
          disabled={$dataLoading || $regionSaving || $regionDeleting || $regionSyncBusy}>{$t('common.refresh')}</button
        >
        <button
          type="button"
          class="ui-btn ui-btn-secondary ui-btn-xs"
          on:click={controller.startNewRegionDraft}
          disabled={$regionSaving || $regionDeleting || $regionSyncBusy}>{$t('admin.data.newRegion')}</button
        >
      </div>
    </div>

    <div class="grid gap-3 lg:grid-cols-3">
      <article class="data-summary-card rounded-xl p-3 text-sm ui-text-body">
        <p><strong>{$t('admin.data.summary.sourceLabel')}:</strong> {$dataSettings.source}</p>
        <p>
          <strong>{$t('admin.data.summary.bootstrapLabel')}:</strong> {controller.getBootstrapStatusLabel(
            $dataSettings.bootstrap.completed
          )}
        </p>
        <p>
          <strong>{$t('admin.data.summary.bootstrapSourceLabel')}:</strong>
          {$dataSettings.bootstrap.source || '---'}
        </p>
      </article>
      <article class="data-summary-card rounded-xl p-3 text-sm ui-text-body lg:col-span-2">
        <p><strong>{$t('admin.data.summary.syncModeLabel')}:</strong> {$t('admin.data.summary.syncModeValue')}</p>
        <p><strong>{$t('admin.data.summary.regionsCountLabel')}:</strong> {regions.length}</p>
        <p><strong>{$t('admin.data.summary.totalPmtilesSizeLabel')}:</strong> {controller.formatStorageBytes($storageSummary.totalPmtilesBytes)}</p>
        <p>
          <strong>{$t('admin.data.summary.totalDbSizeLabel')}:</strong>
          {$storageSummary.totalDbBytesApproximate ? '~' : ''}{controller.formatStorageBytes($storageSummary.totalDbBytes)}
        </p>
        <p><strong>{$t('admin.data.summary.regionSourceLabel')}:</strong> {$t('admin.data.summary.regionSourceValue')}</p>
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

    <form class="data-form-card space-y-4 rounded-2xl p-4 min-w-0" on:submit={controller.saveDataRegion}>
      <div class="flex flex-wrap items-start justify-between gap-3">
        <div class="space-y-1">
          <h4 class="text-base font-bold ui-text-strong">
            {$regionDraft.id ? $t('admin.data.form.editTitle') : $t('admin.data.form.newTitle')}
          </h4>
          <p class="text-sm ui-text-muted">{$t('admin.data.form.description')}</p>
        </div>
        {#if $regionDraft.id}
          <span class="rounded-full ui-surface-soft px-3 py-1 text-xs font-semibold ui-text-muted">#{$regionDraft.id}</span>
        {/if}
        {#if draftHasValues}
          <button
            type="button"
            class="ui-btn ui-btn-secondary ui-btn-xs"
            on:click={controller.startNewRegionDraft}
            disabled={$regionSaving || $regionDeleting || $regionSyncBusy}>{$t('admin.data.form.resetSelection')}</button
          >
        {/if}
      </div>

      {#if !$regionDraft.id && !$regionDraft.extractId}
        <div class="rounded-xl border ui-border ui-surface-brand px-3 py-3 text-sm ui-text-body">
          {$t('admin.data.form.mapHint')}
        </div>
      {/if}

      <div class="grid gap-4 xl:grid-cols-[minmax(0,1.25fr)_minmax(0,0.75fr)]">
        <div class="space-y-4 min-w-0">
          <div class="grid gap-3 md:grid-cols-2">
            <label class="space-y-1 text-sm ui-text-body">
              <span>{$t('admin.data.form.regionName')}</span>
              <input
                class="ui-field"
                value={$regionDraft.name}
                on:input={(event) => updateRegionDraftField('name', event.currentTarget.value)}
                placeholder={$t('admin.data.form.regionNamePlaceholder')}
              />
            </label>
            <label class="space-y-1 text-sm ui-text-body">
              <span>{$t('admin.data.form.slug')}</span>
              <input
                class="ui-field"
                value={$regionDraft.slug}
                on:input={(event) => updateRegionDraftField('slug', event.currentTarget.value)}
                placeholder={$t('admin.data.form.slugPlaceholder')}
              />
            </label>
          </div>

          <div class="rounded-xl border ui-border ui-surface-base px-3 py-3">
            <p class="text-xs font-semibold uppercase tracking-wide ui-text-muted">{$t('admin.data.form.selectedExtract')}</p>
            {#if $regionDraft.extractId && $regionDraft.extractSource}
              <p class="mt-2 text-sm font-medium ui-text-strong break-words">
                {$regionDraft.extractLabel || $regionDraft.name || $regionDraft.extractId}
              </p>
              <p class="mt-1 text-xs ui-text-subtle break-all">{$regionDraft.extractSource} · {$regionDraft.extractId}</p>
            {:else}
              <p class="mt-2 text-sm ui-text-subtle">{$t('admin.data.form.selectedExtractEmpty')}</p>
            {/if}
          </div>

          <details class="rounded-xl border ui-border ui-surface-base px-3 py-3">
            <summary class="cursor-pointer text-sm font-semibold ui-text-strong">
              {$t('admin.data.form.advancedTitle')}
            </summary>

            <div class="mt-4 space-y-4">
              <div class="space-y-2 text-sm ui-text-body">
                <label class="space-y-1 block">
                  <span>{$t('admin.data.form.searchQuery')}</span>
                  <div class="flex flex-col gap-2 sm:flex-row">
                    <input
                      class="ui-field flex-1"
                      value={$regionDraft.searchQuery}
                      on:input={controller.handleRegionSearchQueryInput}
                      placeholder={$t('admin.data.form.searchQueryPlaceholder')}
                    />
                    <button
                      type="button"
                      class="ui-btn ui-btn-secondary"
                      on:click={controller.resolveRegionExtractCandidates}
                      disabled={$regionResolveBusy || $regionSaving || $regionDeleting}
                    >
                      {$regionResolveBusy ? $t('admin.data.form.resolvingExtract') : $t('admin.data.form.resolveExtract')}
                    </button>
                  </div>
                </label>

                {#if $regionDraft.extractResolutionStatus !== 'resolved' && $regionDraft.extractResolutionError}
                  <p class="text-xs ui-text-danger break-words">{$regionDraft.extractResolutionError}</p>
                {/if}
              </div>

              {#if $regionExtractCandidates.length > 0}
                <div class="space-y-2 rounded-xl border ui-border px-3 py-3">
                  <p class="text-xs font-semibold uppercase tracking-wide ui-text-muted">{$t('admin.data.form.extractCandidates')}</p>
                  <div class="space-y-2">
                    {#each $regionExtractCandidates as candidate (`extract-candidate-${candidate.extractSource}-${candidate.extractId}`)}
                      <label class="block cursor-pointer rounded-lg border ui-border px-3 py-2">
                        <div class="flex items-start gap-3">
                          <input
                            type="radio"
                            name="region-extract-candidate"
                            checked={String($regionDraft.extractSource || '').trim() === String(candidate.extractSource || '').trim()
                              && String($regionDraft.extractId || '').trim() === String(candidate.extractId || '').trim()}
                            on:change={() => controller.applyRegionExtractCandidate(candidate)}
                          />
                          <div class="min-w-0">
                            <p class="font-medium ui-text-strong break-words">{candidate.extractLabel}</p>
                            <p class="text-xs ui-text-subtle break-all">{candidate.extractSource} · {candidate.extractId}</p>
                          </div>
                        </div>
                      </label>
                    {/each}
                  </div>
                </div>
              {/if}

              <div class="grid gap-3 md:grid-cols-2">
                <label class="space-y-1 text-sm ui-text-body">
                  <span>{$t('admin.data.form.sourceLayer')}</span>
                  <input
                    class="ui-field"
                    value={$regionDraft.sourceLayer}
                    on:input={(event) => updateRegionDraftField('sourceLayer', event.currentTarget.value)}
                    placeholder={$t('admin.data.form.sourceLayerPlaceholder')}
                  />
                </label>
                <label class="space-y-1 text-sm ui-text-body">
                  <span>{$t('admin.data.form.autoSyncIntervalHours')}</span>
                  <input
                    class="ui-field"
                    type="number"
                    min="0"
                    max="8760"
                    value={$regionDraft.autoSyncIntervalHours}
                    on:input={(event) => updateRegionDraftField('autoSyncIntervalHours', Number(event.currentTarget.value || 0))}
                  />
                </label>
                <label class="space-y-1 text-sm ui-text-body">
                  <span>{$t('admin.data.form.pmtilesMinZoom')}</span>
                  <input
                    class="ui-field"
                    type="number"
                    min="0"
                    max="22"
                    value={$regionDraft.pmtilesMinZoom}
                    on:input={(event) => updateRegionDraftField('pmtilesMinZoom', Number(event.currentTarget.value || 0))}
                  />
                </label>
                <label class="space-y-1 text-sm ui-text-body">
                  <span>{$t('admin.data.form.pmtilesMaxZoom')}</span>
                  <input
                    class="ui-field"
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
                  ><input
                    type="checkbox"
                    checked={$regionDraft.enabled}
                    on:change={(event) => updateRegionDraftField('enabled', event.currentTarget.checked)}
                  />
                  {$t('admin.data.form.enabled')}</label
                >
                <label class="flex items-center gap-2 text-sm ui-text-body"
                  ><input
                    type="checkbox"
                    checked={$regionDraft.autoSyncEnabled}
                    on:change={(event) => updateRegionDraftField('autoSyncEnabled', event.currentTarget.checked)}
                  />
                  {$t('admin.data.form.autoSyncEnabled')}</label
                >
                <label class="flex items-center gap-2 text-sm ui-text-body"
                  ><input
                    type="checkbox"
                    checked={$regionDraft.autoSyncOnStart}
                    on:change={(event) => updateRegionDraftField('autoSyncOnStart', event.currentTarget.checked)}
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
            <button
              type="submit"
              class="ui-btn ui-btn-primary"
              disabled={$regionSaving
                || $regionDeleting
                || !String($regionDraft.extractId || '').trim()
                || !String($regionDraft.extractSource || '').trim()
                || !String($regionDraft.name || '').trim()
                || !String($regionDraft.slug || '').trim()}
              >{$regionDraft.id ? $t('admin.data.form.saveRegion') : $t('admin.data.form.createRegion')}</button
            >
            {#if $regionDraft.id}
              <button
                type="button"
                class="ui-btn ui-btn-secondary"
                disabled={$regionSaving || $regionDeleting || $regionSyncBusy}
                on:click={() => controller.syncRegionNow($regionDraft.id)}>{$t('admin.data.form.syncNow')}</button
              >
              <button
                type="button"
                class="ui-btn ui-btn-danger"
                disabled={$regionSaving || $regionDeleting || $regionSyncBusy}
                on:click={() => controller.deleteDataRegion($regionDraft.id)}
                >{$regionDeleting ? $t('admin.data.form.deleting') : $t('admin.data.form.deleteRegion')}</button
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
        <div class="data-region-list-scroll space-y-2 overflow-y-auto pr-1" bind:this={regionListScroller}>
          {#each visibleRegions as region (`data-region-${region.id}`)}
            {@const statusMeta = controller.getRegionStatusMeta(region.lastSyncStatus, region)}
            <button
              type="button"
              class="data-region-card data-region-card-compact w-full rounded-xl px-3 py-2.5 text-left transition"
              data-selected={$selectedDataRegionId === region.id ? 'true' : 'false'}
              on:click={() => controller.selectDataRegion(region)}
            >
              <div class="flex flex-wrap items-start justify-between gap-2">
                <div class="min-w-0 flex-1">
                  <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <p class="font-semibold ui-text-strong break-words">{region.name}</p>
                    <span class="text-xs ui-text-subtle break-words">#{region.id} · {region.slug}</span>
                  </div>
                  <p class="mt-1 text-sm ui-text-body break-all">{controller.getRegionExtractPrimaryText(region)}</p>
                  {#if controller.getRegionExtractSecondaryText(region)}
                    <p class="mt-1 text-xs ui-text-subtle break-all">{controller.getRegionExtractSecondaryText(region)}</p>
                  {/if}
                </div>
                <span
                  class="badge-pill data-status-pill shrink-0 rounded-full px-2.5 py-1 text-xs font-semibold"
                  data-tone={statusMeta.tone}>{statusMeta.text}</span
                >
              </div>

              <div class="data-region-meta mt-2 flex flex-wrap gap-2 text-xs ui-text-subtle">
                <span class="rounded-full ui-surface-soft px-2 py-1">{$t('admin.data.list.lastSync')}: {formatUiDate(region.lastSuccessfulSyncAt) || '---'}</span>
                <span class="rounded-full ui-surface-soft px-2 py-1">{$t('admin.data.list.nextSync')}: {formatUiDate(region.nextSyncAt) || '---'}</span>
                <span class="rounded-full ui-surface-soft px-2 py-1">{$t('admin.data.list.pmtilesSize')}: {controller.formatStorageBytes(region.pmtilesBytes)}</span>
                <span class="rounded-full ui-surface-soft px-2 py-1">
                  {$t('admin.data.list.dbSize')}: {region.dbBytesApproximate ? '~' : ''}{controller.formatStorageBytes(region.dbBytes)}
                </span>
                <span class="rounded-full ui-surface-soft px-2 py-1">{controller.getRegionEnabledLabel(region.enabled)}</span>
                <span class="rounded-full ui-surface-soft px-2 py-1">{controller.getRegionSyncModeLabel(region)}</span>
              </div>

              {#if region.lastSyncError}
                <p class="mt-2 text-xs ui-text-danger break-words">{region.lastSyncError}</p>
              {/if}
            </button>
          {/each}

          {#if visibleRegionCount < regions.length}
            <div class="data-region-list-sentinel" bind:this={regionListSentinel} aria-hidden="true"></div>
          {/if}
        </div>
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
        <div class="mt-3 overflow-x-auto rounded-xl border ui-border">
          <table class="min-w-full text-sm">
            <thead>
              <tr class="border-b ui-border text-left ui-text-muted">
                <th class="px-3 py-2">{$t('admin.data.history.run')}</th>
                <th class="px-3 py-2">{$t('admin.data.history.trigger')}</th>
                <th class="px-3 py-2">{$t('admin.data.history.status')}</th>
                <th class="px-3 py-2">{$t('admin.data.history.requested')}</th>
                <th class="px-3 py-2">{$t('admin.data.history.finished')}</th>
                <th class="px-3 py-2">{$t('admin.data.history.features')}</th>
              </tr>
            </thead>
            <tbody>
              {#each $regionRuns as run (`region-run-${run.id}`)}
                {@const runStatusMeta = controller.getRegionStatusMeta(run.status, run)}
                <tr class="border-b ui-border-soft">
                  <td class="px-3 py-2 font-medium ui-text-strong">#{run.id}</td>
                  <td class="px-3 py-2 ui-text-muted">{controller.formatRunTriggerReason(run.triggerReason)}</td>
                  <td class="px-3 py-2"
                    ><span
                      class="badge-pill data-status-pill rounded-full px-2.5 py-1 text-xs font-semibold"
                      data-tone={runStatusMeta.tone}>{runStatusMeta.text}</span
                    ></td
                  >
                  <td class="px-3 py-2 ui-text-muted">{formatUiDate(run.requestedAt || run.startedAt) || '---'}</td>
                  <td class="px-3 py-2 ui-text-muted">{formatUiDate(run.finishedAt) || '---'}</td>
                  <td class="px-3 py-2 ui-text-muted">{run.activeFeatureCount ?? run.importedFeatureCount ?? '---'}</td>
                </tr>
                {#if run.error}
                  <tr class="border-b ui-border-soft ui-surface-danger-soft">
                    <td colspan="6" class="px-3 py-2 text-xs ui-text-danger">{run.error}</td>
                  </tr>
                {/if}
              {/each}
            </tbody>
          </table>
        </div>
      {:else if !$selectedDataRegionId}
        <p class="mt-3 text-sm ui-text-subtle">{$t('admin.data.history.selectRegionHint')}</p>
      {/if}
    </section>
  </section>
{/if}

<style>
  @import './admin-tabs.css';
</style>
