<script>
  import { t, translateNow } from '$lib/i18n/index';
  import {
    formatUiDate,
    getChangeCounters,
    getDisplayEditStatusMeta,
    getEditAddress,
    getSyncBadgeMeta,
    isOverpassBackedEdit
  } from '$lib/utils/edit-ui';

  import { UiCheckbox, UiTableCell, UiTableRow } from '$lib/components/base';
  import { EditsIdentityCell } from '$lib/components/edits';

  export let edit = null;
  export let archived = false;
  export let onOpen = () => {};
  export let onToggleSelection = () => {};
  export let selected = false;
  export let selectable = false;
  export let selectionBusy = false;
  export let showSelection = false;

  let overpassBacked;

  $: statusMeta = getDisplayEditStatusMeta(edit, translateNow, 'admin.edits');
  $: counters = getChangeCounters(edit?.changes);
  $: syncMeta = getSyncBadgeMeta(edit?.syncStatus, translateNow, 'admin.edits');
  $: overpassBacked = isOverpassBackedEdit(edit);
  $: showIssueBadges = Boolean(edit?.orphaned || (!edit?.osmPresent && !edit?.orphaned) || edit?.sourceOsmChanged);
</script>

{#if archived}
  <UiTableRow
    className="cursor-pointer hover:[&>td]:[background:color-mix(in_srgb,var(--accent-soft)_24%,var(--panel-solid))]"
    onclick={() => onOpen(edit.id || edit.editId)}
  >
    <UiTableCell className="edits-list-identity-cell min-w-0">
      <EditsIdentityCell
        idLabel={$t('admin.edits.id')}
        osmType={edit.osmType}
        osmId={edit.osmId}
        address={getEditAddress(edit)}
      />
    </UiTableCell>
    <UiTableCell>{edit.updatedBy || '-'}</UiTableCell>
    <UiTableCell>
      <span class="whitespace-nowrap text-xs ui-text-subtle">{formatUiDate(edit.createdAt || edit.updatedAt) || '-'}</span>
    </UiTableCell>
    <UiTableCell>
      <span class="badge-pill rounded-full px-2.5 py-1 text-xs font-semibold {syncMeta.cls}">{syncMeta.text}</span>
    </UiTableCell>
    <UiTableCell>
      <div class="edits-list-changes flex flex-wrap items-center gap-2">
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
{:else}
  <UiTableRow
    className="cursor-pointer hover:[&>td]:[background:color-mix(in_srgb,var(--accent-soft)_44%,var(--panel-solid))]"
    onclick={() => onOpen(edit.id || edit.editId)}
  >
    {#if showSelection}
      <UiTableCell className="w-10" onclick={(event) => event.stopPropagation()}>
        <UiCheckbox
          checked={selected}
          disabled={selectionBusy || !selectable}
          onchange={({ detail }) => onToggleSelection(edit, detail?.checked)}
        />
      </UiTableCell>
    {/if}
    <UiTableCell className="edits-list-identity-cell min-w-0">
      <EditsIdentityCell
        idLabel={$t('admin.edits.id')}
        osmType={edit.osmType}
        osmId={edit.osmId}
        address={getEditAddress(edit)}
        showBadgesRow={showIssueBadges}
      >
        <svelte:fragment slot="badges">
          {#if edit.orphaned}
            <span class="rounded-md ui-surface-danger px-2 py-1 text-[11px] font-semibold ui-text-danger">
              {$t('admin.edits.orphaned')}
            </span>
          {:else if overpassBacked}
            <span class="rounded-md ui-surface-info px-2 py-1 text-[11px] font-semibold ui-text-info">
              {$t('admin.edits.overpassSource')}
            </span>
          {:else if !edit.osmPresent && !edit.orphaned}
            <span class="rounded-md ui-surface-warning px-2 py-1 text-[11px] font-semibold ui-text-warning">
              {$t('admin.edits.missingTarget')}
            </span>
          {/if}
          {#if edit.sourceOsmChanged}
            <span class="rounded-md ui-surface-info px-2 py-1 text-[11px] font-semibold ui-text-info">
              {$t('admin.edits.osmChanged')}
            </span>
          {/if}
        </svelte:fragment>
      </EditsIdentityCell>
    </UiTableCell>
    <UiTableCell>{edit.updatedBy || '-'}</UiTableCell>
    <UiTableCell>
      <span class="whitespace-nowrap text-xs ui-text-subtle">{formatUiDate(edit.createdAt || edit.updatedAt) || '-'}</span>
    </UiTableCell>
    <UiTableCell>
      <span class="badge-pill rounded-full px-2.5 py-1 text-xs font-semibold {statusMeta.cls}">
        {statusMeta.text}
      </span>
    </UiTableCell>
    <UiTableCell>
      <div class="edits-list-changes flex flex-wrap items-center gap-2">
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
