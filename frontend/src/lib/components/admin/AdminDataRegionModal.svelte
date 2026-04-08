<script>
  import { tick } from 'svelte';

  import { t } from '$lib/i18n/index';
  import { formatUiDate } from '$lib/utils/edit-ui';
  import { UiButton } from '$lib/components/base';
  import CloseIcon from '$lib/components/icons/CloseIcon.svelte';

  import AdminDataForm from './AdminDataForm.svelte';
  import AdminDataHistorySection from './AdminDataHistorySection.svelte';

  export let controller = null;
  export let open = false;
  export let regionDraft = null;
  export let selectedRegion = null;
  export let regionExtractCandidates = [];
  export let regionSaving = false;
  export let regionDeleting = false;
  export let regionSyncBusy = false;
  export let regionResolveBusy = false;
  export let selectedDataRegionId = null;
  export let regionRuns = [];
  export let regionRunsLoading = false;
  export let regionRunsStatus = '';
  export let regionRunsPage = 1;
  export let regionRunsPageCount = 0;
  export let regionRunsTotal = 0;
  export let dataStatus = '';
  export let closeDisabled = false;
  export let onClose = () => {};

  const REGION_FORM_ID = 'admin-data-region-form';

  let modalEl = null;
  let hadOpenState = false;

  function closeModal() {
    if (closeDisabled) return;
    onClose?.();
  }

  function onModalKeydown(event) {
    if (event.key === 'Escape') {
      event.preventDefault();
      closeModal();
    }
  }

  function getRegionTitle(currentDraft = null, currentSelectedRegion = null) {
    const draftName = String(currentDraft?.name || '').trim();
    if (draftName) return draftName;

    const selectedName = String(currentSelectedRegion?.name || '').trim();
    if (selectedName) return selectedName;

    const draftSlug = String(currentDraft?.slug || '').trim();
    if (draftSlug) return draftSlug;

    return currentDraft?.id ? `#${currentDraft.id}` : $t('admin.data.form.newTitle');
  }

  function getRegionMetaLine(currentDraft = null, currentSelectedRegion = null) {
    const parts = [];
    const regionId = Number(currentDraft?.id || currentSelectedRegion?.id || 0);
    const slug = String(currentDraft?.slug || currentSelectedRegion?.slug || '').trim();

    if (Number.isInteger(regionId) && regionId > 0) {
      parts.push(`#${regionId}`);
    }
    if (slug) {
      parts.push(slug);
    }

    return parts.join(' · ');
  }

  function formatBounds(bounds) {
    if (!bounds) return $t('admin.data.form.boundsUnknown');
    return `${bounds.west.toFixed(4)}, ${bounds.south.toFixed(4)} .. ${bounds.east.toFixed(4)}, ${bounds.north.toFixed(4)}`;
  }

  $: modalTitle = getRegionTitle($regionDraft, selectedRegion);
  $: modalMetaLine = getRegionMetaLine($regionDraft, selectedRegion);
  $: modalAriaLabel = modalTitle;
  $: selectedStatusMeta = controller.getRegionStatusMeta(selectedRegion?.lastSyncStatus, selectedRegion);
  $: selectedUpdateMeta = controller.getRegionUpdateMeta(selectedRegion);
  $: syncBlockedReason = $regionDraft.id ? controller.getRegionSyncBlockedReason(selectedRegion) : '';

  $: if (open && !hadOpenState) {
    hadOpenState = true;
    tick().then(() => modalEl?.focus());
  } else if (!open && hadOpenState) {
    hadOpenState = false;
  }
  $: void hadOpenState;
</script>

{#if open}
  <div class="data-region-modal-backdrop">
    <button
      type="button"
      class="data-region-modal-dismiss-layer"
      tabindex="-1"
      aria-label={$t('common.close')}
      disabled={closeDisabled}
      on:click={closeModal}
    ></button>

    <div
      class="data-region-modal"
      bind:this={modalEl}
      role="dialog"
      aria-modal="true"
      aria-label={modalAriaLabel}
      tabindex="-1"
      on:keydown={onModalKeydown}
    >
      <div class="data-region-modal-header">
        <div class="min-w-0 space-y-1">
          <h2 class="truncate text-lg font-bold ui-text-strong">{modalTitle}</h2>
          {#if modalMetaLine}
            <p class="text-xs ui-text-subtle">{modalMetaLine}</p>
          {/if}
          {#if dataStatus}
            <p class="text-sm ui-text-muted">{dataStatus}</p>
          {/if}
        </div>

        <UiButton
          type="button"
          variant="secondary"
          size="close"
          className="shrink-0"
          aria-label={$t('common.close')}
          disabled={closeDisabled}
          onclick={closeModal}
        >
          <CloseIcon class="ui-close-icon" />
        </UiButton>
      </div>

      <div class="data-region-modal-body">
        <section class="data-region-status-card min-w-0 text-sm ui-text-body">
          <div class="data-region-status-head">
            <div class="min-w-0 space-y-1">
              <div class="flex min-w-0 items-center gap-2">
                <h4 class="text-sm font-semibold ui-text-strong">{$t('admin.data.form.currentStatus')}</h4>
                <span
                  class="badge-pill data-status-pill rounded-full px-2.5 py-0.5 text-xs font-semibold"
                  data-tone={selectedStatusMeta.tone}>{selectedStatusMeta.text}</span
                >
              </div>
              {#if syncBlockedReason}
                <p class="text-xs ui-text-subtle break-words">{syncBlockedReason}</p>
              {/if}
            </div>
          </div>

          <div class="data-region-status-divider"></div>

          <dl class="data-region-status-grid">
            <div class="data-region-status-item">
              <dt class="data-region-status-label">{$t('admin.data.form.lastSync')}</dt>
              <dd class="data-region-status-value">{formatUiDate(selectedRegion?.lastSuccessfulSyncAt) || '---'}</dd>
            </div>
            <div class="data-region-status-item">
              <dt class="data-region-status-label">{$t('admin.data.form.updateStatus')}</dt>
              <dd class="data-region-status-value">{selectedUpdateMeta.text}</dd>
            </div>
            <div class="data-region-status-item">
              <dt class="data-region-status-label">{$t('admin.data.form.sourceDataUpdatedAt')}</dt>
              <dd class="data-region-status-value">{formatUiDate(selectedRegion?.sourceDataUpdatedAt) || '---'}</dd>
            </div>
            <div class="data-region-status-item">
              <dt class="data-region-status-label">{$t('admin.data.form.upstreamLatest')}</dt>
              <dd class="data-region-status-value">{formatUiDate(selectedRegion?.latestSourceDataUpdatedAt) || '---'}</dd>
            </div>
            <div class="data-region-status-item">
              <dt class="data-region-status-label">{$t('admin.data.form.nextSync')}</dt>
              <dd class="data-region-status-value">{formatUiDate(selectedRegion?.nextSyncAt) || '---'}</dd>
            </div>
            <div class="data-region-status-item">
              <dt class="data-region-status-label">{$t('admin.data.form.lastFinished')}</dt>
              <dd class="data-region-status-value">{formatUiDate(selectedRegion?.lastSyncFinishedAt) || '---'}</dd>
            </div>
            <div class="data-region-status-item">
              <dt class="data-region-status-label">{$t('admin.data.form.pmtilesSize')}</dt>
              <dd class="data-region-status-value">{controller.formatStorageBytes(selectedRegion?.pmtilesBytes)}</dd>
            </div>
            <div class="data-region-status-item">
              <dt class="data-region-status-label">{$t('admin.data.form.dbSize')}</dt>
              <dd class="data-region-status-value">
                {selectedRegion?.dbBytesApproximate ? '~' : ''}{controller.formatStorageBytes(selectedRegion?.dbBytes)}
              </dd>
            </div>
            <div class="data-region-status-item data-region-status-item--wide">
              <dt class="data-region-status-label">{$t('admin.data.form.bounds')}</dt>
              <dd class="data-region-status-value break-words">{formatBounds(selectedRegion?.bounds)}</dd>
            </div>
          </dl>

          {#if selectedRegion?.lastSyncError}
            <p class="data-region-status-error mt-3 text-xs ui-text-danger break-words">{selectedRegion.lastSyncError}</p>
          {/if}
          {#if selectedRegion?.upstreamError}
            <p class="data-region-status-error mt-2 text-xs ui-text-danger break-words">{selectedRegion.upstreamError}</p>
          {/if}
        </section>

        <div class="data-region-form-pane">
          <AdminDataForm
            {controller}
            formId={REGION_FORM_ID}
            regionDraft={regionDraft}
            regionExtractCandidates={regionExtractCandidates}
            regionSaving={regionSaving}
            regionDeleting={regionDeleting}
            regionResolveBusy={regionResolveBusy}
            {selectedRegion}
            regionSyncBusy={regionSyncBusy}
          />
        </div>

        <AdminDataHistorySection
          {controller}
          {selectedDataRegionId}
          {regionRuns}
          {regionRunsLoading}
          {regionRunsStatus}
          {regionRunsPage}
          {regionRunsPageCount}
          {regionRunsTotal}
        />
      </div>
    </div>
  </div>
{/if}

<style>
  .data-region-modal-backdrop {
    --data-region-modal-gap: 0.85rem;
    --data-region-modal-top-gap: calc(var(--data-region-modal-gap) + env(safe-area-inset-top, 0px));
    --data-region-modal-bottom-gap: calc(var(--data-region-modal-gap) + env(safe-area-inset-bottom, 0px));
    position: fixed;
    inset: 0;
    z-index: 1310;
    display: grid;
    place-items: center;
    padding: var(--data-region-modal-top-gap) var(--data-region-modal-gap) var(--data-region-modal-bottom-gap);
    background: rgba(8, 17, 31, 0.66);
    overscroll-behavior: contain;
  }

  .data-region-modal-dismiss-layer {
    position: absolute;
    inset: 0;
    border: 0;
    padding: 0;
    background: transparent;
  }

  .data-region-modal {
    position: relative;
    z-index: 1;
    width: min(74rem, calc(100vw - (var(--data-region-modal-gap) * 2)));
    height: min(56rem, calc(100vh - var(--data-region-modal-top-gap) - var(--data-region-modal-bottom-gap)));
    height: min(56rem, calc(100dvh - var(--data-region-modal-top-gap) - var(--data-region-modal-bottom-gap)));
    max-height: calc(100vh - var(--data-region-modal-top-gap) - var(--data-region-modal-bottom-gap));
    max-height: calc(100dvh - var(--data-region-modal-top-gap) - var(--data-region-modal-bottom-gap));
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

  .data-region-modal-header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 0.75rem;
    min-width: 0;
  }

  .data-region-modal-body {
    --data-region-history-height: clamp(11rem, 24vh, 15rem);
    min-height: 0;
    display: grid;
    grid-template-rows: auto minmax(0, 1fr) var(--data-region-history-height);
    gap: 0.9rem;
    padding: 0.8rem;
    overflow: hidden;
    border: 1px solid var(--panel-border);
    border-radius: 1.15rem;
    background: var(--panel-solid);
  }

  .data-region-form-pane {
    min-height: 0;
    overflow: auto;
    padding-right: 0.1rem;
  }

  .data-region-status-card {
    border: 1px solid var(--panel-border);
    border-radius: 0.95rem;
    background: var(--panel-solid);
    box-shadow: var(--shadow-soft);
    padding: 0.85rem 1rem;
  }

  .data-region-status-head {
    display: flex;
    align-items: flex-start;
    gap: 0.75rem;
  }

  .data-region-status-divider {
    margin: 0.75rem 0;
    height: 1px;
    background: var(--panel-border);
  }

  .data-region-status-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 0.55rem;
  }

  .data-region-status-item {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
    padding: 0.5rem 0.65rem;
    border: 1px solid var(--panel-border);
    border-radius: 0.75rem;
    background: color-mix(in srgb, var(--panel-solid), var(--panel-solid) 0%);
  }

  .data-region-status-item--wide {
    grid-column: 1 / -1;
  }

  .data-region-status-label {
    font-size: 0.68rem;
    font-weight: 600;
    line-height: 1.25;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--ui-text-muted);
  }

  .data-region-status-value {
    min-width: 0;
    font-size: 0.82rem;
    line-height: 1.35;
    color: var(--ui-text-strong);
  }

  .data-region-status-error {
    padding: 0.55rem 0.7rem;
    border: 1px solid rgba(185, 28, 28, 0.18);
    border-radius: 0.9rem;
    background: rgba(254, 242, 242, 0.88);
  }

  .data-region-status-card .data-status-pill {
    border: 1px solid transparent;
  }

  @media (min-width: 960px) {
    .data-region-status-grid {
      grid-template-columns: repeat(4, minmax(0, 1fr));
    }
  }

  @media (max-width: 767px) {
    .data-region-modal-backdrop {
      --data-region-modal-gap: 0.65rem;
    }

    .data-region-modal {
      width: 100%;
      height: calc(100vh - var(--data-region-modal-top-gap) - var(--data-region-modal-bottom-gap));
      height: calc(100dvh - var(--data-region-modal-top-gap) - var(--data-region-modal-bottom-gap));
      max-height: calc(100vh - var(--data-region-modal-top-gap) - var(--data-region-modal-bottom-gap));
      max-height: calc(100dvh - var(--data-region-modal-top-gap) - var(--data-region-modal-bottom-gap));
      padding: 0.75rem;
      border-radius: 1.2rem;
    }

    .data-region-modal-body {
      --data-region-history-height: clamp(10rem, 28dvh, 13rem);
      gap: 0.75rem;
      padding: 0.75rem;
    }

    .data-region-status-grid {
      grid-template-columns: minmax(0, 1fr);
    }
  }
</style>
