<script>
  import { t, translateNow } from '$lib/i18n/index';
  import {
    getChangeCounters,
    getEditAddress,
    getStatusBadgeMeta
  } from '$lib/utils/edit-ui';

  import { UiTableCell, UiTableRow } from '$lib/components/base';

  export let edit = null;
  export let archived = false;
  export let onOpen = () => {};

  $: statusMeta = getStatusBadgeMeta(edit?.status, translateNow);
  $: counters = getChangeCounters(edit?.changes);
  $: syncMeta = getSyncBadgeMeta(edit?.syncStatus);

  function getSyncBadgeMeta(status) {
    const normalized = String(status || 'unsynced').trim().toLowerCase();
    if (normalized === 'synced') return { cls: 'ui-surface-success-soft ui-text-success-soft', text: $t('admin.edits.syncSynced') };
    if (normalized === 'cleaned') return { cls: 'ui-surface-info ui-text-info', text: $t('admin.edits.syncCleaned') };
    if (normalized === 'syncing') return { cls: 'ui-surface-warning ui-text-warning', text: $t('admin.edits.syncing') };
    if (normalized === 'failed') return { cls: 'ui-surface-danger ui-text-danger', text: $t('admin.edits.syncFailed') };
    return { cls: 'ui-surface-soft ui-text-muted', text: $t('admin.edits.syncUnsynced') };
  }
</script>

{#if archived}
  <UiTableRow
    className="cursor-pointer hover:[&>td]:[background:color-mix(in_srgb,var(--accent-soft)_24%,var(--panel-solid))]"
    onclick={() => onOpen(edit.id || edit.editId)}
  >
    <UiTableCell className="min-w-0">
      <p class="font-semibold ui-text-strong break-words line-clamp-1">{getEditAddress(edit)}</p>
      <p class="text-xs ui-text-subtle truncate">ID: {edit.osmType}/{edit.osmId}</p>
      <div class="mt-1 flex flex-wrap gap-1">
        {#if edit.syncChangesetId}
          <span class="rounded-md ui-surface-info px-2 py-1 text-[11px] font-semibold ui-text-info">#{edit.syncChangesetId}</span>
        {/if}
        <span class={`rounded-md px-2 py-1 text-[11px] font-semibold ${syncMeta.cls}`}>{syncMeta.text}</span>
      </div>
    </UiTableCell>
    <UiTableCell>
      <span class="badge-pill rounded-full px-2.5 py-1 text-xs font-semibold {statusMeta.cls}">{statusMeta.text}</span>
    </UiTableCell>
    <UiTableCell>
      <div class="flex flex-wrap items-center gap-2">
        <span class="rounded-md ui-surface-soft px-2 py-1 text-xs ui-text-muted">{counters.total} {$t('admin.edits.changesTotal')}</span>
        {#if counters.created > 0}
          <span class="rounded-md ui-surface-success-soft px-2 py-1 text-xs ui-text-success-soft">+{counters.created} {$t('admin.edits.changesCreated')}</span>
        {/if}
        {#if counters.modified > 0}
          <span class="rounded-md ui-surface-emphasis px-2 py-1 text-xs ui-text-body">~{counters.modified} {$t('admin.edits.changesModified')}</span>
        {/if}
      </div>
    </UiTableCell>
    <UiTableCell>
      <span class="rounded-md ui-surface-soft px-2 py-1 text-xs font-semibold ui-text-muted">{$t('admin.edits.syncedArchiveReadOnly')}</span>
    </UiTableCell>
  </UiTableRow>
{:else}
  <UiTableRow
    className="cursor-pointer hover:[&>td]:[background:color-mix(in_srgb,var(--accent-soft)_44%,var(--panel-solid))]"
    onclick={() => onOpen(edit.id || edit.editId)}
  >
    <UiTableCell className="min-w-0">
      <p class="font-semibold ui-text-strong break-words line-clamp-1">{getEditAddress(edit)}</p>
      <p class="text-xs ui-text-subtle truncate">ID: {edit.osmType}/{edit.osmId}</p>
      <div class="mt-1 flex flex-wrap gap-1">
        {#if edit.orphaned}
          <span class="rounded-md ui-surface-danger px-2 py-1 text-[11px] font-semibold ui-text-danger">
            {$t('admin.edits.orphaned')}
          </span>
        {/if}
        {#if !edit.osmPresent && !edit.orphaned}
          <span class="rounded-md ui-surface-warning px-2 py-1 text-[11px] font-semibold ui-text-warning">
            {$t('admin.edits.missingTarget')}
          </span>
        {/if}
        {#if edit.sourceOsmChanged}
          <span class="rounded-md ui-surface-info px-2 py-1 text-[11px] font-semibold ui-text-info">
            {$t('admin.edits.osmChanged')}
          </span>
        {/if}
        {#if edit.syncStatus && edit.syncStatus !== 'unsynced'}
          <span class={`rounded-md px-2 py-1 text-[11px] font-semibold ${syncMeta.cls}`}>{syncMeta.text}</span>
        {/if}
      </div>
      {#if edit.syncChangesetId}
        <p class="mt-1 text-xs ui-text-subtle">
          {$t('admin.edits.syncChangeset')}: #{edit.syncChangesetId}
        </p>
      {/if}
    </UiTableCell>
    <UiTableCell>{edit.updatedBy || '-'}</UiTableCell>
    <UiTableCell>
      <span class="badge-pill rounded-full px-2.5 py-1 text-xs font-semibold {statusMeta.cls}">
        {statusMeta.text}
      </span>
    </UiTableCell>
    <UiTableCell>
      <div class="flex flex-wrap items-center gap-2">
        <span class="rounded-md ui-surface-soft px-2 py-1 text-xs ui-text-muted">{counters.total} {$t('admin.edits.changesTotal')}</span>
        {#if counters.created > 0}
          <span class="rounded-md ui-surface-success-soft px-2 py-1 text-xs ui-text-success-soft">+{counters.created} {$t('admin.edits.changesCreated')}</span>
        {/if}
        {#if counters.modified > 0}
          <span class="rounded-md ui-surface-emphasis px-2 py-1 text-xs ui-text-body">~{counters.modified} {$t('admin.edits.changesModified')}</span>
        {/if}
      </div>
    </UiTableCell>
  </UiTableRow>
{/if}
