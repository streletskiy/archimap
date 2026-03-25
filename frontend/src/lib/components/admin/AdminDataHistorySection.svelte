<script>
  import { t } from '$lib/i18n/index';
  import { formatUiDate } from '$lib/utils/edit-ui';
  import { UiTable, UiTableBody, UiTableCell, UiTableHead, UiTableHeader, UiTableRow } from '$lib/components/base';

  export let controller = null;
  export let selectedDataRegionId = null;
  export let regionRuns = [];
  export let regionRunsLoading = false;
  export let regionRunsStatus = '';
</script>

<section class="data-history-card rounded-2xl p-4 min-w-0">
  <div class="flex flex-wrap items-center justify-between gap-2">
    <h4 class="text-base font-bold ui-text-strong">{$t('admin.data.history.title')}</h4>
    {#if regionRunsLoading}
      <span class="text-sm ui-text-subtle">{$t('admin.data.history.loading')}</span>
    {/if}
  </div>

  {#if regionRunsStatus}
    <p class="mt-2 text-sm ui-text-muted">{regionRunsStatus}</p>
  {/if}

  {#if selectedDataRegionId && regionRuns.length > 0}
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
                <UiTableCell colspan="6" className="text-xs ui-text-danger">{run.error}</UiTableCell>
              </UiTableRow>
            {/if}
          {/each}
        </UiTableBody>
      </UiTable>
    </div>
  {:else if !selectedDataRegionId}
    <p class="mt-3 text-sm ui-text-subtle">{$t('admin.data.history.selectRegionHint')}</p>
  {/if}
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
