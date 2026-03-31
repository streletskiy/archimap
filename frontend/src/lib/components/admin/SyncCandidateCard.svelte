<script>
  import { t } from '$lib/i18n/index';
  import { EditsIdentityCell } from '$lib/components/edits';
  import { formatUiDate } from '$lib/utils/edit-ui';

  import { UiBadge, UiButton, UiCheckbox, UiTableCell, UiTableRow } from '$lib/components/base';

  export let candidate = null;
  export let archived = false;
  export let isMasterAdmin = false;
  export let selected = false;
  export let syncable = false;
  export let syncBusy = false;
  export let onOpen = () => {};
  export let onSync = () => {};
  export let onToggleSelection = () => {};

  let candidateAddress;
  let changeCounters;

  function statusVariant(status) {
    const normalized = String(status || 'unsynced').trim().toLowerCase();
    if (normalized === 'synced') return 'success';
    if (normalized === 'cleaned') return 'info';
    if (normalized === 'syncing') return 'warning';
    if (normalized === 'failed') return 'danger';
    if (normalized === 'unsynced') return 'secondary';
    return 'accent';
  }

  function statusTextFor(status) {
    const normalized = String(status || 'unsynced').trim().toLowerCase();
    if (normalized === 'synced') return $t('admin.osm.status.synced');
    if (normalized === 'cleaned') return $t('admin.osm.status.cleaned');
    if (normalized === 'syncing') return $t('admin.osm.status.syncing');
    if (normalized === 'failed') return $t('admin.osm.status.failed');
    if (normalized === 'unsynced') return $t('admin.osm.status.unsynced');
    return normalized || $t('admin.osm.status.unsynced');
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

  function getChangeCounters(changes) {
    const list = Array.isArray(changes) ? changes : [];
    let created = 0;
    let modified = 0;

    for (const change of list) {
      if (change?.before == null && change?.after != null) {
        created += 1;
      } else {
        modified += 1;
      }
    }

    return {
      total: list.length,
      created,
      modified
    };
  }

  $: candidateAddress = getCandidateAddress(candidate);
  $: changeCounters = getChangeCounters(candidate?.changes);
</script>

{#if archived}
  <UiTableRow
    className="cursor-pointer hover:[&>td]:[background:color-mix(in_srgb,var(--accent-soft)_28%,var(--panel-solid))]"
    onclick={() => onOpen(candidate)}
  >
    <UiTableCell className="edits-list-identity-cell min-w-0">
      <EditsIdentityCell
        idLabel={$t('admin.edits.id')}
        osmType={candidate?.osmType}
        osmId={candidate?.osmId}
        address={candidateAddress}
      />
    </UiTableCell>
    <UiTableCell>{candidate?.latestCreatedBy || '-'}</UiTableCell>
    <UiTableCell>
      <UiBadge variant={statusVariant(candidate?.syncStatus)} className="rounded-full px-2.5 py-1 text-xs font-semibold">
        {statusTextFor(candidate?.syncStatus)}
      </UiBadge>
    </UiTableCell>
    <UiTableCell className="ui-text-muted">{formatUiDate(candidate?.latestUpdatedAt) || '---'}</UiTableCell>
    <UiTableCell>
      <div class="edits-list-changes flex flex-wrap items-center gap-2">
        <span class="rounded-md ui-surface-soft px-2 py-1 text-xs ui-text-muted">
          {changeCounters.total} {$t('admin.edits.changesTotal')}
        </span>
        {#if changeCounters.created > 0}
          <span class="rounded-md ui-surface-success-soft px-2 py-1 text-xs ui-text-success-soft">
            +{changeCounters.created} {$t('admin.edits.changesCreated')}
          </span>
        {/if}
        {#if changeCounters.modified > 0}
          <span class="rounded-md ui-surface-emphasis px-2 py-1 text-xs ui-text-body">
            ~{changeCounters.modified} {$t('admin.edits.changesModified')}
          </span>
        {/if}
      </div>
    </UiTableCell>
    <UiTableCell>
      <UiButton type="button" size="xs" variant="secondary" onclick={(event) => { event.stopPropagation(); onOpen(candidate); }}>
        {$t('admin.osm.list.details')}
      </UiButton>
    </UiTableCell>
  </UiTableRow>
{:else}
  <UiTableRow
    className="cursor-pointer hover:[&>td]:[background:color-mix(in_srgb,var(--accent-soft)_36%,var(--panel-solid))]"
    onclick={() => onOpen(candidate)}
  >
    {#if isMasterAdmin}
      <UiTableCell className="w-10" onclick={(event) => event.stopPropagation()}>
        <UiCheckbox
          checked={selected}
          disabled={!syncable}
          onchange={({ detail }) => onToggleSelection(candidate, detail?.checked)}
        />
      </UiTableCell>
    {/if}
    <UiTableCell className="edits-list-identity-cell min-w-0">
      <EditsIdentityCell
        idLabel={$t('admin.edits.id')}
        osmType={candidate?.osmType}
        osmId={candidate?.osmId}
        address={candidateAddress}
      />
    </UiTableCell>
    <UiTableCell>{candidate?.latestCreatedBy || '-'}</UiTableCell>
    <UiTableCell>
      <UiBadge variant={statusVariant(candidate?.syncStatus)} className="rounded-full px-2.5 py-1 text-xs font-semibold">
        {statusTextFor(candidate?.syncStatus)}
      </UiBadge>
    </UiTableCell>
    <UiTableCell className="ui-text-muted">{formatUiDate(candidate?.latestUpdatedAt) || '---'}</UiTableCell>
    <UiTableCell>
      <div class="edits-list-changes flex flex-wrap items-center gap-2">
        <span class="rounded-md ui-surface-soft px-2 py-1 text-xs ui-text-muted">
          {changeCounters.total} {$t('admin.edits.changesTotal')}
        </span>
        {#if changeCounters.created > 0}
          <span class="rounded-md ui-surface-success-soft px-2 py-1 text-xs ui-text-success-soft">
            +{changeCounters.created} {$t('admin.edits.changesCreated')}
          </span>
        {/if}
        {#if changeCounters.modified > 0}
          <span class="rounded-md ui-surface-emphasis px-2 py-1 text-xs ui-text-body">
            ~{changeCounters.modified} {$t('admin.edits.changesModified')}
          </span>
        {/if}
      </div>
    </UiTableCell>
    <UiTableCell>
      <div class="flex flex-wrap gap-2">
        <UiButton type="button" size="xs" variant="secondary" onclick={(event) => { event.stopPropagation(); onOpen(candidate); }}>
          {$t('admin.osm.list.details')}
        </UiButton>
        {#if isMasterAdmin}
          <UiButton
            type="button"
            size="xs"
            onclick={(event) => { event.stopPropagation(); onSync(candidate); }}
            disabled={syncBusy || !syncable}
          >
            {$t('admin.osm.list.syncNow')}
          </UiButton>
        {/if}
      </div>
    </UiTableCell>
  </UiTableRow>
{/if}
