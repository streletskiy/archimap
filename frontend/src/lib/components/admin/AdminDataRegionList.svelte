<script>
  import { t } from '$lib/i18n/index';
  import { formatUiDate } from '$lib/utils/edit-ui';
  import { UiPressableCard } from '$lib/components/base';
  import { EditsPagination } from '$lib/components/edits';

  export let controller = null;
  export let regions = [];
  export let selectedDataRegionId = null;
  export let dataLoading = false;

  const REGION_LIST_PAGE_SIZE = 20;
  const REGION_CARD_SKELETON_DELAY_MS = 40;

  let regionPage = 1;
  let regionPageCount = 0;
  let lastRegionListKey = '';
  let lastSelectedDataRegionId = null;

  function buildRegionListKey(items) {
    return (Array.isArray(items) ? items : []).map((region) => Number(region?.id || 0)).join(':');
  }

  function normalizeRegionPage(value, totalPages) {
    const numericPage = Math.trunc(Number(value) || 1);
    const clampedPage = Math.max(1, numericPage);
    const pageTotal = Math.max(0, Math.trunc(Number(totalPages) || 0));
    if (pageTotal > 0) {
      return Math.min(clampedPage, pageTotal);
    }
    return 1;
  }

  function getRegionPageForIndex(index) {
    return Math.floor(Math.max(0, Math.trunc(Number(index) || 0)) / REGION_LIST_PAGE_SIZE) + 1;
  }

  function setRegionPage(nextPage) {
    const normalizedPage = normalizeRegionPage(nextPage, regionPageCount);
    if (normalizedPage === regionPage) return;
    regionPage = normalizedPage;
  }

  $: regionPageCount = Math.ceil(Math.max(0, Number(regions?.length || 0)) / REGION_LIST_PAGE_SIZE);
  $: regionPage = normalizeRegionPage(regionPage, regionPageCount);

  $: {
    const nextRegionListKey = buildRegionListKey(regions);
    const regionsChanged = nextRegionListKey !== lastRegionListKey;
    if (regionsChanged) {
      lastRegionListKey = nextRegionListKey;
    }

    const nextSelectedDataRegionId = Math.trunc(Number(selectedDataRegionId || 0));
    const selectionChanged = nextSelectedDataRegionId !== lastSelectedDataRegionId;
    if (selectionChanged) {
      lastSelectedDataRegionId = nextSelectedDataRegionId;
    }

    if (nextSelectedDataRegionId > 0 && (selectionChanged || regionsChanged)) {
      const selectedIndex = (Array.isArray(regions) ? regions : []).findIndex(
        (item) => Number(item?.id || 0) === nextSelectedDataRegionId
      );
      if (selectedIndex >= 0) {
        const nextPage = getRegionPageForIndex(selectedIndex);
        if (nextPage !== regionPage) {
          regionPage = normalizeRegionPage(nextPage, regionPageCount);
        }
      }
    }

    void lastRegionListKey;
    void lastSelectedDataRegionId;
  }

</script>

<section class="space-y-3 min-w-0">
  <div class="flex items-center justify-between gap-2">
    <h4 class="text-sm font-semibold uppercase tracking-wide ui-text-muted">{$t('admin.data.list.title')}</h4>
    <span class="text-xs ui-text-subtle">{regions.length}</span>
  </div>

  {#if dataLoading}
    <div class="space-y-2">
      {#each Array.from({ length: REGION_LIST_PAGE_SIZE }, (_, index) => index) as row (row)}
        <div
          aria-hidden="true"
          class="data-region-card pointer-events-none select-none animate-pulse"
          style={`animation-delay: ${row * REGION_CARD_SKELETON_DELAY_MS}ms;`}
        >
          <div class="flex flex-wrap items-start justify-between gap-2">
            <div class="min-w-0 flex-1">
              <div class="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                <span class="h-4 w-[18ch] rounded-full bg-black/10 dark:bg-white/10"></span>
                <span class="h-3 w-[9ch] rounded-full bg-black/10 dark:bg-white/10"></span>
              </div>
              <span class="mt-1 block h-3 w-[min(24rem,70%)] max-w-full rounded-full bg-black/10 dark:bg-white/10"></span>
            </div>
            <span class="shrink-0 h-6 w-[8ch] rounded-full bg-black/10 dark:bg-white/10"></span>
          </div>

          <div class="data-region-meta mt-1.5 flex flex-wrap gap-2 text-xs ui-text-subtle">
            <span class="h-6 w-[12ch] rounded-full bg-black/10 dark:bg-white/10"></span>
            <span class="h-6 w-[12ch] rounded-full bg-black/10 dark:bg-white/10"></span>
            <span class="h-6 w-[13ch] rounded-full bg-black/10 dark:bg-white/10"></span>
            <span class="h-6 w-[11ch] rounded-full bg-black/10 dark:bg-white/10"></span>
            <span class="h-6 w-[8ch] rounded-full bg-black/10 dark:bg-white/10"></span>
          </div>

          <div class="mt-2 h-4 w-[32ch] max-w-full rounded-full bg-black/10 dark:bg-white/10"></div>
        </div>
      {/each}
    </div>
  {:else if regions.length === 0}
    <p class="rounded-xl border border-dashed ui-border-strong px-3 py-4 text-sm ui-text-subtle">
      {$t('admin.data.list.empty')}
    </p>
  {:else}
    <div class="space-y-2">
      {#each (Array.isArray(regions) ? regions : []).slice((regionPage - 1) * REGION_LIST_PAGE_SIZE, regionPage * REGION_LIST_PAGE_SIZE) as region (`data-region-${region.id}`)}
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
    </div>
  {/if}

  <EditsPagination
    page={regionPage}
    pageCount={regionPageCount}
    pageInfo={regionPageCount > 0 ? $t('admin.data.list.pageInfo', { page: regionPage, pages: regionPageCount }) : ''}
    loading={dataLoading}
    previousLabel={$t('common.previous')}
    nextLabel={$t('common.next')}
    onPageChange={setRegionPage}
  />
</section>

<style>
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
