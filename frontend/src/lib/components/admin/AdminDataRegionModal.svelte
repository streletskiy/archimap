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
          <p class="text-[11px] font-semibold uppercase tracking-wide ui-text-muted">{$t('admin.data.title')}</p>
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
        <section class="data-region-status-card rounded-2xl p-3 min-w-0 text-sm ui-text-body">
          <div class="flex flex-wrap items-start justify-between gap-3">
            <div class="min-w-0 space-y-0.5">
              <h4 class="text-sm font-semibold ui-text-strong">{$t('admin.data.form.currentStatus')}</h4>
            </div>

            <span
              class="badge-pill data-status-pill rounded-full px-2.5 py-1 text-xs font-semibold"
              data-tone={selectedStatusMeta.tone}>{selectedStatusMeta.text}</span
            >
          </div>
          <div class="mt-3 grid gap-1 text-xs ui-text-subtle">
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
          <div class="mt-3 flex flex-wrap items-center justify-end gap-2">
            <UiButton
              type="submit"
              form={REGION_FORM_ID}
              disabled={regionSaving
                || regionDeleting
                || !String($regionDraft.extractId || '').trim()
                || !String($regionDraft.extractSource || '').trim()
                || !String($regionDraft.name || '').trim()
                || !String($regionDraft.slug || '').trim()}
            >
              {$regionDraft.id ? $t('admin.data.form.saveRegion') : $t('admin.data.form.createRegion')}
            </UiButton>
            {#if $regionDraft.id}
              <UiButton
                type="button"
                variant="secondary"
                disabled={regionSaving || regionDeleting || regionSyncBusy}
                onclick={() => controller.syncRegionNow($regionDraft.id)}
              >
                {$t('admin.data.form.syncNow')}
              </UiButton>
              <UiButton
                type="button"
                variant="danger"
                disabled={regionSaving || regionDeleting || regionSyncBusy}
                onclick={() => controller.deleteDataRegion($regionDraft.id)}
              >
                {regionDeleting ? $t('admin.data.form.deleting') : $t('admin.data.form.deleteRegion')}
              </UiButton>
            {/if}
          </div>
        </section>

        <AdminDataForm
          {controller}
          formId={REGION_FORM_ID}
          regionDraft={regionDraft}
          regionExtractCandidates={regionExtractCandidates}
          regionSaving={regionSaving}
          regionDeleting={regionDeleting}
          regionResolveBusy={regionResolveBusy}
        />

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
    min-height: 0;
    display: grid;
    grid-template-rows: auto auto minmax(0, 1fr);
    gap: 0.9rem;
    padding: 0.8rem;
    overflow: hidden;
    border: 1px solid var(--panel-border);
    border-radius: 1.15rem;
    background: var(--panel-solid);
  }

  .data-region-status-card {
    border: 1px solid var(--panel-border);
    background: var(--panel-solid);
    box-shadow: var(--shadow-soft);
  }

  .data-region-status-card .data-status-pill {
    border: 1px solid transparent;
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
      gap: 0.75rem;
      padding: 0.75rem;
    }
  }
</style>
