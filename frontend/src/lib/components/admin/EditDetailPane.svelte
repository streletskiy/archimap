<script>
  import { formatUiDate, getStatusBadgeMeta, getSyncBadgeMeta } from '$lib/utils/edit-ui';
  import { t, translateNow } from '$lib/i18n/index';
  import {
    UiButton,
    UiCheckbox,
    UiInput,
    UiSelect,
    UiTextarea
  } from '$lib/components/base';
  import EditDetailModal from '$lib/components/edits/EditDetailModal.svelte';

  export let selectedEdit = null;
  export let selectedFeature = null;
  export let detailLoading = false;
  export let detailStatus = '';
  export let fieldDecisions = {};
  export let fieldValues = {};
  export let moderationComment = '';
  export let moderationBusy = false;
  export let reassignTargetType = 'way';
  export let reassignTargetId = '';
  export let reassignForce = false;
  export let selectedEditIsReadOnly = false;
  export let isMasterAdmin = false;
  export let reassignTargetTypeItems = [];
  export let onClose = () => {};
  export let setAll = () => {};
  export let applyDecision = () => {};
  export let reassignSelectedEdit = () => {};
  export let deleteSelectedEdit = () => {};
</script>

<EditDetailModal
  open={true}
  title={$t('admin.edits.detailTitle')}
  closeLabel={$t('admin.edits.closeDetail')}
  closeDisabled={moderationBusy}
  {selectedFeature}
  mapLoading={detailLoading}
  mapLoadingText={$t('admin.loading')}
  onClose={onClose}
>
  <div class="edit-detail-flow">
    {#if detailLoading}
      <p class="text-sm ui-text-subtle">{$t('admin.loading')}</p>
    {:else if !selectedEdit}
      <p class="text-sm ui-text-subtle">{$t('admin.edits.selectHint')}</p>
    {:else}
      {@const selectedStatusMeta = getStatusBadgeMeta(selectedEdit.status, translateNow)}
      <p class="edit-detail-meta flex flex-wrap items-center gap-2 text-sm ui-text-muted">
        <span class="edit-detail-meta-primary">{$t('admin.edits.id')}: {selectedEdit.editId || selectedEdit.id} | {selectedEdit.osmType}/{selectedEdit.osmId}</span>
        <span class="badge-pill rounded-full px-2.5 py-1 text-xs font-semibold {selectedStatusMeta.cls}">
          {selectedStatusMeta.text}
        </span>
        {#if selectedEdit.syncStatus && selectedEdit.syncStatus !== 'unsynced'}
          {@const syncMeta = getSyncBadgeMeta(selectedEdit.syncStatus, translateNow, 'admin.edits')}
          <span class={`badge-pill rounded-full px-2.5 py-1 text-xs font-semibold ${syncMeta.cls}`}>{syncMeta.text}</span>
        {/if}
      </p>

      {#if selectedEdit.syncStatus && selectedEdit.syncStatus !== 'unsynced'}
        <div class="space-y-1 rounded-xl border ui-border ui-surface-muted p-3 text-sm ui-text-body">
          <p><strong>{$t('admin.edits.syncStatus')}:</strong> {getSyncBadgeMeta(selectedEdit.syncStatus, translateNow, 'admin.edits').text}</p>
          <p><strong>{$t('admin.edits.syncAttemptedAt')}:</strong> {formatUiDate(selectedEdit.syncAttemptedAt) || '---'}</p>
          <p><strong>{$t('admin.edits.syncSucceededAt')}:</strong> {formatUiDate(selectedEdit.syncSucceededAt) || '---'}</p>
          <p><strong>{$t('admin.edits.syncCleanedAt')}:</strong> {formatUiDate(selectedEdit.syncCleanedAt) || '---'}</p>
          <p><strong>{$t('admin.edits.syncChangeset')}:</strong> {selectedEdit.syncChangesetId || '---'}</p>
          {#if selectedEdit.syncSummary}
            <p class="edit-detail-break text-xs ui-text-subtle">{JSON.stringify(selectedEdit.syncSummary)}</p>
          {/if}
          {#if selectedEdit.syncError}
            <p class="edit-detail-break text-xs ui-text-danger">{selectedEdit.syncError}</p>
          {/if}
        </div>
      {/if}

      {#if selectedEditIsReadOnly}
        <div class="rounded-xl border ui-border ui-surface-soft p-3 text-sm ui-text-body">
          <p class="font-semibold ui-text-strong">{$t('admin.edits.syncedArchiveReadOnly')}</p>
          <p class="mt-1 text-xs ui-text-muted">{$t('admin.edits.syncedArchiveReadOnlyHelp')}</p>
        </div>
      {/if}

      {#if selectedEdit.orphaned || !selectedEdit.osmPresent || selectedEdit.sourceOsmChanged}
        <div class="space-y-2 rounded-xl border p-3 text-sm" style="border-color: var(--ui-map-filter-warning-border); background: var(--ui-map-filter-warning-bg); color: var(--ui-map-filter-warning-text)">
          {#if selectedEdit.orphaned}
            <p>{$t('admin.edits.orphanedHelp')}</p>
          {/if}
          {#if !selectedEdit.osmPresent && !selectedEdit.orphaned}
            <p>{$t('admin.edits.missingTargetHelp')}</p>
          {/if}
          {#if selectedEdit.sourceOsmChanged}
            <p>{$t('admin.edits.osmChangedHelp')}</p>
          {/if}
        </div>
      {/if}

      <div class="space-y-2">
        {#if !Array.isArray(selectedEdit.changes) || selectedEdit.changes.length === 0}
          <p class="text-sm ui-text-subtle">{$t('admin.edits.noChanges')}</p>
        {:else}
          {#each selectedEdit.changes as change (`${change.field}`)}
            <div class="rounded-lg border ui-border ui-surface-muted p-2">
              <div class="mb-1 flex flex-col items-start gap-2 sm:flex-row sm:items-center sm:justify-between">
                <p class="text-sm font-semibold ui-text-strong">{change.label || change.field}</p>
                {#if !selectedEditIsReadOnly}
                  <div class="flex flex-wrap items-center gap-1">
                    <UiButton
                      type="button"
                      size="xs"
                      variant={fieldDecisions[change.field] !== 'reject' ? 'primary' : 'secondary'}
                      onclick={() => (fieldDecisions = { ...fieldDecisions, [change.field]: 'accept' })}
                    >
                      {$t('admin.edits.accept')}
                    </UiButton>
                    <UiButton
                      type="button"
                      size="xs"
                      variant={fieldDecisions[change.field] === 'reject' ? 'primary' : 'secondary'}
                      onclick={() => (fieldDecisions = { ...fieldDecisions, [change.field]: 'reject' })}
                    >
                      {$t('admin.edits.reject')}
                    </UiButton>
                  </div>
                {/if}
              </div>
              <p class="edit-detail-break text-xs ui-text-muted">
                <span class="line-through">{String(change.osmValue ?? $t('admin.edits.emptyValue'))}</span> ->
                <strong>{String(change.localValue ?? $t('admin.edits.emptyValue'))}</strong>
              </p>
              {#if !selectedEditIsReadOnly && fieldDecisions[change.field] !== 'reject'}
                <UiInput
                  className="mt-2"
                  value={fieldValues[change.field] ?? ''}
                  on:input={(event) => (fieldValues = { ...fieldValues, [change.field]: event.currentTarget.value })}
                />
              {/if}
            </div>
          {/each}
        {/if}
      </div>

      {#if !selectedEditIsReadOnly}
        <UiTextarea
          className="min-h-[84px]"
          placeholder={$t('admin.edits.moderatorComment')}
          bind:value={moderationComment}
        ></UiTextarea>

        {#if selectedEdit.canReassign}
          <div class="space-y-2 rounded-xl border ui-border ui-surface-muted p-3">
            <p class="text-sm font-semibold ui-text-strong">{$t('admin.edits.reassignTitle')}</p>
            <p class="text-xs ui-text-muted">{$t('admin.edits.reassignHelp')}</p>
            <div class="grid gap-2 sm:grid-cols-[120px_1fr_auto]">
              <UiSelect items={reassignTargetTypeItems} bind:value={reassignTargetType} />
              <UiInput
                type="number"
                min="1"
                bind:value={reassignTargetId}
                placeholder={$t('admin.edits.reassignTargetId')}
              />
              <UiButton
                type="button"
                variant="secondary"
                disabled={moderationBusy}
                onclick={reassignSelectedEdit}
              >
                {$t('admin.edits.reassignAction')}
              </UiButton>
            </div>
            <label class="flex items-center gap-2 text-xs ui-text-body">
              <UiCheckbox bind:checked={reassignForce} />
              {$t('admin.edits.reassignForce')}
            </label>
          </div>
        {/if}

        {#if isMasterAdmin}
          <div class="space-y-2 rounded-xl border ui-border-danger-soft ui-surface-danger-soft p-3">
            <p class="text-sm font-semibold ui-text-danger-strong">{$t('admin.edits.deleteTitle')}</p>
            {#if selectedEdit.canHardDelete}
              <p class="text-xs ui-text-danger-strong">{$t('admin.edits.deleteHelp')}</p>
            {:else if selectedEdit.hardDeleteBlockedReason === 'merged_with_other_accepted_edits'}
              <p class="text-xs ui-text-danger-strong">{$t('admin.edits.deleteBlockedSharedMergedState')}</p>
            {:else}
              <p class="text-xs ui-text-danger-strong">{$t('admin.edits.deleteBlocked')}</p>
            {/if}
            <UiButton
              type="button"
              variant="danger"
              disabled={moderationBusy || !selectedEdit.canHardDelete}
              onclick={deleteSelectedEdit}
            >
              {$t('admin.edits.deleteAction')}
            </UiButton>
          </div>
        {/if}

        <div class="flex flex-wrap gap-2">
          <UiButton type="button" variant="secondary" onclick={() => setAll('accept')}>
            {$t('admin.edits.acceptAll')}
          </UiButton>
          <UiButton type="button" variant="secondary" onclick={() => setAll('reject')}>
            {$t('admin.edits.rejectAll')}
          </UiButton>
          <UiButton
            type="button"
            disabled={moderationBusy}
            onclick={() => applyDecision('apply')}
          >
            {$t('admin.edits.applyDecision')}
          </UiButton>
          <UiButton
            type="button"
            variant="danger"
            disabled={moderationBusy}
            onclick={() => applyDecision('reject')}
          >
            {$t('admin.edits.rejectEdit')}
          </UiButton>
        </div>
      {/if}

      {#if detailStatus}
        <p class="text-sm ui-text-muted">{detailStatus}</p>
      {/if}
    {/if}
  </div>
</EditDetailModal>
