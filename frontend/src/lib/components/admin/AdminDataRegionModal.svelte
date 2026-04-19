<script>
  import { onDestroy, onMount, tick } from 'svelte';

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
  export let regionSaving = false;
  export let regionDeleting = false;
  export let regionSyncBusy = false;
  export let regionSyncCancelBusy = false;
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
  const DESKTOP_REGION_RUNS_LIMIT = 20;
  const MOBILE_REGION_RUNS_LIMIT = 1000;
  const MOBILE_HISTORY_MEDIA_QUERY = '(max-width: 767px)';
  const SYNC_PIPELINE_STAGES = ['download', 'extract', 'export', 'build', 'apply', 'publish', 'followup'];
  const SYNC_PIPELINE_STORAGE_PREFIX = 'archimap-admin-region-pipeline-v1:';

  let modalEl = null;
  let hadOpenState = false;
  let seenStages;
  let scrollLockState = null;
  let historyUsesExpandedMobileList = false;
  let historyViewportMediaQuery = null;
  let lastAppliedRegionRunsLimit = DESKTOP_REGION_RUNS_LIMIT;

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

  function findActiveRun(runs) {
    if (!Array.isArray(runs) || runs.length === 0) return null;
    return runs.find((run) => {
      const status = String(run?.status || '').trim().toLowerCase();
      return status === 'queued' || status === 'running';
    }) || null;
  }

  function formatStageLabel(stage) {
    const code = String(stage || '').trim().toLowerCase();
    if (!code) return '';
    const key = `admin.data.stage.${code}`;
    const translated = $t(key);
    return translated && translated !== key ? translated : code;
  }

  $: modalTitle = getRegionTitle($regionDraft, selectedRegion);
  $: modalMetaLine = getRegionMetaLine($regionDraft, selectedRegion);
  $: modalAriaLabel = modalTitle;
  $: selectedStatusMeta = controller.getRegionStatusMeta(selectedRegion?.lastSyncStatus, selectedRegion);
  $: selectedUpdateMeta = controller.getRegionUpdateMeta(selectedRegion);
  $: syncBlockedReason = $regionDraft.id ? controller.getRegionSyncBlockedReason(selectedRegion) : '';

  function getPipelineStorage() {
    if (typeof window === 'undefined' || !window.sessionStorage) return null;
    return window.sessionStorage;
  }

  function getRunId(run) {
    const runId = Number(run?.id || run?.runId || 0);
    return Number.isInteger(runId) && runId > 0 ? runId : null;
  }

  function getRunStorageKey(runId) {
    return runId ? `${SYNC_PIPELINE_STORAGE_PREFIX}${runId}` : '';
  }

  function normalizePipelineStage(stage) {
    const code = String(stage || '').trim().toLowerCase();
    if (!code) return '';
    if (code === 'tile_join') return 'build';
    if (SYNC_PIPELINE_STAGES.includes(code)) return code;
    return '';
  }

  function inferSeenStages(currentStage) {
    const effectiveStage = normalizePipelineStage(currentStage);
    const stageIndex = SYNC_PIPELINE_STAGES.indexOf(effectiveStage);
    if (stageIndex <= 0) return new Set();
    return new Set(SYNC_PIPELINE_STAGES.slice(0, stageIndex));
  }

  function readPersistedSeenStages(runId) {
    const storage = getPipelineStorage();
    const storageKey = getRunStorageKey(runId);
    if (!storage || !storageKey) return new Set();

    try {
      const raw = storage.getItem(storageKey);
      if (!raw) return new Set();
      const parsed = JSON.parse(raw);
      const stages = Array.isArray(parsed?.stages) ? parsed.stages : [];
      return new Set(
        stages
          .map((stage) => normalizePipelineStage(stage))
          .filter(Boolean)
      );
    } catch {
      return new Set();
    }
  }

  function persistSeenStages(runId, stages) {
    const storage = getPipelineStorage();
    const storageKey = getRunStorageKey(runId);
    if (!storage || !storageKey) return;

    try {
      const serializedStages = [...stages].filter((stage) => SYNC_PIPELINE_STAGES.includes(stage));
      if (serializedStages.length === 0) {
        storage.removeItem(storageKey);
        return;
      }
      storage.setItem(storageKey, JSON.stringify({
        stages: serializedStages,
        updatedAt: Date.now()
      }));
    } catch {
      // Ignore storage quota/privacy failures and keep the progress state in memory only.
    }
  }

  function lockBackgroundScroll() {
    if (typeof window === 'undefined' || typeof document === 'undefined' || scrollLockState) return;

    const html = document.documentElement;
    const body = document.body;
    if (!html || !body) return;

    const scrollY = window.scrollY || window.pageYOffset || 0;
    scrollLockState = {
      scrollY,
      htmlOverflow: html.style.overflow,
      bodyOverflow: body.style.overflow,
      bodyPosition: body.style.position,
      bodyTop: body.style.top,
      bodyLeft: body.style.left,
      bodyRight: body.style.right,
      bodyWidth: body.style.width
    };

    html.style.overflow = 'hidden';
    body.style.overflow = 'hidden';
    body.style.position = 'fixed';
    body.style.top = `-${scrollY}px`;
    body.style.left = '0';
    body.style.right = '0';
    body.style.width = '100%';
  }

  function unlockBackgroundScroll() {
    if (typeof window === 'undefined' || typeof document === 'undefined' || !scrollLockState) return;

    const html = document.documentElement;
    const body = document.body;
    const {
      scrollY,
      htmlOverflow,
      bodyOverflow,
      bodyPosition,
      bodyTop,
      bodyLeft,
      bodyRight,
      bodyWidth
    } = scrollLockState;

    html.style.overflow = htmlOverflow;
    body.style.overflow = bodyOverflow;
    body.style.position = bodyPosition;
    body.style.top = bodyTop;
    body.style.left = bodyLeft;
    body.style.right = bodyRight;
    body.style.width = bodyWidth;
    scrollLockState = null;
    window.scrollTo(0, scrollY);
  }

  function getPreferredRegionRunsLimit() {
    return open && historyUsesExpandedMobileList
      ? MOBILE_REGION_RUNS_LIMIT
      : DESKTOP_REGION_RUNS_LIMIT;
  }

  function syncHistoryViewportMode() {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      historyUsesExpandedMobileList = false;
      return;
    }
    historyUsesExpandedMobileList = Boolean(window.matchMedia(MOBILE_HISTORY_MEDIA_QUERY).matches);
  }

  function handleHistoryViewportChange(event) {
    historyUsesExpandedMobileList = Boolean(event?.matches);
  }

  function applyRegionRunsLimit(nextRegionRunsLimit) {
    lastAppliedRegionRunsLimit = nextRegionRunsLimit;
    controller?.setRegionRunsLimit?.(nextRegionRunsLimit);

    const numericSelectedRegionId = Number(selectedDataRegionId || 0);
    if (open && Number.isInteger(numericSelectedRegionId) && numericSelectedRegionId > 0) {
      void controller?.loadRegionRuns?.(numericSelectedRegionId, 1, { limit: nextRegionRunsLimit });
    }
  }

  function computePipelineState(run, trackedStages = new Set()) {
    if (!run) return { steps: [], overallProgress: 0 };

    const currentStage = String(run.stage || '').trim().toLowerCase();
    const stageProgress = Number.isFinite(Number(run.stageProgress))
      ? Math.max(0, Math.min(100, Math.round(Number(run.stageProgress))))
      : null;
    const effectiveStage = normalizePipelineStage(currentStage);

    const steps = SYNC_PIPELINE_STAGES.map((stage) => {
      let state = 'pending';
      if (currentStage === 'done') {
        state = 'done';
      } else if (stage === effectiveStage) {
        state = 'active';
      } else if (trackedStages.has(stage) && stage !== effectiveStage) {
        state = 'done';
      }
      return { stage, state, label: formatStageLabel(stage) };
    });

    const doneCount = steps.filter(s => s.state === 'done').length;
    const totalStages = SYNC_PIPELINE_STAGES.length;
    const overallProgress = currentStage === 'done'
      ? 100
      : Math.round((
        (doneCount / totalStages)
        + ((stageProgress != null ? stageProgress / 100 : 0.5) / totalStages)
      ) * 100);

    return { steps, overallProgress };
  }

  function resolveSeenStages(run) {
    const runId = getRunId(run);
    if (!runId || !run) return new Set();

    const currentStage = String(run.stage || '').trim().toLowerCase();
    const effectiveStage = normalizePipelineStage(currentStage);
    let nextSeenStages = readPersistedSeenStages(runId);

    if (currentStage === 'done') {
      nextSeenStages = new Set(SYNC_PIPELINE_STAGES);
    } else if (effectiveStage) {
      if (nextSeenStages.size === 0) {
        nextSeenStages = new Set(inferSeenStages(effectiveStage));
      }
      nextSeenStages.add(effectiveStage);
    }

    persistSeenStages(runId, nextSeenStages);
    return nextSeenStages;
  }

  $: activeRun = findActiveRun(regionRuns);
  $: activeStageLabel = activeRun ? formatStageLabel(activeRun.stage) : '';
  $: activeStageProgress = activeRun && Number.isFinite(Number(activeRun.stageProgress))
    ? Math.max(0, Math.min(100, Math.round(Number(activeRun.stageProgress))))
    : null;
  $: activeStageDetail = activeRun?.stageDetail ? String(activeRun.stageDetail) : '';
  $: seenStages = activeRun ? resolveSeenStages(activeRun) : new Set();
  $: pipeline = computePipelineState(activeRun, seenStages || new Set());
  $: syncIsActive = Boolean(selectedRegion) && ['queued', 'running'].includes(
    String(selectedRegion?.lastSyncStatus || '').trim().toLowerCase()
  );
  $: visibleSyncError = !syncIsActive && selectedRegion?.lastSyncError
    ? String(selectedRegion.lastSyncError)
    : '';
  $: cancelRequested = Boolean(activeRun?.cancelRequested) || String(activeRun?.stage || '').toLowerCase() === 'cancelling';
  $: showRegionRunsPagination = !historyUsesExpandedMobileList;

  $: if (open && !hadOpenState) {
    hadOpenState = true;
    tick().then(() => modalEl?.focus());
  } else if (!open && hadOpenState) {
    hadOpenState = false;
  }
  $: if (open) {
    lockBackgroundScroll();
  } else {
    unlockBackgroundScroll();
  }
  $: {
    const nextRegionRunsLimit = getPreferredRegionRunsLimit();
    if (nextRegionRunsLimit !== lastAppliedRegionRunsLimit) {
      applyRegionRunsLimit(nextRegionRunsLimit);
    }
  }
  $: void hadOpenState;

  onMount(() => {
    syncHistoryViewportMode();
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return undefined;

    historyViewportMediaQuery = window.matchMedia(MOBILE_HISTORY_MEDIA_QUERY);
    historyUsesExpandedMobileList = Boolean(historyViewportMediaQuery.matches);
    if (typeof historyViewportMediaQuery.addEventListener === 'function') {
      historyViewportMediaQuery.addEventListener('change', handleHistoryViewportChange);
    } else {
      historyViewportMediaQuery.addListener?.(handleHistoryViewportChange);
    }

    return () => {
      if (typeof historyViewportMediaQuery?.removeEventListener === 'function') {
        historyViewportMediaQuery.removeEventListener('change', handleHistoryViewportChange);
      } else {
        historyViewportMediaQuery?.removeListener?.(handleHistoryViewportChange);
      }
      historyViewportMediaQuery = null;
    };
  });

  onDestroy(() => {
    unlockBackgroundScroll();
  });
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

          {#if syncIsActive}
            <div class="data-region-stage-panel" role="status" aria-live="polite">
              <div class="data-region-stage-head">
                <span class="data-region-stage-spinner" aria-hidden="true"></span>
                <div class="min-w-0 flex-1">
                  <div class="data-region-stage-title">
                    {$t('admin.data.form.syncStageTitle')}:
                    <span class="data-region-stage-name">{activeStageLabel || $t('admin.data.form.syncStageWorking')}</span>
                    <span class="data-region-stage-percent">{pipeline.overallProgress}%</span>
                  </div>
                  {#if activeStageDetail}
                    <div class="data-region-stage-detail">{activeStageDetail}</div>
                  {/if}
                </div>
              </div>

              <div class="data-region-pipeline-steps">
                {#each pipeline.steps as step}
                  <div
                    class="data-region-pipeline-step"
                    data-state={step.state}
                    title={step.label}
                  >
                    <div class="data-region-pipeline-dot"></div>
                    <span class="data-region-pipeline-label">{step.label}</span>
                  </div>
                {/each}
              </div>

              <div
                class="data-region-stage-progress"
                role="progressbar"
                aria-label={$t('admin.data.form.syncStageProgressLabel')}
                aria-valuemin="0"
                aria-valuemax="100"
                aria-valuenow={pipeline.overallProgress}
              >
                <div class="data-region-stage-progress-bar" style="width: {pipeline.overallProgress}%"></div>
              </div>
            </div>
          {/if}

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
            <div class="data-region-status-item data-region-status-item--wide data-region-status-item--bounds">
              <div class="data-region-status-item-main">
                <dt class="data-region-status-label">{$t('admin.data.form.bounds')}</dt>
                <dd class="data-region-status-value break-words">{formatBounds(selectedRegion?.bounds)}</dd>
              </div>
              <div class="data-region-status-actions">
                <UiButton
                  type="submit"
                  form={REGION_FORM_ID}
                  size="xs"
                  className="data-region-status-action-button"
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
                  {#if syncIsActive}
                    <UiButton
                      type="button"
                      variant="danger"
                      size="xs"
                      className="data-region-status-action-button"
                      disabled={cancelRequested || regionSyncCancelBusy}
                      onclick={() => controller.cancelRegionSync($regionDraft.id)}
                    >
                      {cancelRequested || regionSyncCancelBusy
                        ? $t('admin.data.form.cancelling')
                        : $t('admin.data.form.cancelSync')}
                    </UiButton>
                  {:else}
                    <UiButton
                      type="button"
                      variant="secondary"
                      size="xs"
                      className="data-region-status-action-button"
                      disabled={regionSaving || regionDeleting || regionSyncBusy || !controller.canSyncRegionNow(selectedRegion)}
                      onclick={() => controller.syncRegionNow($regionDraft.id)}
                    >
                      {$t('admin.data.form.syncNow')}
                    </UiButton>
                  {/if}
                  <UiButton
                    type="button"
                    variant="danger"
                    size="xs"
                    className="data-region-status-action-button"
                    disabled={regionSaving || regionDeleting || regionSyncBusy || syncIsActive}
                    onclick={() => controller.deleteDataRegion($regionDraft.id)}
                  >
                    {regionDeleting ? $t('admin.data.form.deleting') : $t('admin.data.form.deleteRegion')}
                  </UiButton>
                {/if}
              </div>
            </div>
          </dl>

          {#if visibleSyncError}
            <p class="data-region-status-error mt-3 text-xs ui-text-danger break-words">{visibleSyncError}</p>
          {/if}
          {#if selectedRegion?.upstreamError}
            <p class="data-region-status-error mt-2 text-xs ui-text-danger break-words">{selectedRegion.upstreamError}</p>
          {/if}
        </section>

        <div class="data-region-editor-grid">
          <div class="data-region-form-pane">
            <AdminDataForm
              {controller}
              formId={REGION_FORM_ID}
              regionDraft={regionDraft}
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
            showPagination={showRegionRunsPagination}
          />
        </div>
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
    display: flex;
    flex-direction: column;
    gap: 0.9rem;
    padding: 0.8rem;
    overflow: auto;
    border: 1px solid var(--panel-border);
    border-radius: 1.15rem;
    background: var(--panel-solid);
  }

  .data-region-editor-grid {
    min-height: auto;
    display: flex;
    flex-direction: column;
    gap: 0.9rem;
  }

  .data-region-form-pane {
    min-height: auto;
    overflow: visible;
    padding-right: 0;
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

  .data-region-stage-panel {
    display: flex;
    flex-direction: column;
    gap: 0.55rem;
    margin-bottom: 0.75rem;
    padding: 0.65rem 0.8rem;
    border: 1px solid color-mix(in srgb, var(--accent, #2563eb) 40%, var(--panel-border));
    border-radius: 0.85rem;
    background: color-mix(in srgb, var(--accent, #2563eb) 6%, var(--panel-solid));
  }

  .data-region-stage-head {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    min-width: 0;
  }

  .data-region-stage-spinner {
    flex: 0 0 auto;
    width: 1rem;
    height: 1rem;
    border-radius: 50%;
    border: 2px solid color-mix(in srgb, var(--accent, #2563eb) 30%, transparent);
    border-top-color: var(--accent, #2563eb);
    animation: data-region-stage-spin 0.9s linear infinite;
  }

  @keyframes data-region-stage-spin {
    to { transform: rotate(360deg); }
  }

  .data-region-stage-title {
    display: flex;
    align-items: baseline;
    flex-wrap: wrap;
    gap: 0.35rem;
    font-size: 0.82rem;
    font-weight: 600;
    color: var(--ui-text-strong);
  }

  .data-region-stage-name {
    color: var(--accent, #2563eb);
  }

  .data-region-stage-percent {
    margin-left: auto;
    font-variant-numeric: tabular-nums;
    color: var(--ui-text-muted);
  }

  .data-region-stage-detail {
    font-size: 0.72rem;
    line-height: 1.3;
    color: var(--ui-text-muted);
    word-break: break-word;
  }

  .data-region-pipeline-steps {
    display: flex;
    justify-content: space-between;
    gap: 0.15rem;
    padding: 0 0.1rem;
  }

  .data-region-pipeline-step {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.25rem;
    flex: 1 1 0;
    min-width: 0;
  }

  .data-region-pipeline-dot {
    width: 0.5rem;
    height: 0.5rem;
    border-radius: 50%;
    background: color-mix(in srgb, var(--accent, #2563eb) 20%, transparent);
    border: 1.5px solid color-mix(in srgb, var(--accent, #2563eb) 30%, transparent);
    transition: all 0.3s ease;
    flex-shrink: 0;
  }

  .data-region-pipeline-step[data-state="done"] .data-region-pipeline-dot {
    background: var(--accent, #2563eb);
    border-color: var(--accent, #2563eb);
  }

  .data-region-pipeline-step[data-state="active"] .data-region-pipeline-dot {
    background: var(--accent, #2563eb);
    border-color: var(--accent, #2563eb);
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent, #2563eb) 25%, transparent);
    animation: data-region-pipeline-pulse 1.8s ease-in-out infinite;
  }

  @keyframes data-region-pipeline-pulse {
    0%, 100% { box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent, #2563eb) 25%, transparent); }
    50% { box-shadow: 0 0 0 4px color-mix(in srgb, var(--accent, #2563eb) 12%, transparent); }
  }

  .data-region-pipeline-label {
    font-size: 0.58rem;
    line-height: 1.15;
    text-align: center;
    color: var(--ui-text-muted);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 100%;
    transition: color 0.3s ease;
  }

  .data-region-pipeline-step[data-state="active"] .data-region-pipeline-label {
    color: var(--accent, #2563eb);
    font-weight: 600;
  }

  .data-region-pipeline-step[data-state="done"] .data-region-pipeline-label {
    color: var(--ui-text-subtle);
  }

  .data-region-stage-progress {
    position: relative;
    width: 100%;
    height: 0.45rem;
    border-radius: 999px;
    background: color-mix(in srgb, var(--accent, #2563eb) 14%, transparent);
    overflow: hidden;
  }

  .data-region-stage-progress-bar {
    height: 100%;
    border-radius: inherit;
    background: var(--accent, #2563eb);
    transition: width 0.3s ease;
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

  .data-region-status-item--bounds {
    flex-direction: row;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
  }

  .data-region-status-item-main {
    min-width: 0;
    display: flex;
    flex: 1 1 auto;
    flex-direction: column;
    gap: 0.15rem;
  }

  .data-region-status-actions {
    display: flex;
    flex: 0 0 auto;
    flex-wrap: wrap;
    align-items: center;
    justify-content: flex-end;
    gap: 0.35rem;
  }

  :global(.data-region-status-action-button) {
    white-space: nowrap;
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
    .data-region-modal-body {
      overflow: hidden;
    }

    .data-region-editor-grid {
      min-height: 0;
      flex: 1 1 auto;
      display: grid;
      grid-template-columns: minmax(0, 1.15fr) minmax(0, 0.95fr);
      align-items: stretch;
    }

    .data-region-form-pane {
      min-height: 0;
      overflow: auto;
      padding-right: 0.2rem;
    }

    .data-region-editor-grid :global(.data-history-card) {
      min-height: 0;
      height: 100%;
    }

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
      gap: 0.75rem;
      padding: 0.75rem;
      overflow: auto;
    }

    .data-region-editor-grid {
      gap: 0.75rem;
    }

    .data-region-status-grid {
      grid-template-columns: minmax(0, 1fr);
    }

    .data-region-form-pane {
      overflow: visible;
      padding-right: 0;
    }

    .data-region-status-item--bounds {
      align-items: flex-start;
      flex-direction: column;
    }

    .data-region-pipeline-label {
      display: none;
    }

    .data-region-pipeline-dot {
      width: 0.45rem;
      height: 0.45rem;
    }

    .data-region-status-actions {
      width: 100%;
      flex-direction: column;
      align-items: stretch;
      justify-content: flex-start;
      overflow: visible;
      padding-bottom: 0;
      gap: 0.45rem;
    }

    :global(.data-region-status-action-button) {
      width: 100%;
      justify-content: center;
    }
  }
</style>
