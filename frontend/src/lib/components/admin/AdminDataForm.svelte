<script>
  import { t } from '$lib/i18n/index';
  import { formatUiDate } from '$lib/utils/edit-ui';
  import { UiButton, UiCheckbox, UiInput, UiRadioGroup, UiRadioGroupItem } from '$lib/components/base';

  export let controller = null;
  export let regionDraft = null;
  export let regionExtractCandidates = [];
  export let selectedRegion = null;
  export let regionSaving = false;
  export let regionDeleting = false;
  export let regionSyncBusy = false;
  export let regionResolveBusy = false;

  function formatBounds(bounds) {
    if (!bounds) return $t('admin.data.form.boundsUnknown');
    return `${bounds.west.toFixed(4)}, ${bounds.south.toFixed(4)} .. ${bounds.east.toFixed(4)}, ${bounds.north.toFixed(4)}`;
  }

  function getExtractCandidateValue(candidate) {
    return `${String(candidate?.extractSource || '').trim()}::${String(candidate?.extractId || '').trim()}`;
  }

  function handleExtractCandidateChange(event) {
    const nextValue = String(event.detail?.value || '').trim();
    if (!nextValue) return;
    const candidate = $regionExtractCandidates.find((item) => getExtractCandidateValue(item) === nextValue);
    if (candidate) {
      controller.applyRegionExtractCandidate(candidate);
    }
  }

  $: draftHasValues = Boolean(
    $regionDraft.id
      || String($regionDraft.name || '').trim()
      || String($regionDraft.slug || '').trim()
      || String($regionDraft.extractId || '').trim()
      || String($regionDraft.searchQuery || '').trim()
  );

  $: selectedExtractCandidateValue = $regionDraft.extractSource && $regionDraft.extractId
    ? getExtractCandidateValue({
      extractSource: $regionDraft.extractSource,
      extractId: $regionDraft.extractId
    })
    : '';

  $: selectedStatusMeta = controller.getRegionStatusMeta(selectedRegion?.lastSyncStatus, selectedRegion);
</script>

<form class="data-form-card space-y-3 rounded-2xl p-3 min-w-0" on:submit={controller.saveDataRegion}>
  <div class="flex flex-wrap items-center justify-between gap-2">
    <div class="min-w-0 space-y-0.5">
      <h4 class="text-sm font-semibold ui-text-strong">
        {$regionDraft.id ? $t('admin.data.form.editTitle') : $t('admin.data.form.newTitle')}
      </h4>
      <p class="text-xs ui-text-muted">{$t('admin.data.form.description')}</p>
    </div>
    {#if draftHasValues}
      <UiButton
        type="button"
        variant="secondary"
        size="xs"
        onclick={controller.startNewRegionDraft}
        disabled={regionSaving || regionDeleting || regionSyncBusy}
      >
        {$t('admin.data.form.resetSelection')}
      </UiButton>
    {/if}
  </div>

  {#if !$regionDraft.id && !$regionDraft.extractId}
    <div class="rounded-xl border ui-border ui-surface-brand px-3 py-3 text-sm ui-text-body">
      {$t('admin.data.form.mapHint')}
    </div>
  {/if}

  <div class="grid gap-3 xl:grid-cols-[minmax(0,1.25fr)_minmax(0,0.75fr)]">
    <div class="space-y-3 min-w-0">
      <div class="flex flex-wrap items-center gap-3 min-w-0">
        <label class="flex min-w-[16rem] flex-[1.45] items-center gap-2 text-sm ui-text-body">
          <span class="shrink-0 text-[11px] font-semibold uppercase tracking-wide ui-text-muted">{$t('admin.data.form.regionName')}</span>
          <UiInput
            size="xs"
            className="min-w-0 flex-1"
            value={$regionDraft.name}
            on:input={(event) => controller.patchRegionDraft({ name: event.currentTarget.value })}
            placeholder={$t('admin.data.form.regionNamePlaceholder')}
          />
        </label>
        <label class="flex min-w-[14rem] flex-[1.1] items-center gap-2 text-sm ui-text-body">
          <span class="shrink-0 text-[11px] font-semibold uppercase tracking-wide ui-text-muted">{$t('admin.data.form.slug')}</span>
          <UiInput
            size="xs"
            className="min-w-0 flex-1"
            value={$regionDraft.slug}
            on:input={(event) => controller.patchRegionDraft({ slug: event.currentTarget.value })}
            placeholder={$t('admin.data.form.slugPlaceholder')}
          />
        </label>
        <div class="flex min-w-[8rem] items-center gap-2 rounded-xl border ui-border ui-surface-soft px-3 py-2">
          <span class="shrink-0 text-[11px] font-semibold uppercase tracking-wide ui-text-muted">{$t('common.id')}</span>
          <span class="truncate text-sm font-semibold ui-text-strong">{$regionDraft.id ? `#${$regionDraft.id}` : '---'}</span>
        </div>
      </div>

      <div class="rounded-xl border ui-border ui-surface-base px-3 py-2.5">
        <p class="text-xs font-semibold uppercase tracking-wide ui-text-muted">{$t('admin.data.form.selectedExtract')}</p>
        {#if $regionDraft.extractId && $regionDraft.extractSource}
          <p class="mt-2 text-sm font-medium ui-text-strong break-words line-clamp-3">
            {String($regionDraft.extractLabel || $regionDraft.name || $regionDraft.extractId || '').trim()}
          </p>
          <p class="mt-1 text-xs ui-text-subtle break-all line-clamp-2">{$regionDraft.extractSource} · {$regionDraft.extractId}</p>
        {:else}
          <p class="mt-2 text-sm ui-text-subtle">{$t('admin.data.form.selectedExtractEmpty')}</p>
        {/if}
      </div>

      <details class="rounded-xl border ui-border ui-surface-base px-3 py-2.5">
        <summary class="cursor-pointer text-sm font-semibold ui-text-strong">
          {$t('admin.data.form.advancedTitle')}
        </summary>

        <div class="mt-3 space-y-3">
          <div class="space-y-2 text-sm ui-text-body">
            <label class="space-y-1 block">
              <span>{$t('admin.data.form.searchQuery')}</span>
              <div class="flex flex-col gap-2 sm:flex-row">
                <UiInput
                  className="flex-1"
                  value={$regionDraft.searchQuery}
                  on:input={controller.handleRegionSearchQueryInput}
                  placeholder={$t('admin.data.form.searchQueryPlaceholder')}
                />
                <UiButton
                  type="button"
                  variant="secondary"
                  onclick={controller.resolveRegionExtractCandidates}
                  disabled={regionResolveBusy || regionSaving || regionDeleting}
                >
                  {regionResolveBusy ? $t('admin.data.form.resolvingExtract') : $t('admin.data.form.resolveExtract')}
                </UiButton>
              </div>
            </label>

            {#if $regionDraft.extractResolutionStatus !== 'resolved' && $regionDraft.extractResolutionError}
              <p class="text-xs ui-text-danger break-words">{$regionDraft.extractResolutionError}</p>
            {/if}
          </div>

          {#if $regionExtractCandidates.length > 0}
            <div class="space-y-2 rounded-xl border ui-border px-3 py-2.5">
              <p class="text-xs font-semibold uppercase tracking-wide ui-text-muted">{$t('admin.data.form.extractCandidates')}</p>
              <UiRadioGroup
                value={selectedExtractCandidateValue}
                onchange={handleExtractCandidateChange}
                className="space-y-2"
              >
                {#each $regionExtractCandidates as candidate (`extract-candidate-${candidate.extractSource}-${candidate.extractId}`)}
                  <label class="block cursor-pointer rounded-lg border ui-border px-3 py-2">
                    <div class="flex items-start gap-3">
                      <UiRadioGroupItem value={getExtractCandidateValue(candidate)} name="region-extract-candidate" />
                      <div class="min-w-0">
                        <p class="font-medium ui-text-strong break-words">{candidate.extractLabel}</p>
                        <p class="text-xs ui-text-subtle break-all">{candidate.extractSource} · {candidate.extractId}</p>
                      </div>
                    </div>
                  </label>
                {/each}
              </UiRadioGroup>
            </div>
          {/if}

          <div class="grid gap-3 md:grid-cols-2">
            <label class="space-y-1 text-sm ui-text-body">
              <span>{$t('admin.data.form.sourceLayer')}</span>
              <UiInput
                value={$regionDraft.sourceLayer}
                on:input={(event) => controller.patchRegionDraft({ sourceLayer: event.currentTarget.value })}
                placeholder={$t('admin.data.form.sourceLayerPlaceholder')}
              />
            </label>
            <label class="space-y-1 text-sm ui-text-body">
              <span>{$t('admin.data.form.autoSyncIntervalHours')}</span>
              <UiInput
                type="number"
                min="0"
                max="8760"
                value={$regionDraft.autoSyncIntervalHours}
                on:input={(event) => controller.patchRegionDraft({ autoSyncIntervalHours: Number(event.currentTarget.value || 0) })}
              />
            </label>
            <label class="space-y-1 text-sm ui-text-body">
              <span>{$t('admin.data.form.pmtilesMinZoom')}</span>
              <UiInput
                type="number"
                min="0"
                max="22"
                value={$regionDraft.pmtilesMinZoom}
                on:input={(event) => controller.patchRegionDraft({ pmtilesMinZoom: Number(event.currentTarget.value || 0) })}
              />
            </label>
            <label class="space-y-1 text-sm ui-text-body">
              <span>{$t('admin.data.form.pmtilesMaxZoom')}</span>
              <UiInput
                type="number"
                min="0"
                max="22"
                value={$regionDraft.pmtilesMaxZoom}
                on:input={(event) => controller.patchRegionDraft({ pmtilesMaxZoom: Number(event.currentTarget.value || 0) })}
              />
            </label>
          </div>

          <div class="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
            <label class="flex items-center gap-2 text-sm ui-text-body"
              ><UiCheckbox
                checked={$regionDraft.enabled}
                onchange={(event) => controller.patchRegionDraft({ enabled: event.detail.checked })}
              />
              {$t('admin.data.form.enabled')}</label
            >
            <label class="flex items-center gap-2 text-sm ui-text-body"
              ><UiCheckbox
                checked={$regionDraft.autoSyncEnabled}
                onchange={(event) => controller.patchRegionDraft({ autoSyncEnabled: event.detail.checked })}
              />
              {$t('admin.data.form.autoSyncEnabled')}</label
            >
            <label class="flex items-center gap-2 text-sm ui-text-body"
              ><UiCheckbox
                checked={$regionDraft.autoSyncOnStart}
                onchange={(event) => controller.patchRegionDraft({ autoSyncOnStart: event.detail.checked })}
              />
              {$t('admin.data.form.autoSyncOnStart')}</label
            >
          </div>
        </div>
      </details>
    </div>

    <div class="space-y-4 min-w-0">
      {#if $regionDraft.id}
        <div class="rounded-xl border ui-border ui-surface-base px-3 py-3 text-sm ui-text-body">
          <div class="flex flex-wrap items-center gap-2">
            <span class="font-semibold ui-text-strong">{$t('admin.data.form.currentStatus')}</span>
            <span
              class="badge-pill data-status-pill rounded-full px-2.5 py-1 text-xs font-semibold"
              data-tone={selectedStatusMeta.tone}>{selectedStatusMeta.text}</span
            >
          </div>
          <div class="mt-2 grid gap-1 text-xs ui-text-subtle">
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
        <UiButton
          type="submit"
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
    </div>
  </div>
</form>

<style>
  .data-form-card {
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
