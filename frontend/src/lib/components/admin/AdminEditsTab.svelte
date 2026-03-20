<script>
  import { createEventDispatcher, onMount } from 'svelte';
  import { fade } from 'svelte/transition';

  import {
    UiButton,
    UiCheckbox,
    UiDateRangePicker,
    UiInput,
    UiScrollArea,
    UiSelect,
    UiTable,
    UiTableBody,
    UiTableCell,
    UiTableHead,
    UiTableHeader,
    UiTableRow,
    UiTextarea
  } from '$lib/components/base';
  import { locale, t, translateNow } from '$lib/i18n/index';
  import { apiJson } from '$lib/services/http';
  import { getGeometryCenter } from '$lib/utils/map-geometry';
  import {
    formatUiDate,
    getChangeCounters,
    getEditAddress,
    getEditKey,
    getStatusBadgeMeta,
    matchesUiDateRange,
    parseEditKey
  } from '$lib/utils/edit-ui';

  import AdminMap from './AdminMap.svelte';

  export let requestedEditId = null;
  export let isMasterAdmin = false;

  const EMPTY_FEATURE_COLLECTION = { type: 'FeatureCollection', features: [] };
  const dispatch = createEventDispatcher();
  const msg = (error, fallback) => String(error?.message || fallback);

  let edits = [];
  let visibleEdits = [];
  let activeEdits = [];
  let syncedEdits = [];
  let editsLoading = false;
  let editsStatus = translateNow('admin.loading');
  let editsError = '';
  let editsFilter = 'all';
  let editsLimit = 200;
  let editsQuery = '';
  let editsDateRange = undefined;
  let editsUser = '';
  let editsUsers = [];
  let editsUserItems = [];
  let editsFilterItems = [];
  const editsLimitItems = [
    { value: 100, label: '100' },
    { value: 200, label: '200' },
    { value: 500, label: '500' }
  ];
  const reassignTargetTypeItems = [
    { value: 'way', label: 'way' },
    { value: 'relation', label: 'relation' }
  ];

  let selectedEdit = null;
  let selectedFeature = EMPTY_FEATURE_COLLECTION;
  let detailLoading = false;
  let detailStatus = '';
  let detailPaneVisible = false;
  let detailRequestToken = 0;
  let fieldDecisions = {};
  let fieldValues = {};
  let moderationComment = '';
  let moderationBusy = false;
  let reassignTargetType = 'way';
  let reassignTargetId = '';
  let reassignForce = false;
  let previousRequestedEditId = normalizeEditId(requestedEditId);

  let centerByKey = new Map();
  let editIdByKey = new Map();

  $: editsUserItems = [
    { value: '', label: $t('admin.edits.userAll') },
    ...editsUsers.map((user) => ({ value: user, label: user }))
  ];
  $: editsFilterItems = [
    { value: 'all', label: $t('admin.edits.statusAll') },
    { value: 'pending', label: $t('admin.edits.statusPending') },
    { value: 'accepted', label: $t('admin.edits.statusAccepted') },
    { value: 'partially_accepted', label: $t('admin.edits.statusPartiallyAccepted') },
    { value: 'rejected', label: $t('admin.edits.statusRejected') },
    { value: 'superseded', label: $t('admin.edits.statusSuperseded') }
  ];

  function normalizeEditId(value) {
    const numeric = Number(value || 0);
    return Number.isInteger(numeric) && numeric > 0 ? numeric : null;
  }

  function resetReassignDraft() {
    reassignTargetType = 'way';
    reassignTargetId = '';
    reassignForce = false;
  }

  function getSyncBadgeMeta(status) {
    const normalized = String(status || 'unsynced').trim().toLowerCase();
    if (normalized === 'synced') return { cls: 'ui-surface-success-soft ui-text-success-soft', text: $t('admin.edits.syncSynced') };
    if (normalized === 'cleaned') return { cls: 'ui-surface-info ui-text-info', text: $t('admin.edits.syncCleaned') };
    if (normalized === 'syncing') return { cls: 'ui-surface-warning ui-text-warning', text: $t('admin.edits.syncing') };
    if (normalized === 'failed') return { cls: 'ui-surface-danger ui-text-danger', text: $t('admin.edits.syncFailed') };
    return { cls: 'ui-surface-soft ui-text-muted', text: $t('admin.edits.syncUnsynced') };
  }

  function isSyncedArchiveEdit(item) {
    const normalized = String(item?.syncStatus || '').trim().toLowerCase();
    return normalized === 'synced' || normalized === 'cleaned' || Boolean(item?.syncReadOnly);
  }

  function seedReassignDraft(item) {
    reassignTargetType = String(item?.osmType || 'way').trim() || 'way';
    reassignTargetId = '';
    reassignForce = false;
  }

  function setSelectedFeature(feature) {
    selectedFeature = feature && typeof feature === 'object' ? feature : EMPTY_FEATURE_COLLECTION;
  }

  async function loadCenters(items) {
    let nextCenters = centerByKey;
    let changed = false;

    for (const item of items) {
      const key = getEditKey(item);
      if (!key || nextCenters.has(key)) continue;
      const parsed = parseEditKey(key);
      if (!parsed) continue;
      try {
        const feature = await apiJson(
          `/api/building/${encodeURIComponent(parsed.osmType)}/${encodeURIComponent(parsed.osmId)}`
        );
        const center = getGeometryCenter(feature?.geometry);
        if (!center) continue;
        if (!changed) {
          nextCenters = new Map(nextCenters);
          changed = true;
        }
        nextCenters.set(key, center);
      } catch {}
    }

    if (changed) {
      centerByKey = nextCenters;
    }
  }

  async function loadEdits() {
    editsLoading = true;
    editsError = '';
    editsStatus = translateNow('admin.loading');

    try {
      const params = new URLSearchParams();
      params.set('status', 'all');
      params.set('limit', String(editsLimit));
      const data = await apiJson(`/api/admin/building-edits?${params.toString()}`);
      edits = Array.isArray(data?.items) ? data.items : [];
      editsUsers = [
        ...new Set(
          edits
            .map((item) =>
              String(item?.updatedBy || '')
                .trim()
                .toLowerCase()
            )
            .filter(Boolean)
        )
      ].sort();
      await loadCenters(edits);
      await maybeOpenRequestedEdit(normalizeEditId(requestedEditId));
    } catch (error) {
      edits = [];
      visibleEdits = [];
      activeEdits = [];
      syncedEdits = [];
      editsUsers = [];
      editsError = msg(error, translateNow('admin.edits.loadFailed'));
      editsStatus = editsError;
    } finally {
      editsLoading = false;
    }
  }

  function notifyEditIdChange(editId) {
    dispatch('editidchange', { editId: normalizeEditId(editId) });
  }

  async function openEdit(editId, options = {}) {
    const { syncUrl = true } = options;
    const numericEditId = normalizeEditId(editId);
    if (!numericEditId) return;

    const currentId = normalizeEditId(selectedEdit?.editId || selectedEdit?.id);
    if (detailPaneVisible && currentId === numericEditId && !detailLoading) {
      if (syncUrl) notifyEditIdChange(numericEditId);
      return;
    }

    const requestToken = ++detailRequestToken;
    detailPaneVisible = true;
    selectedEdit = null;
    setSelectedFeature(EMPTY_FEATURE_COLLECTION);
    detailLoading = true;
    detailStatus = translateNow('admin.loading');
    fieldDecisions = {};
    fieldValues = {};
    moderationComment = '';

    try {
      const data = await apiJson(`/api/admin/building-edits/${numericEditId}`);
      if (requestToken !== detailRequestToken) return;

      selectedEdit = data?.item || null;
      if (syncUrl) {
        notifyEditIdChange(numericEditId);
      }

      const nextDecisions = {};
      const nextValues = {};
      for (const change of Array.isArray(selectedEdit?.changes) ? selectedEdit.changes : []) {
        const field = String(change?.field || '').trim();
        if (!field) continue;
        nextDecisions[field] = 'accept';
        nextValues[field] = change?.localValue == null ? '' : String(change.localValue);
      }
      fieldDecisions = nextDecisions;
      fieldValues = nextValues;
      seedReassignDraft(selectedEdit);
      detailStatus = '';

      try {
        const feature = await apiJson(
          `/api/building/${encodeURIComponent(selectedEdit.osmType)}/${encodeURIComponent(selectedEdit.osmId)}`
        );
        if (requestToken !== detailRequestToken) return;
        setSelectedFeature(feature);
      } catch {}
    } catch (error) {
      if (requestToken !== detailRequestToken) return;
      selectedEdit = null;
      detailStatus = msg(error, translateNow('admin.edits.detailsLoadFailed'));
    } finally {
      if (requestToken === detailRequestToken) {
        detailLoading = false;
      }
    }
  }

  function closeEditPanel(options = {}) {
    const { syncUrl = true } = options;
    detailRequestToken += 1;
    detailPaneVisible = false;
    detailLoading = false;
    detailStatus = '';
    moderationComment = '';
    resetReassignDraft();
    setSelectedFeature(EMPTY_FEATURE_COLLECTION);
    if (syncUrl) {
      notifyEditIdChange(null);
    }
  }

  function onDetailPaneOutroEnd() {
    if (detailPaneVisible) return;
    selectedEdit = null;
    detailLoading = false;
    detailStatus = '';
    fieldDecisions = {};
    fieldValues = {};
    moderationComment = '';
    resetReassignDraft();
    setSelectedFeature(EMPTY_FEATURE_COLLECTION);
  }

  function setAll(decision) {
    const next = {};
    for (const field of Object.keys(fieldDecisions)) {
      next[field] = decision;
    }
    fieldDecisions = next;
  }

  function commentWithRejected(base, rejected) {
    const value = String(base || '').trim();
    if (!rejected.length) return value;
    const note = translateNow('admin.edits.commentRejectedFields', { fields: rejected.join(', ') });
    return value ? `${value}\n\n${note}` : note;
  }

  async function applyDecision(mode) {
    if (!selectedEdit || moderationBusy) return;

    moderationBusy = true;
    try {
      const editId = selectedEdit.editId || selectedEdit.id;
      if (mode === 'reject') {
        await apiJson(`/api/admin/building-edits/${editId}/reject`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ comment: moderationComment })
        });
      } else {
        const accepted = [];
        const rejected = [];
        for (const [field, decision] of Object.entries(fieldDecisions)) {
          if (decision === 'reject') rejected.push(field);
          else accepted.push(field);
        }
        if (accepted.length === 0) {
          await apiJson(`/api/admin/building-edits/${editId}/reject`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ comment: commentWithRejected(moderationComment, rejected) })
          });
        } else {
          const values = {};
          for (const field of accepted) {
            values[field] = String(fieldValues[field] ?? '');
          }
          await apiJson(`/api/admin/building-edits/${editId}/merge`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              fields: accepted,
              values,
              comment: commentWithRejected(moderationComment, rejected)
            })
          });
        }
      }
      await loadEdits();
      await openEdit(editId, { syncUrl: false });
    } catch (error) {
      detailStatus = msg(error, translateNow('admin.edits.decisionFailed'));
    } finally {
      moderationBusy = false;
    }
  }

  async function reassignSelectedEdit() {
    if (!selectedEdit || moderationBusy) return;

    const targetOsmId = Number(reassignTargetId);
    if (!['way', 'relation'].includes(String(reassignTargetType || '').trim()) || !Number.isInteger(targetOsmId) || targetOsmId <= 0) {
      detailStatus = translateNow('admin.edits.reassignInvalidTarget');
      return;
    }

    moderationBusy = true;
    try {
      const editId = selectedEdit.editId || selectedEdit.id;
      await apiJson(`/api/admin/building-edits/${editId}/reassign`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          target: {
            osmType: reassignTargetType,
            osmId: targetOsmId
          },
          force: reassignForce
        })
      });
      await loadEdits();
      await openEdit(editId, { syncUrl: false });
      detailStatus = translateNow('admin.edits.reassignDone');
    } catch (error) {
      detailStatus = msg(error, translateNow('admin.edits.reassignFailed'));
    } finally {
      moderationBusy = false;
    }
  }

  async function deleteSelectedEdit() {
    if (!isMasterAdmin || !selectedEdit || moderationBusy) return;

    const editId = normalizeEditId(selectedEdit.editId || selectedEdit.id);
    if (!editId) return;

    if (typeof window !== 'undefined') {
      const label = `${selectedEdit.osmType}/${selectedEdit.osmId} #${editId}`;
      const confirmed = window.confirm(translateNow('admin.edits.deleteConfirm', { label }));
      if (!confirmed) return;
    }

    moderationBusy = true;
    try {
      await apiJson(`/api/admin/building-edits/${editId}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' }
      });
      await loadEdits();
      closeEditPanel();
      editsStatus = translateNow('admin.edits.deleteDone');
    } catch (error) {
      detailStatus = msg(error, translateNow('admin.edits.deleteFailed'));
    } finally {
      moderationBusy = false;
    }
  }

  async function maybeOpenRequestedEdit(editId = normalizeEditId(requestedEditId)) {
    if (!editId) return;
    const currentId = normalizeEditId(selectedEdit?.editId || selectedEdit?.id);
    if (detailPaneVisible && currentId === editId) return;
    await openEdit(editId, { syncUrl: false });
  }

  $: {
    const query = String(editsQuery || '')
      .trim()
      .toLowerCase();
    const user = String(editsUser || '')
      .trim()
      .toLowerCase();
    const status = String(editsFilter || 'all')
      .trim()
      .toLowerCase();

    visibleEdits = edits.filter((item) => {
      const osmKey = `${String(item?.osmType || '')}/${Number(item?.osmId || 0)}`.toLowerCase();
      const address = getEditAddress(item).toLowerCase();
      const author = String(item?.updatedBy || '')
        .trim()
        .toLowerCase();
      if (query && !address.includes(query) && !osmKey.includes(query)) return false;
      if (!matchesUiDateRange(item?.updatedAt, editsDateRange)) return false;
      if (user && author !== user) return false;
      if (status !== 'all' && String(item?.status || '').trim().toLowerCase() !== status) return false;
      return true;
    });
    activeEdits = visibleEdits.filter((item) => !isSyncedArchiveEdit(item));
    syncedEdits = visibleEdits.filter((item) => isSyncedArchiveEdit(item));

    const nextEditIdByKey = new Map();
    for (const item of visibleEdits) {
      const key = getEditKey(item);
      if (key) {
        nextEditIdByKey.set(key, Number(item.id || item.editId || 0));
      }
    }
    editIdByKey = nextEditIdByKey;

    if (editsError) {
      editsStatus = editsError;
    } else if (editsLoading) {
      editsStatus = translateNow('admin.loading');
    } else {
      editsStatus = activeEdits.length || syncedEdits.length
        ? translateNow('admin.edits.statusShown', { visible: activeEdits.length, total: visibleEdits.length })
        : translateNow('admin.empty');
    }
  }

  $: dispatch('summary', { total: edits.length, visible: activeEdits.length, archived: syncedEdits.length });

  $: {
    const nextRequestedEditId = normalizeEditId(requestedEditId);
    if (nextRequestedEditId !== previousRequestedEditId) {
      const previous = previousRequestedEditId;
      previousRequestedEditId = nextRequestedEditId;
      if (nextRequestedEditId) {
        void maybeOpenRequestedEdit(nextRequestedEditId);
      } else if (previous) {
        closeEditPanel({ syncUrl: false });
      }
    }
  }

  $: selectedEditIsReadOnly = isSyncedArchiveEdit(selectedEdit);
  $: adminPaneOpen = detailPaneVisible || detailLoading || Boolean(selectedEdit) || Boolean(detailStatus);

  onMount(() => {
    void loadEdits();
  });
</script>

<div
  class="mt-3 grid gap-4 overflow-hidden min-h-0"
  class:lg:grid-cols-[1.1fr_1fr]={adminPaneOpen}
  class:lg:grid-cols-1={!adminPaneOpen}
>
  <section class="flex flex-col space-y-3 rounded-2xl border ui-border ui-surface-base p-3 min-h-0 overflow-hidden">
    <div class="ui-filter-toolbar ui-filter-toolbar--admin-edits">
      <UiInput type="search" placeholder={$t('admin.edits.search')} bind:value={editsQuery} />
      <UiDateRangePicker
        value={editsDateRange}
        locale={$locale}
        placeholder={$t('admin.edits.dateRangePlaceholder')}
        calendarLabel={$t('admin.edits.dateRangeLabel')}
        clearLabel={$t('common.clear')}
        onchange={(event) => (editsDateRange = event.detail.value)}
      />
      <UiSelect
        items={editsUserItems}
        bind:value={editsUser}
        contentClassName="max-h-72"
      />
      <UiSelect items={editsFilterItems} bind:value={editsFilter} />
      <div class="ui-filter-toolbar__group ui-filter-toolbar__group--limit">
        <UiSelect
          items={editsLimitItems}
          bind:value={editsLimit}
          onchange={loadEdits}
        />
        <UiButton
          type="button"
          variant="secondary"
          className="w-full min-h-11 rounded-[1rem] px-4 py-3 text-sm sm:w-auto"
          onclick={loadEdits}
        >
          {$t('common.refresh')}
        </UiButton>
      </div>
    </div>

    <p class="text-sm ui-text-muted">{editsStatus}</p>

    <AdminMap
      {visibleEdits}
      {centerByKey}
      {editIdByKey}
      {selectedFeature}
      on:openedit={(event) => openEdit(event.detail?.editId)}
    />

    <UiTable>
      <UiTableHeader>
        <UiTableRow className="hover:[&>th]:bg-transparent">
          <UiTableHead>{$t('admin.edits.tableBuilding')}</UiTableHead>
          <UiTableHead>{$t('admin.edits.tableAuthor')}</UiTableHead>
          <UiTableHead>{$t('admin.edits.tableStatus')}</UiTableHead>
          <UiTableHead>{$t('admin.edits.tableChanges')}</UiTableHead>
        </UiTableRow>
      </UiTableHeader>
      <UiTableBody>
        {#if editsLoading}
          <UiTableRow>
            <UiTableCell colspan="4" className="ui-text-subtle">{$t('admin.loading')}</UiTableCell>
          </UiTableRow>
        {:else if activeEdits.length === 0}
          <UiTableRow>
            <UiTableCell colspan="4" className="ui-text-subtle">{$t('admin.empty')}</UiTableCell>
          </UiTableRow>
        {:else}
          {#each activeEdits as edit (`${edit.id || edit.editId}`)}
            {@const statusMeta = getStatusBadgeMeta(edit.status, translateNow)}
            {@const counters = getChangeCounters(edit.changes)}
            <UiTableRow
              className="cursor-pointer hover:[&>td]:[background:color-mix(in_srgb,var(--accent-soft)_44%,var(--panel-solid))]"
              onclick={() => openEdit(edit.id || edit.editId)}
            >
              <UiTableCell className="min-w-0">
                <p class="font-semibold ui-text-strong break-words line-clamp-1">{getEditAddress(edit)}</p>
                <p class="text-xs ui-text-subtle truncate">ID: {edit.osmType}/{edit.osmId}</p>
                <div class="mt-1 flex flex-wrap gap-1">
                  {#if edit.orphaned}
                    <span class="rounded-md ui-surface-danger px-2 py-1 text-[11px] font-semibold ui-text-danger"
                      >{$t('admin.edits.orphaned')}</span
                    >
                  {/if}
                  {#if !edit.osmPresent && !edit.orphaned}
                    <span class="rounded-md ui-surface-warning px-2 py-1 text-[11px] font-semibold ui-text-warning"
                      >{$t('admin.edits.missingTarget')}</span
                    >
                  {/if}
                  {#if edit.sourceOsmChanged}
                    <span class="rounded-md ui-surface-info px-2 py-1 text-[11px] font-semibold ui-text-info"
                      >{$t('admin.edits.osmChanged')}</span
                    >
                  {/if}
                  {#if edit.syncStatus && edit.syncStatus !== 'unsynced'}
                    {@const syncMeta = getSyncBadgeMeta(edit.syncStatus)}
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
              <UiTableCell
                ><span class="badge-pill rounded-full px-2.5 py-1 text-xs font-semibold {statusMeta.cls}"
                  >{statusMeta.text}</span
                ></UiTableCell
              >
              <UiTableCell>
                <div class="flex flex-wrap items-center gap-2">
                  <span class="rounded-md ui-surface-soft px-2 py-1 text-xs ui-text-muted"
                    >{counters.total} {$t('admin.edits.changesTotal')}</span
                  >
                  {#if counters.created > 0}
                    <span class="rounded-md ui-surface-success-soft px-2 py-1 text-xs ui-text-success-soft"
                      >+{counters.created} {$t('admin.edits.changesCreated')}</span
                    >
                  {/if}
                  {#if counters.modified > 0}
                    <span class="rounded-md ui-surface-emphasis px-2 py-1 text-xs ui-text-body"
                      >~{counters.modified} {$t('admin.edits.changesModified')}</span
                    >
                  {/if}
                </div>
              </UiTableCell>
            </UiTableRow>
          {/each}
        {/if}
      </UiTableBody>
    </UiTable>

    {#if syncedEdits.length > 0}
      <details class="overflow-hidden rounded-xl border ui-border ui-surface-muted" open={false}>
        <summary class="flex cursor-pointer list-none items-center justify-between gap-2 p-3">
          <div>
            <h4 class="text-sm font-semibold ui-text-strong">{$t('admin.edits.syncedArchiveTitle')}</h4>
            <p class="text-xs ui-text-muted">{$t('admin.edits.syncedArchiveHint')}</p>
          </div>
          <span class="text-xs ui-text-subtle">{syncedEdits.length}</span>
        </summary>
        <div class="border-t ui-border p-3">
          <UiScrollArea className="max-h-72 rounded-xl border ui-border" contentClassName="space-y-2 p-2">
            <UiTable containerClassName="ui-surface-base">
              <UiTableHeader>
                <UiTableRow className="hover:[&>th]:bg-transparent">
                  <UiTableHead>{$t('admin.edits.tableBuilding')}</UiTableHead>
                  <UiTableHead>{$t('admin.edits.tableStatus')}</UiTableHead>
                  <UiTableHead>{$t('admin.edits.tableChanges')}</UiTableHead>
                  <UiTableHead>{$t('admin.edits.syncStatus')}</UiTableHead>
                </UiTableRow>
              </UiTableHeader>
              <UiTableBody>
                {#each syncedEdits as edit (`synced-${edit.id || edit.editId}`)}
                  {@const statusMeta = getStatusBadgeMeta(edit.status, translateNow)}
                  {@const counters = getChangeCounters(edit.changes)}
                  {@const syncMeta = getSyncBadgeMeta(edit.syncStatus)}
                  <UiTableRow
                    className="cursor-pointer hover:[&>td]:[background:color-mix(in_srgb,var(--accent-soft)_24%,var(--panel-solid))]"
                    onclick={() => openEdit(edit.id || edit.editId)}
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
                {/each}
              </UiTableBody>
            </UiTable>
          </UiScrollArea>
        </div>
      </details>
    {/if}
  </section>

  {#if detailPaneVisible}
    <section
      class="flex flex-col space-y-3 rounded-2xl border ui-border ui-surface-base p-3 min-h-0 overflow-hidden"
      in:fade={{ duration: 180 }}
      out:fade={{ duration: 180 }}
      on:outroend={onDetailPaneOutroEnd}
    >
      <div class="flex items-center justify-between gap-2">
        <h3 class="text-base font-bold ui-text-strong">{$t('admin.edits.detailTitle')}</h3>
        <UiButton
          type="button"
          variant="secondary"
          size="close"
          aria-label={$t('admin.edits.closeDetail')}
          onclick={() => closeEditPanel()}
          ><svg class="ui-close-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true"
            ><path d="M6 6L18 18" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" /><path
              d="M18 6L6 18"
              stroke="currentColor"
              stroke-width="2.25"
              stroke-linecap="round"
            /></svg
          ></UiButton
        >
      </div>

      {#if detailLoading}
        <p class="text-sm ui-text-subtle">{$t('admin.loading')}</p>
      {:else if !selectedEdit}
        <p class="text-sm ui-text-subtle">{$t('admin.edits.selectHint')}</p>
      {:else}
        {@const selectedStatusMeta = getStatusBadgeMeta(selectedEdit.status, translateNow)}
        <p class="flex flex-wrap items-center gap-2 text-sm ui-text-muted">
          <span>ID: {selectedEdit.editId || selectedEdit.id} | {selectedEdit.osmType}/{selectedEdit.osmId}</span>
          <span class="badge-pill rounded-full px-2.5 py-1 text-xs font-semibold {selectedStatusMeta.cls}"
            >{selectedStatusMeta.text}</span
          >
          {#if selectedEdit.syncStatus && selectedEdit.syncStatus !== 'unsynced'}
            {@const syncMeta = getSyncBadgeMeta(selectedEdit.syncStatus)}
            <span class={`badge-pill rounded-full px-2.5 py-1 text-xs font-semibold ${syncMeta.cls}`}>{syncMeta.text}</span>
          {/if}
        </p>

        {#if selectedEdit.syncStatus && selectedEdit.syncStatus !== 'unsynced'}
          <div class="space-y-1 rounded-xl border ui-border ui-surface-muted p-3 text-sm ui-text-body">
            <p><strong>{$t('admin.edits.syncStatus')}:</strong> {getSyncBadgeMeta(selectedEdit.syncStatus).text}</p>
            <p><strong>{$t('admin.edits.syncAttemptedAt')}:</strong> {formatUiDate(selectedEdit.syncAttemptedAt) || '---'}</p>
            <p><strong>{$t('admin.edits.syncSucceededAt')}:</strong> {formatUiDate(selectedEdit.syncSucceededAt) || '---'}</p>
            <p><strong>{$t('admin.edits.syncCleanedAt')}:</strong> {formatUiDate(selectedEdit.syncCleanedAt) || '---'}</p>
            <p><strong>{$t('admin.edits.syncChangeset')}:</strong> {selectedEdit.syncChangesetId || '---'}</p>
            {#if selectedEdit.syncSummary}
              <p class="text-xs ui-text-subtle break-words">{JSON.stringify(selectedEdit.syncSummary)}</p>
            {/if}
            {#if selectedEdit.syncError}
              <p class="text-xs ui-text-danger break-words">{selectedEdit.syncError}</p>
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
          <div class="space-y-2 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
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

        <UiScrollArea
          className="max-h-[42vh] rounded-xl border ui-border"
          contentClassName="space-y-2 p-2"
        >
          {#if !Array.isArray(selectedEdit.changes) || selectedEdit.changes.length === 0}
            <p class="text-sm ui-text-subtle">{$t('admin.edits.noChanges')}</p>
          {:else}
            {#each selectedEdit.changes as change (`${change.field}`)}
              <div class="rounded-lg border ui-border ui-surface-muted p-2">
                <div class="mb-1 flex items-center justify-between gap-2">
                  <p class="text-sm font-semibold ui-text-strong">{change.label || change.field}</p>
                  {#if !selectedEditIsReadOnly}
                    <div class="flex items-center gap-1">
                      <UiButton
                        type="button"
                        size="xs"
                        variant={fieldDecisions[change.field] !== 'reject' ? 'primary' : 'secondary'}
                        onclick={() => (fieldDecisions = { ...fieldDecisions, [change.field]: 'accept' })}
                        >{$t('admin.edits.accept')}</UiButton
                      >
                      <UiButton
                        type="button"
                        size="xs"
                        variant={fieldDecisions[change.field] === 'reject' ? 'primary' : 'secondary'}
                        onclick={() => (fieldDecisions = { ...fieldDecisions, [change.field]: 'reject' })}
                        >{$t('admin.edits.reject')}</UiButton
                      >
                    </div>
                  {/if}
                </div>
                <p class="text-xs ui-text-muted">
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
        </UiScrollArea>

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
                  onclick={reassignSelectedEdit}>{$t('admin.edits.reassignAction')}</UiButton
                >
              </div>
              <label class="flex items-center gap-2 text-xs ui-text-body"
                ><UiCheckbox bind:checked={reassignForce} />
                {$t('admin.edits.reassignForce')}</label
              >
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
                onclick={deleteSelectedEdit}>{$t('admin.edits.deleteAction')}</UiButton
              >
            </div>
          {/if}

          <div class="flex flex-wrap gap-2">
            <UiButton type="button" variant="secondary" onclick={() => setAll('accept')}
              >{$t('admin.edits.acceptAll')}</UiButton
            >
            <UiButton type="button" variant="secondary" onclick={() => setAll('reject')}
              >{$t('admin.edits.rejectAll')}</UiButton
            >
            <UiButton
              type="button"
              disabled={moderationBusy}
              onclick={() => applyDecision('apply')}>{$t('admin.edits.applyDecision')}</UiButton
            >
            <UiButton
              type="button"
              variant="danger"
              disabled={moderationBusy}
              onclick={() => applyDecision('reject')}>{$t('admin.edits.rejectEdit')}</UiButton
            >
          </div>
        {/if}

        {#if detailStatus}
          <p class="text-sm ui-text-muted">{detailStatus}</p>
        {/if}
      {/if}
    </section>
  {/if}
</div>
