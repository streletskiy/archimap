<script>
  import { onDestroy } from 'svelte';

  import { t } from '$lib/i18n/index';
  import { formatUiDate } from '$lib/utils/edit-ui';
  import { UiPressableCard, UiScrollArea } from '$lib/components/base';

  export let controller = null;
  export let regions = [];
  export let selectedDataRegionId = null;
  export let dataLoading = false;

  const REGION_LIST_BATCH_SIZE = 24;

  let visibleRegionCount = REGION_LIST_BATCH_SIZE;
  let visibleRegions;
  let viewportRef;
  let sentinelRef;
  let regionListObserver = null;
  let lastRegionListKey;

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

  function ensureSelectedRegionVisible(selectedId, items) {
    const numericSelectedRegionId = Number(selectedId || 0);
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

    if (!viewportRef || !sentinelRef || typeof IntersectionObserver === 'undefined') return;

    regionListObserver = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          loadMoreRegions();
        }
      },
      {
        root: viewportRef,
        rootMargin: '0px 0px 180px 0px',
        threshold: 0.1
      }
    );

    regionListObserver.observe(sentinelRef);
  }

  $: {
    const nextRegionListKey = buildRegionListKey(regions);
    if (nextRegionListKey !== lastRegionListKey) {
      lastRegionListKey = nextRegionListKey;
      resetVisibleRegionCount(regions.length);
    }
    void lastRegionListKey;
  }

  $: clampVisibleRegionCount(regions.length);
  $: ensureSelectedRegionVisible(selectedDataRegionId, regions);
  $: visibleRegions = regions.slice(0, visibleRegionCount);

  $: if (!viewportRef || !sentinelRef) {
    destroyRegionListObserver();
  }

  $: if (viewportRef && sentinelRef && visibleRegions.length > 0 && visibleRegionCount < regions.length) {
    setupRegionListObserver();
  }

  $: if (visibleRegionCount >= regions.length || regions.length === 0) {
    destroyRegionListObserver();
  }

  onDestroy(() => {
    destroyRegionListObserver();
  });
</script>

<section class="space-y-3 min-w-0">
  <div class="flex items-center justify-between gap-2">
    <h4 class="text-sm font-semibold uppercase tracking-wide ui-text-muted">{$t('admin.data.list.title')}</h4>
    <span class="text-xs ui-text-subtle">{Math.min(visibleRegions.length, regions.length)} / {regions.length}</span>
  </div>

  {#if dataLoading}
    <p class="data-summary-card rounded-xl px-3 py-2 text-sm ui-text-subtle">{$t('admin.data.list.loading')}</p>
  {:else if regions.length === 0}
    <p class="rounded-xl border border-dashed ui-border-strong px-3 py-4 text-sm ui-text-subtle">
      {$t('admin.data.list.empty')}
    </p>
  {:else}
    <UiScrollArea
      className="ui-scroll-surface max-h-[34rem] rounded-xl"
      contentClassName="space-y-2 p-2"
      bind:viewportRef={viewportRef}
    >
      {#each visibleRegions as region (`data-region-${region.id}`)}
        {@const statusMeta = controller.getRegionStatusMeta(region.lastSyncStatus, region)}
        {@const extractSummary = controller.getRegionExtractSummaryText(region)}
        <UiPressableCard
          selected={selectedDataRegionId === region.id}
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
        <div class="data-region-list-sentinel" bind:this={sentinelRef} aria-hidden="true"></div>
      {/if}
    </UiScrollArea>
  {/if}
</section>

<style>
  .data-summary-card {
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
    background: #fee2e2;
    color: #b91c1c;
  }
</style>
