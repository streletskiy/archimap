<script>
  import { onMount } from 'svelte';

  import { t } from '$lib/i18n/index';
  import { formatUiDate } from '$lib/utils/edit-ui';

  export let controller;
  export let isMasterAdmin = false;

  const dataSettings = controller.dataSettings;
  const dataLoading = controller.dataLoading;
  const dataStatus = controller.dataStatus;
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

  let selectedRegion = null;

  function updateRegionDraftField(field, value) {
    controller.patchRegionDraft({ [field]: value });
  }

  function formatBounds(bounds) {
    if (!bounds) return $t('admin.data.form.boundsUnknown');
    return `${bounds.west.toFixed(4)}, ${bounds.south.toFixed(4)} .. ${bounds.east.toFixed(4)}, ${bounds.north.toFixed(4)}`;
  }

  $: selectedRegion = $regionDraft.id
    ? $dataSettings.regions.find((item) => Number(item?.id || 0) === Number($regionDraft.id)) || null
    : null;

  onMount(() => {
    if (!isMasterAdmin) return;
    void controller.ensureLoaded({ preserveSelection: true });
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
        <p><strong>{$t('admin.data.summary.regionsCountLabel')}:</strong> {$dataSettings.regions.length}</p>
        <p><strong>{$t('admin.data.summary.regionSourceLabel')}:</strong> {$t('admin.data.summary.regionSourceValue')}</p>
      </article>
    </div>

    {#if $dataStatus}
      <p class="text-sm ui-text-muted">{$dataStatus}</p>
    {/if}

    <div class="grid gap-4 xl:grid-cols-[minmax(0,0.95fr)_minmax(0,1.05fr)]">
      <section class="space-y-3 min-w-0">
        <div class="flex items-center justify-between gap-2">
          <h4 class="text-sm font-semibold uppercase tracking-wide ui-text-muted">{$t('admin.data.list.title')}</h4>
          <span class="text-xs ui-text-subtle">{$dataSettings.regions.length}</span>
        </div>

        {#if $dataLoading}
          <p class="data-summary-card rounded-xl px-3 py-2 text-sm ui-text-subtle">{$t('admin.data.list.loading')}</p>
        {:else if $dataSettings.regions.length === 0}
          <p class="rounded-xl border border-dashed ui-border-strong px-3 py-4 text-sm ui-text-subtle">
            {$t('admin.data.list.empty')}
          </p>
        {:else}
          <div class="space-y-2">
            {#each $dataSettings.regions as region (`data-region-${region.id}`)}
              {@const statusMeta = controller.getRegionStatusMeta(region.lastSyncStatus)}
              <button
                type="button"
                class="data-region-card w-full rounded-xl px-3 py-3 text-left transition"
                data-selected={$selectedDataRegionId === region.id ? 'true' : 'false'}
                on:click={() => controller.selectDataRegion(region)}
              >
                <div class="flex flex-wrap items-start justify-between gap-2">
                  <div class="min-w-0 flex-1">
                    <p class="font-semibold ui-text-strong break-words">{region.name}</p>
                    <p class="text-xs ui-text-subtle break-words">#{region.id} · {region.slug}</p>
                  </div>
                  <span
                    class="badge-pill data-status-pill shrink-0 rounded-full px-2.5 py-1 text-xs font-semibold"
                    data-tone={statusMeta.tone}>{statusMeta.text}</span
                  >
                </div>
                <p class="mt-2 text-sm ui-text-body break-all">{controller.getRegionExtractPrimaryText(region)}</p>
                {#if controller.getRegionExtractSecondaryText(region)}
                  <p class="mt-1 text-xs ui-text-subtle break-all">{controller.getRegionExtractSecondaryText(region)}</p>
                {/if}
                <div class="mt-2 grid gap-1 text-xs ui-text-subtle sm:grid-cols-2">
                  <p>{$t('admin.data.list.lastSync')}: {formatUiDate(region.lastSuccessfulSyncAt) || '---'}</p>
                  <p>{$t('admin.data.list.nextSync')}: {formatUiDate(region.nextSyncAt) || '---'}</p>
                  <p>{$t('admin.data.list.pmtilesSize')}: {controller.formatStorageBytes(region.pmtilesBytes)}</p>
                  <p>
                    {$t('admin.data.list.dbSize')}:
                    {region.dbBytesApproximate ? '~' : ''}{controller.formatStorageBytes(region.dbBytes)}
                  </p>
                </div>
                <div class="mt-2 flex flex-wrap gap-2 text-xs">
                  <span class="rounded-full ui-surface-soft px-2 py-1 ui-text-muted"
                    >{controller.getRegionEnabledLabel(region.enabled)}</span
                  >
                  <span class="rounded-full ui-surface-soft px-2 py-1 ui-text-muted"
                    >{controller.getRegionSyncModeLabel(region)}</span
                  >
                </div>
                {#if region.lastSyncError}
                  <p class="mt-2 text-xs ui-text-danger break-words">{region.lastSyncError}</p>
                {/if}
              </button>
            {/each}
          </div>
        {/if}
      </section>

      <section class="space-y-4 min-w-0">
        <form class="data-form-card space-y-3 rounded-2xl p-4" on:submit={controller.saveDataRegion}>
          <div class="flex flex-wrap items-start justify-between gap-2">
            <div>
              <h4 class="text-base font-bold ui-text-strong">
                {$regionDraft.id ? $t('admin.data.form.editTitle') : $t('admin.data.form.newTitle')}
              </h4>
              <p class="text-sm ui-text-muted">{$t('admin.data.form.description')}</p>
            </div>
            {#if $regionDraft.id}
              <button
                type="button"
                class="ui-btn ui-btn-secondary ui-btn-xs"
                on:click={controller.startNewRegionDraft}
                disabled={$regionSaving || $regionDeleting || $regionSyncBusy}>{$t('admin.data.form.resetSelection')}</button
              >
            {/if}
          </div>

          <div class="grid gap-3 md:grid-cols-2">
            {#if $regionDraft.id}
              <label class="space-y-1 text-sm ui-text-body">
                <span>{$t('admin.data.form.regionId')}</span>
                <input class="ui-field" value={$regionDraft.id} readonly disabled />
              </label>
            {/if}
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

            <div class="space-y-2 text-sm ui-text-body md:col-span-2">
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

              <div class="rounded-xl border ui-border ui-surface-base px-3 py-3">
                <p class="text-xs font-semibold uppercase tracking-wide ui-text-muted">{$t('admin.data.form.selectedExtract')}</p>
                {#if $regionDraft.extractId && $regionDraft.extractSource}
                  <p class="mt-2 text-sm font-medium ui-text-strong break-words">{$regionDraft.extractLabel || $regionDraft.extractId}</p>
                  <p class="mt-1 text-xs ui-text-subtle break-all">{$regionDraft.extractSource} · {$regionDraft.extractId}</p>
                {:else}
                  <p class="mt-2 text-sm ui-text-subtle">{$t('admin.data.form.selectedExtractEmpty')}</p>
                {/if}
              </div>
            </div>

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

          <div class="grid gap-2 md:grid-cols-2">
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

          {#if $regionDraft.id}
            {@const selectedStatusMeta = controller.getRegionStatusMeta(selectedRegion?.lastSyncStatus)}
            <div class="rounded-xl border ui-border ui-surface-base px-3 py-3 text-sm ui-text-body">
              <div class="flex flex-wrap items-center gap-2">
                <span class="font-semibold ui-text-strong">{$t('admin.data.form.currentStatus')}</span>
                <span
                  class="badge-pill data-status-pill rounded-full px-2.5 py-1 text-xs font-semibold"
                  data-tone={selectedStatusMeta.tone}>{selectedStatusMeta.text}</span
                >
              </div>
              <div class="mt-2 grid gap-1 text-xs ui-text-subtle sm:grid-cols-2">
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
              disabled={$regionSaving || $regionDeleting || !$regionDraft.extractId || !$regionDraft.extractSource}
              >{$regionDraft.id ? $t('admin.data.form.saveRegion') : $t('admin.data.form.createRegion')}</button
            >
            <button
              type="button"
              class="ui-btn ui-btn-secondary"
              disabled={!$regionDraft.id || $regionSaving || $regionDeleting || $regionSyncBusy}
              on:click={() => controller.syncRegionNow($regionDraft.id)}>{$t('admin.data.form.syncNow')}</button
            >
            <button
              type="button"
              class="ui-btn ui-btn-danger"
              disabled={!$regionDraft.id || $regionSaving || $regionDeleting || $regionSyncBusy}
              on:click={() => controller.deleteDataRegion($regionDraft.id)}
              >{$regionDeleting ? $t('admin.data.form.deleting') : $t('admin.data.form.deleteRegion')}</button
            >
          </div>
        </form>

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
                    {@const runStatusMeta = controller.getRegionStatusMeta(run.status)}
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
    </div>
  </section>
{/if}

<style>
  @import './admin-tabs.css';
</style>
