<script>
  import { tick } from 'svelte';

  import { UiButton, UiScrollArea } from '$lib/components/base';
  import { EditsIdentityCell } from '$lib/components/edits';
  import { t } from '$lib/i18n/index';
  import { formatUiDate, getSyncBadgeMeta } from '$lib/utils/edit-ui';
  import CloseIcon from '$lib/components/icons/CloseIcon.svelte';

  export let open = false;
  export let selectedCandidate = null;
  export let selectedCandidateDetail = null;
  export let detailBusy = false;
  export let isMasterAdmin = false;
  export let onClose = () => {};
  export let onRefresh = () => {};
  export let onSync = () => {};

  let modalEl = null;
  let hadOpenState = false;
  let detailCandidate;
  let candidateAddress = '';
  let currentTags = {};
  let desiredTags = {};
  let computedDiff = [];

  function isArchivedCandidate(candidate) {
    const normalized = String(candidate?.syncStatus || 'unsynced').trim().toLowerCase();
    return normalized === 'synced' || normalized === 'cleaned' || Boolean(candidate?.syncReadOnly);
  }

  function getCandidateAddress(item) {
    const displayAddress = String(item?.displayAddress || '').trim();
    if (displayAddress) return displayAddress;

    const localAddress = String(item?.localState?.address || '').trim();
    if (localAddress) return localAddress;

    const contourAddress = String(item?.contourState?.address || '').trim();
    if (contourAddress) return contourAddress;
    return '';
  }

  function closeModal() {
    onClose?.();
  }

  function onModalKeydown(event) {
    if (event.key === 'Escape') {
      event.preventDefault();
      closeModal();
    }
  }

  $: detailCandidate =
    selectedCandidateDetail &&
    (selectedCandidateDetail.syncStatus || selectedCandidateDetail.syncReadOnly || selectedCandidateDetail.liveElement || selectedCandidateDetail.currentContourTags)
      ? selectedCandidateDetail
      : selectedCandidate;
  $: candidateAddress = getCandidateAddress(detailCandidate || selectedCandidate);
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

  $: if (open && !hadOpenState) {
    hadOpenState = true;
    tick().then(() => modalEl?.focus());
  } else if (!open && hadOpenState) {
    hadOpenState = false;
  }
  $: void hadOpenState;
</script>

{#if open}
  {@const syncMeta = getSyncBadgeMeta(detailCandidate?.syncStatus || selectedCandidate?.syncStatus, $t, 'admin.edits')}
  <div class="osm-detail-modal-backdrop">
    <button
      type="button"
      class="osm-detail-modal-dismiss-layer"
      tabindex="-1"
      aria-label={$t('common.close')}
      on:click={closeModal}
    ></button>

    <div
      class="osm-detail-modal"
      bind:this={modalEl}
      role="dialog"
      aria-modal="true"
      aria-label={$t('admin.osm.detail.title')}
      tabindex="-1"
      on:keydown={onModalKeydown}
    >
      <div class="osm-detail-modal-header">
        <div class="min-w-0 space-y-1">
          <p class="text-[11px] font-semibold uppercase tracking-wide ui-text-muted">{$t('admin.osm.detail.title')}</p>
          <EditsIdentityCell
            idLabel={$t('admin.edits.id')}
            osmType={selectedCandidate?.osmType}
            osmId={selectedCandidate?.osmId}
            address={candidateAddress}
          />
        </div>
        <div class="flex shrink-0 items-start gap-2">
          <span class={`badge-pill rounded-full px-2.5 py-1 text-xs font-semibold ${syncMeta.cls}`}>
            {syncMeta.text}
          </span>
          <UiButton
            type="button"
            variant="secondary"
            size="close"
            className="shrink-0"
            aria-label={$t('common.close')}
            onclick={closeModal}
          >
            <CloseIcon class="ui-close-icon" />
          </UiButton>
        </div>
      </div>

      <div class="osm-detail-modal-body">
        <UiScrollArea className="ui-scroll-surface h-full">
          <div class="osm-detail-modal-body-content">
            {#if detailBusy}
              <p class="text-sm ui-text-subtle">{$t('admin.loading')}</p>
            {:else}
              {#if selectedCandidateDetail?.preflightError}
                <p class="rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">{selectedCandidateDetail.preflightError}</p>
              {/if}
              {#if selectedCandidateDetail?.conflict}
                <p class="rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">{selectedCandidateDetail.conflict.message}</p>
              {/if}
              {#if isArchivedCandidate(detailCandidate)}
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
                      <div class={`flex items-start px-3 py-1 group border-b last:border-0 ui-border/50
                        ${line.type === 'added' ? 'bg-emerald-100/60 dark:bg-emerald-900/40 text-emerald-900 dark:text-emerald-100' : ''}
                        ${line.type === 'removed' ? 'bg-rose-100/60 dark:bg-rose-900/40 text-rose-900 dark:text-rose-100' : ''}
                        ${line.type === 'unchanged' ? 'ui-text-body opacity-80' : ''}`.trim()}>
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

              {#if isMasterAdmin && !isArchivedCandidate(detailCandidate)}
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
          </div>
        </UiScrollArea>
      </div>
    </div>
  </div>
{/if}

<style>
  .osm-detail-modal-backdrop {
    --osm-detail-modal-gap: 0.85rem;
    --osm-detail-modal-top-gap: calc(var(--osm-detail-modal-gap) + env(safe-area-inset-top, 0px));
    --osm-detail-modal-bottom-gap: calc(var(--osm-detail-modal-gap) + env(safe-area-inset-bottom, 0px));
    position: fixed;
    inset: 0;
    z-index: 1310;
    display: grid;
    place-items: center;
    padding: var(--osm-detail-modal-top-gap) var(--osm-detail-modal-gap) var(--osm-detail-modal-bottom-gap);
    background: rgba(8, 17, 31, 0.66);
    overscroll-behavior: contain;
  }

  .osm-detail-modal-dismiss-layer {
    position: absolute;
    inset: 0;
    border: 0;
    padding: 0;
    background: transparent;
  }

  .osm-detail-modal {
    position: relative;
    z-index: 1;
    width: min(74rem, calc(100vw - (var(--osm-detail-modal-gap) * 2)));
    height: min(56rem, calc(100vh - var(--osm-detail-modal-top-gap) - var(--osm-detail-modal-bottom-gap)));
    height: min(56rem, calc(100dvh - var(--osm-detail-modal-top-gap) - var(--osm-detail-modal-bottom-gap)));
    max-height: calc(100vh - var(--osm-detail-modal-top-gap) - var(--osm-detail-modal-bottom-gap));
    max-height: calc(100dvh - var(--osm-detail-modal-top-gap) - var(--osm-detail-modal-bottom-gap));
    min-height: 0;
    overflow: hidden;
    display: grid;
    grid-template-rows: auto minmax(0, 1fr);
    gap: 0.9rem;
    padding: 1rem;
    border: 1px solid var(--panel-border);
    border-radius: 1.45rem;
    background: var(--panel-solid);
    box-shadow: var(--shadow-panel);
  }

  .osm-detail-modal-header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 0.75rem;
    min-width: 0;
  }

  .osm-detail-modal-body {
    min-height: 0;
    border: 1px solid var(--panel-border);
    border-radius: 1.15rem;
    background: var(--panel-solid);
    overflow: hidden;
  }

  .osm-detail-modal-body :global([data-slot='scroll-area']),
  .osm-detail-modal-body :global([data-slot='scroll-area-viewport']) {
    min-width: 0;
  }

  .osm-detail-modal-body-content {
    display: grid;
    gap: 0.9rem;
    min-width: 0;
    padding: 0.8rem;
  }

  @media (max-width: 767px) {
    .osm-detail-modal-backdrop {
      --osm-detail-modal-gap: 0.65rem;
    }

    .osm-detail-modal {
      width: 100%;
      height: calc(100vh - var(--osm-detail-modal-top-gap) - var(--osm-detail-modal-bottom-gap));
      height: calc(100dvh - var(--osm-detail-modal-top-gap) - var(--osm-detail-modal-bottom-gap));
      max-height: calc(100vh - var(--osm-detail-modal-top-gap) - var(--osm-detail-modal-bottom-gap));
      max-height: calc(100dvh - var(--osm-detail-modal-top-gap) - var(--osm-detail-modal-bottom-gap));
      padding: 0.75rem;
      border-radius: 1.2rem;
    }

    .osm-detail-modal-body-content {
      gap: 0.75rem;
      padding: 0.65rem;
    }
  }
</style>
