<script>
  import { fade } from 'svelte/transition';

  import { formatUiDate } from '$lib/utils/edit-ui';
  import { t } from '$lib/i18n/index';
  import { UiButton } from '$lib/components/base';

  export let selectedCandidate = null;
  export let selectedCandidateDetail = null;
  export let detailBusy = false;
  export let isMasterAdmin = false;
  export let onClose = () => {};
  export let onRefresh = () => {};
  export let onSync = () => {};

  function isArchivedCandidate(candidate) {
    const normalized = String(candidate?.syncStatus || 'unsynced').trim().toLowerCase();
    return normalized === 'synced' || normalized === 'cleaned';
  }

  $: currentTags = selectedCandidateDetail?.liveElement?.tags || selectedCandidateDetail?.currentContourTags || {};
  $: desiredTags = selectedCandidateDetail?.desiredTags || selectedCandidateDetail?.localState || {};
  $: computedDiff = (() => {
    if (!selectedCandidateDetail) return [];
    const keys = new Set([...Object.keys(currentTags || {}), ...Object.keys(desiredTags || {})]);
    const diff = [];
    for (const key of [...keys].sort()) {
      const cur = String(currentTags[key] ?? '');
      const des = String(desiredTags[key] ?? '');
      if (cur === '' && des !== '') {
        diff.push({ type: 'added', key, val: des });
      } else if (cur !== '' && des === '') {
        diff.push({ type: 'removed', key, val: cur });
      } else if (cur !== des) {
        diff.push({ type: 'removed', key, val: cur });
        diff.push({ type: 'added', key, val: des });
      } else {
        diff.push({ type: 'unchanged', key, val: cur });
      }
    }
    return diff;
  })();
</script>

<section class="osm-detail-card space-y-3 rounded-2xl p-4" in:fade={{ duration: 180 }} out:fade={{ duration: 180 }}>
  <div class="flex items-center justify-between gap-2">
    <div>
      <h4 class="text-base font-bold ui-text-strong">{$t('admin.osm.detail.title')}</h4>
      <p class="text-sm ui-text-muted">{selectedCandidate.osmType}/{selectedCandidate.osmId}</p>
    </div>
    <UiButton type="button" variant="secondary" size="close" aria-label={$t('common.close')} onclick={onClose}>
      <svg class="ui-close-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="M6 6L18 18" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" />
        <path d="M18 6L6 18" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" />
      </svg>
    </UiButton>
  </div>

  {#if detailBusy}
    <p class="text-sm ui-text-subtle">{$t('admin.loading')}</p>
  {:else}
    {#if selectedCandidateDetail?.preflightError}
      <p class="rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">{selectedCandidateDetail.preflightError}</p>
    {/if}
    {#if selectedCandidateDetail?.conflict}
      <p class="rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">{selectedCandidateDetail.conflict.message}</p>
    {/if}
    {#if isArchivedCandidate(selectedCandidate)}
      <div class="rounded-xl border ui-border ui-surface-soft p-3 text-sm ui-text-body">
        <p class="font-semibold ui-text-strong">{$t('admin.osm.archive.readOnly')}</p>
        <p class="mt-1 text-xs ui-text-muted">{$t('admin.osm.archive.readOnlyHelp')}</p>
      </div>
    {/if}

    <article class="rounded-xl border ui-border ui-surface-base overflow-hidden">
      <div class="px-3 py-2 border-b ui-border ui-surface-soft">
        <p class="text-xs font-semibold uppercase tracking-wide ui-text-muted">{$t('admin.osm.detail.diff') || 'Детали синхронизации (Diff)'}</p>
      </div>
      <div class="font-mono text-xs leading-6 overflow-x-auto">
        {#if computedDiff.length === 0}
          <div class="p-3 text-center ui-text-muted italic">{$t('admin.osm.detail.noChanges') || 'Без изменений'}</div>
        {:else}
          {#each computedDiff as line}
            <div class="flex items-start px-3 py-1 group border-b last:border-0 ui-border/50
              {line.type === 'added' ? 'bg-emerald-100/60 dark:bg-emerald-900/40 text-emerald-900 dark:text-emerald-100' : ''}
              {line.type === 'removed' ? 'bg-rose-100/60 dark:bg-rose-900/40 text-rose-900 dark:text-rose-100' : ''}
              {line.type === 'unchanged' ? 'ui-text-body opacity-80' : ''}">
              <span class="w-6 shrink-0 select-none opacity-50 font-bold overflow-hidden mt-[1px]">
                {line.type === 'added' ? '+' : line.type === 'removed' ? '-' : ' '}
              </span>
              <span class="w-[30%] shrink-0 truncate select-all font-semibold break-all whitespace-normal pr-2 pt-[1px]">{line.key}</span>
              <span class="mr-2 opacity-50 shrink-0 mt-[1px]">=</span>
              <span class="break-all select-all whitespace-pre-wrap pt-[1px]">{line.val}</span>
            </div>
          {/each}
        {/if}
      </div>
    </article>

    <div class="rounded-xl border ui-border ui-surface-base p-3 text-sm ui-text-body">
      <p><strong>{$t('admin.osm.detail.sourceUpdatedAt')}:</strong> {formatUiDate(selectedCandidateDetail?.sourceOsmUpdatedAt) || '---'}</p>
      <p><strong>{$t('admin.osm.detail.syncSucceededAt')}:</strong> {formatUiDate(selectedCandidateDetail?.syncSucceededAt) || '---'}</p>
      <p><strong>{$t('admin.osm.detail.syncChangesetId')}:</strong> {selectedCandidateDetail?.syncChangesetId || '---'}</p>
      <p><strong>{$t('admin.osm.detail.syncError')}:</strong> {selectedCandidateDetail?.syncErrorText || '---'}</p>
    </div>

    {#if isMasterAdmin && !isArchivedCandidate(selectedCandidate)}
      <div class="flex flex-wrap gap-2">
        <UiButton type="button" onclick={() => onSync(selectedCandidate)}>
          {$t('admin.osm.list.syncNow')}
        </UiButton>
        <UiButton type="button" variant="secondary" onclick={onRefresh}>
          {$t('common.refresh')}
        </UiButton>
      </div>
    {/if}
  {/if}
</section>

<style>
  .osm-detail-card {
    border: 1px solid var(--panel-border);
    background: var(--panel-solid);
    box-shadow: var(--shadow-soft);
  }
</style>
