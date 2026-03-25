<script>
  import { t } from '$lib/i18n/index';
  import { formatUiDate } from '$lib/utils/edit-ui';

  import { UiButton, UiCheckbox, UiTableCell, UiTableRow } from '$lib/components/base';

  export let candidate = null;
  export let archived = false;
  export let isMasterAdmin = false;
  export let selected = false;
  export let syncable = false;
  export let syncBusy = false;
  export let onOpen = () => {};
  export let onSync = () => {};
  export let onToggleSelection = () => {};

  function statusTone(status) {
    const normalized = String(status || 'unsynced').trim().toLowerCase();
    if (normalized === 'synced' || normalized === 'cleaned') return 'success';
    if (normalized === 'syncing') return 'running';
    if (normalized === 'failed') return 'failed';
    if (normalized === 'unsynced') return 'idle';
    return 'queued';
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
</script>

{#if archived}
  <UiTableRow
    className="cursor-pointer hover:[&>td]:[background:color-mix(in_srgb,var(--accent-soft)_28%,var(--panel-solid))]"
    onclick={() => onOpen(candidate)}
  >
    <UiTableCell className="min-w-0">
      <p class="font-semibold ui-text-strong break-words line-clamp-1">{candidate.latestLocalName || `${candidate.osmType}/${candidate.osmId}`}</p>
      <p class="text-xs ui-text-subtle truncate">{candidate.osmType}/{candidate.osmId}</p>
      <div class="mt-1 flex flex-wrap gap-1">
        {#if candidate.syncChangesetId}
          <span class="rounded-md ui-surface-info px-2 py-1 text-[11px] font-semibold ui-text-info">#{candidate.syncChangesetId}</span>
        {/if}
        <span class="rounded-md ui-surface-soft px-2 py-1 text-[11px] font-semibold ui-text-muted">{$t('admin.osm.archive.readOnly')}</span>
      </div>
    </UiTableCell>
    <UiTableCell>
      <span class="badge-pill rounded-full px-2.5 py-1 text-xs font-semibold" data-tone={statusTone(candidate.syncStatus)}>
        {statusTextFor(candidate.syncStatus)}
      </span>
    </UiTableCell>
    <UiTableCell className="ui-text-muted">{formatUiDate(candidate.latestUpdatedAt) || '---'}</UiTableCell>
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
    <UiTableCell className="min-w-0">
      {@const addedTags = (candidate.changes || []).filter(c => c.before == null && c.after != null).length}
      {@const removedTags = (candidate.changes || []).filter(c => c.before != null && c.after == null).length}
      {@const modifiedTags = (candidate.changes || []).filter(c => c.before != null && c.after != null).length}
      <p class="font-semibold ui-text-strong break-words line-clamp-1">{candidate.latestLocalName || `${candidate.osmType}/${candidate.osmId}`}</p>
      <p class="text-xs ui-text-subtle truncate">{candidate.osmType}/{candidate.osmId}</p>
      <div class="mt-1 flex flex-wrap items-center gap-1">
        {#if addedTags > 0}
          <span class="rounded-md bg-emerald-100/60 dark:bg-emerald-900/40 text-emerald-800 dark:text-emerald-300 px-1.5 py-0.5 text-[11px] font-bold" title="Заполнено новых полей">+{addedTags}</span>
        {/if}
        {#if modifiedTags > 0}
          <span class="rounded-md bg-amber-100/60 dark:bg-amber-900/40 text-amber-800 dark:text-amber-300 px-1.5 py-0.5 text-[11px] font-bold" title="Изменено существующих полей">~{modifiedTags}</span>
        {/if}
        {#if removedTags > 0}
          <span class="rounded-md bg-rose-100/60 dark:bg-rose-900/40 text-rose-800 dark:text-rose-300 px-1.5 py-0.5 text-[11px] font-bold" title="Очищено полей">-{removedTags}</span>
        {/if}
        {#if addedTags === 0 && modifiedTags === 0 && removedTags === 0}
          <span class="rounded-md ui-surface-soft px-1.5 py-0.5 text-[11px] font-bold ui-text-muted">{$t('admin.osm.detail.noChanges') || 'Без изменений'}</span>
        {/if}
        <span class="ml-1 rounded-md ui-surface-soft px-2 py-0.5 text-[11px] font-medium ui-text-muted" title="Количество одобренных заявок от пользователей, образующих это состояние">Заявок: {candidate.totalEdits}</span>
        {#if candidate.syncChangesetId}
          <span class="rounded-md ui-surface-info px-2 py-0.5 text-[11px] font-bold ui-text-info">#{candidate.syncChangesetId}</span>
        {/if}
      </div>
    </UiTableCell>
    <UiTableCell>{candidate.latestCreatedBy || '-'}</UiTableCell>
    <UiTableCell>
      <span class="badge-pill rounded-full px-2.5 py-1 text-xs font-semibold" data-tone={statusTone(candidate.syncStatus)}>
        {statusTextFor(candidate.syncStatus)}
      </span>
    </UiTableCell>
    <UiTableCell className="ui-text-muted">{formatUiDate(candidate.latestUpdatedAt) || '---'}</UiTableCell>
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

