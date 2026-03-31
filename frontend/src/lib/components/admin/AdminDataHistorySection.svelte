<script>
  import { t } from '$lib/i18n/index';
  import { formatUiDate } from '$lib/utils/edit-ui';
  import { UiScrollArea, UiTable, UiTableBody, UiTableCell, UiTableHead, UiTableHeader, UiTableRow } from '$lib/components/base';
  import { EditsPagination } from '$lib/components/edits';

  export let controller = null;
  export let selectedDataRegionId = null;
  export let regionRuns = [];
  export let regionRunsLoading = false;
  export let regionRunsStatus = '';
  export let regionRunsPage = 1;
  export let regionRunsPageCount = 0;
  export let regionRunsTotal = 0;

  const REGION_RUNS_PAGE_SIZE = 20;
  const REGION_RUNS_SKELETON_DELAY_MS = 40;

  function isSelectedRegion() {
    return Number(selectedDataRegionId || 0) > 0;
  }
</script>

<section class="data-history-card rounded-2xl p-4 min-w-0 min-h-0 flex flex-col overflow-hidden">
  <div class="flex flex-wrap items-center justify-between gap-2">
    <div class="min-w-0">
      <h4 class="text-base font-bold ui-text-strong">{$t('admin.data.history.title')}</h4>
      {#if regionRunsStatus}
        <p class="mt-2 text-sm ui-text-danger break-words">{regionRunsStatus}</p>
      {/if}
    </div>

    {#if isSelectedRegion()}
      {#if regionRunsLoading}
        <span class="text-sm ui-text-subtle">{$t('admin.data.history.loading')}</span>
      {:else}
        <span class="text-xs ui-text-subtle">{regionRunsTotal}</span>
      {/if}
    {/if}
  </div>

  <div class="mt-3 min-h-0 flex-1">
    {#if isSelectedRegion()}
      <UiScrollArea className="ui-scroll-surface h-full min-h-0" contentClassName="h-full">
        <div class="data-history-scroll-content flex min-h-full flex-col gap-3">
          {#if regionRunsLoading}
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
                {#each Array.from({ length: REGION_RUNS_PAGE_SIZE }, (_, index) => index) as row (row)}
                  <UiTableRow
                    aria-hidden="true"
                    className="pointer-events-none select-none animate-pulse"
                    style={`animation-delay: ${row * REGION_RUNS_SKELETON_DELAY_MS}ms;`}
                  >
                    <UiTableCell>
                      <div class="flex items-center gap-2">
                        <span class="h-4 w-[3.5rem] rounded-full bg-black/10 dark:bg-white/10"></span>
                        <span class="h-4 w-[7ch] rounded-full bg-black/10 dark:bg-white/10"></span>
                      </div>
                    </UiTableCell>
                    <UiTableCell>
                      <div class="h-4 w-[12ch] rounded-full bg-black/10 dark:bg-white/10"></div>
                    </UiTableCell>
                    <UiTableCell>
                      <div class="h-6 w-[8ch] rounded-full bg-black/10 dark:bg-white/10"></div>
                    </UiTableCell>
                    <UiTableCell>
                      <div class="h-4 w-[13ch] rounded-full bg-black/10 dark:bg-white/10"></div>
                    </UiTableCell>
                    <UiTableCell>
                      <div class="h-4 w-[13ch] rounded-full bg-black/10 dark:bg-white/10"></div>
                    </UiTableCell>
                    <UiTableCell>
                      <div class="h-5 w-[6ch] rounded-full bg-black/10 dark:bg-white/10"></div>
                    </UiTableCell>
                  </UiTableRow>
                {/each}
              </UiTableBody>
            </UiTable>
          {:else if regionRuns.length > 0}
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
                {#each regionRuns as run (`region-run-${run.id}`)}
                  {@const runStatusMeta = controller.getRegionStatusMeta(run.status, run)}
                  <UiTableRow>
                    <UiTableCell className="font-medium ui-text-strong">#{run.id}</UiTableCell>
                    <UiTableCell className="ui-text-muted">{controller.formatRunTriggerReason(run.triggerReason)}</UiTableCell>
                    <UiTableCell>
                      <span
                        class="badge-pill data-status-pill rounded-full px-2.5 py-1 text-xs font-semibold"
                        data-tone={runStatusMeta.tone}>{runStatusMeta.text}</span
                      >
                    </UiTableCell>
                    <UiTableCell className="ui-text-muted">{formatUiDate(run.requestedAt || run.startedAt) || '---'}</UiTableCell>
                    <UiTableCell className="ui-text-muted">{formatUiDate(run.finishedAt) || '---'}</UiTableCell>
                    <UiTableCell className="ui-text-muted">{run.activeFeatureCount ?? run.importedFeatureCount ?? '---'}</UiTableCell>
                  </UiTableRow>
                  {#if run.error}
                    <UiTableRow className="ui-surface-danger-soft">
                      <UiTableCell colspan="6" className="text-xs ui-text-danger break-words">{run.error}</UiTableCell>
                    </UiTableRow>
                  {/if}
                {/each}
              </UiTableBody>
            </UiTable>
          {:else if !regionRunsStatus}
            <div class="flex min-h-full items-center justify-center px-3 py-6">
              <p class="rounded-xl border border-dashed ui-border-strong ui-surface-soft px-4 py-5 text-sm ui-text-subtle">
                {$t('admin.data.history.empty')}
              </p>
            </div>
          {/if}
        </div>
      </UiScrollArea>
    {:else}
      <div class="flex min-h-full items-center justify-center px-3 py-6">
        <p class="rounded-xl border border-dashed ui-border-strong ui-surface-soft px-4 py-5 text-sm ui-text-subtle">
          {$t('admin.data.history.selectRegionHint')}
        </p>
      </div>
    {/if}
  </div>

  <EditsPagination
    page={regionRunsPage}
    pageCount={regionRunsPageCount}
    pageInfo={regionRunsPageCount > 0 ? $t('admin.data.history.pageInfo', { page: regionRunsPage, pages: regionRunsPageCount }) : ''}
    loading={regionRunsLoading}
    previousLabel={$t('common.previous')}
    nextLabel={$t('common.next')}
    onPageChange={(nextPage) => controller.loadRegionRuns(selectedDataRegionId, nextPage)}
  />
</section>

<style>
  .data-history-card {
    border: 1px solid var(--panel-border);
    background: var(--panel-solid);
    box-shadow: var(--shadow-soft);
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
