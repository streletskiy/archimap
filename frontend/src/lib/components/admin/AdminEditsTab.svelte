<script>
  import { createEventDispatcher, onMount } from 'svelte';

  import {
    UiButton,
    UiCheckbox,
    UiScrollArea,
    UiTable,
    UiTableBody,
    UiTableCell,
    UiTableHead,
    UiTableHeader,
    UiTableRow
  } from '$lib/components/base';
  import { t, translateNow } from '$lib/i18n/index';
  import { apiJson } from '$lib/services/http';
  import { getGeometryCenter } from '$lib/utils/map-geometry';
  import {
    getEditAddress,
    getEditKey,
    matchesUiDateRange,
    parseEditKey
  } from '$lib/utils/edit-ui';

  import AdminMap from './AdminMap.svelte';
  import EditDetailPane from './EditDetailPane.svelte';
  import EditListFilters from './EditListFilters.svelte';
  import EditListItem from './EditListItem.svelte';

  export let requestedEditId = null;
  export let isMasterAdmin = false;

  const EMPTY_FEATURE_COLLECTION = { type: 'FeatureCollection', features: [] };
  const dispatch = createEventDispatcher();
  const msg = (error, fallback) => String(error?.message || fallback);

  let edits = [];
  let visibleEdits;
  let activeEdits;
  let syncedEdits;
  let editsLoading = false;
  let editsStatus;
  let editsError = '';
  let editsFilter = 'all';
  let editsLimit = 200;
  let editsQuery = '';
  let editsDateRange = undefined;
  let editsUser = '';
  let editsUsers = [];
  let editsUserItems;
  let editsFilterItems;
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
  let bulkModerationBusy = false;
  let selectedEditIds = [];
  let bulkSelectableEdits = [];
  let selectedBulkEdits = [];
  let showBulkSelection = false;
  let reassignTargetType = 'way';
  let reassignTargetId = '';
  let reassignForce = false;
  let previousRequestedEditId;

  let centerByKey = new Map();
  let editIdByKey;

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

  function getEditId(item) {
    return normalizeEditId(item?.id || item?.editId);
  }

  function isPendingEdit(item) {
    return String(item?.status || '').trim().toLowerCase() === 'pending' && !isSyncedArchiveEdit(item);
  }

  function resolveSelectedEdits(sourceEdits = activeEdits, selectedIds = selectedEditIds) {
    if (!Array.isArray(sourceEdits) || !Array.isArray(selectedIds) || selectedIds.length === 0) {
      return [];
    }
    const selected = new Set(selectedIds.map((id) => normalizeEditId(id)).filter(Boolean));
    return sourceEdits.filter((item) => selected.has(getEditId(item)) && isPendingEdit(item));
  }

  function resetReassignDraft() {
    reassignTargetType = 'way';
    reassignTargetId = '';
    reassignForce = false;
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

  function pruneSelectedEdits() {
    if (!Array.isArray(selectedEditIds) || selectedEditIds.length === 0) {
      return;
    }
    const allowedIds = new Set(bulkSelectableEdits.map((item) => getEditId(item)).filter(Boolean));
    const nextSelected = selectedEditIds
      .map((id) => normalizeEditId(id))
      .filter((id) => id && allowedIds.has(id));
    const changed = nextSelected.length !== selectedEditIds.length || nextSelected.some((id, index) => id !== selectedEditIds[index]);
    if (changed) {
      selectedEditIds = nextSelected;
    }
  }

  function toggleEditSelection(edit, checked) {
    if (bulkModerationBusy || moderationBusy) return;
    const editId = getEditId(edit);
    if (!editId || !isPendingEdit(edit)) return;
    if (checked) {
      if (!selectedEditIds.includes(editId)) {
        selectedEditIds = [...selectedEditIds, editId];
      }
      return;
    }
    selectedEditIds = selectedEditIds.filter((item) => item !== editId);
  }

  function selectAllPendingEdits() {
    if (bulkModerationBusy || moderationBusy) return;
    selectedEditIds = bulkSelectableEdits.map((item) => getEditId(item)).filter(Boolean);
  }

  function clearSelectedEdits() {
    if (bulkModerationBusy || moderationBusy) return;
    selectedEditIds = [];
  }

  async function refreshCurrentEditDetails() {
    const currentId = normalizeEditId(selectedEdit?.editId || selectedEdit?.id);
    if (!currentId) return;
    await openEdit(currentId, { syncUrl: false, forceReload: true });
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
    const { syncUrl = true, forceReload = false } = options;
    const numericEditId = normalizeEditId(editId);
    if (!numericEditId) return;

    const currentId = normalizeEditId(selectedEdit?.editId || selectedEdit?.id);
    if (!forceReload && detailPaneVisible && currentId === numericEditId && !detailLoading) {
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

  async function bulkAcceptSelectedEdits() {
    if (bulkModerationBusy || moderationBusy || selectedBulkEdits.length === 0) return;

    bulkModerationBusy = true;
    editsStatus = translateNow('admin.edits.bulkAccepting');
    try {
      const editIds = selectedBulkEdits.map((item) => getEditId(item)).filter(Boolean);
      const response = await apiJson('/api/admin/building-edits/bulk-merge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ editIds })
      });
      const summary = response?.item || {};
      const successCount = Number(summary?.successCount || 0);
      const failureCount = Number(summary?.failureCount || 0);
      const totalCount = Number(summary?.totalCount || editIds.length);

      selectedEditIds = [];
      await loadEdits();
      await refreshCurrentEditDetails();

      if (successCount > 0 && failureCount > 0) {
        editsStatus = translateNow('admin.edits.bulkAcceptedPartial', {
          accepted: successCount,
          total: totalCount,
          failed: failureCount
        });
      } else if (successCount > 0) {
        editsStatus = translateNow('admin.edits.bulkAccepted', { count: successCount });
      } else {
        editsStatus = translateNow('admin.edits.bulkAcceptFailed');
      }
    } catch (error) {
      editsStatus = msg(error, translateNow('admin.edits.bulkAcceptFailed'));
    } finally {
      bulkModerationBusy = false;
    }
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
      await openEdit(editId, { syncUrl: false, forceReload: true });
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
      await openEdit(editId, { syncUrl: false, forceReload: true });
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

  $: bulkSelectableEdits = Array.isArray(activeEdits) ? activeEdits.filter(isPendingEdit) : [];
  $: selectedBulkEdits = resolveSelectedEdits(bulkSelectableEdits, selectedEditIds);
  $: showBulkSelection = bulkSelectableEdits.length > 0 || selectedBulkEdits.length > 0 || bulkModerationBusy;
  $: pruneSelectedEdits();

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
    void previousRequestedEditId;
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
    <EditListFilters
      bind:editsQuery
      bind:editsDateRange
      bind:editsUser
      bind:editsFilter
      bind:editsLimit
      {editsUserItems}
      {editsFilterItems}
      {editsLimitItems}
      loading={editsLoading}
      onRefresh={loadEdits}
    />

    <p class="text-sm ui-text-muted">{editsStatus}</p>

    {#if showBulkSelection}
      <div class="flex flex-wrap items-center gap-2 rounded-xl border ui-border ui-surface-base px-3 py-2 text-sm ui-text-body">
        <UiButton
          type="button"
          variant="secondary"
          size="xs"
          onclick={selectAllPendingEdits}
          disabled={bulkModerationBusy || moderationBusy || editsLoading || bulkSelectableEdits.length === 0}
        >
          {$t('admin.edits.bulkSelectAll')}
        </UiButton>
        <UiButton
          type="button"
          variant="secondary"
          size="xs"
          onclick={clearSelectedEdits}
          disabled={bulkModerationBusy || moderationBusy || editsLoading || selectedEditIds.length === 0}
        >
          {$t('admin.edits.bulkClearSelection')}
        </UiButton>
        <UiButton
          type="button"
          size="xs"
          onclick={bulkAcceptSelectedEdits}
          disabled={bulkModerationBusy || moderationBusy || editsLoading || selectedBulkEdits.length === 0}
        >
          {bulkModerationBusy ? $t('admin.edits.bulkAccepting') : $t('admin.edits.bulkAcceptSelected')}
        </UiButton>
        <span class="text-xs ui-text-subtle">{$t('admin.edits.bulkSelected', { count: selectedBulkEdits.length })}</span>
      </div>
    {/if}

    <AdminMap
      {visibleEdits}
      {centerByKey}
      {editIdByKey}
      {selectedFeature}
      on:openedit={(event) => openEdit(event.detail?.editId)}
    />

    <UiTable framed={false}>
      <UiTableHeader>
        <UiTableRow className="hover:[&>th]:bg-transparent">
          {#if showBulkSelection}
            <UiTableHead className="w-10">
              <UiCheckbox
                checked={bulkSelectableEdits.length > 0 && selectedBulkEdits.length === bulkSelectableEdits.length}
                indeterminate={selectedBulkEdits.length > 0 && selectedBulkEdits.length < bulkSelectableEdits.length}
                disabled={bulkSelectableEdits.length === 0 || bulkModerationBusy || moderationBusy || editsLoading}
                onchange={({ detail }) => (detail?.checked ? selectAllPendingEdits() : clearSelectedEdits())}
              />
            </UiTableHead>
          {/if}
          <UiTableHead>{$t('admin.edits.tableBuilding')}</UiTableHead>
          <UiTableHead>{$t('admin.edits.tableAuthor')}</UiTableHead>
          <UiTableHead>{$t('admin.edits.tableStatus')}</UiTableHead>
          <UiTableHead>{$t('admin.edits.tableChanges')}</UiTableHead>
        </UiTableRow>
      </UiTableHeader>
      <UiTableBody>
        {#if editsLoading}
          <UiTableRow>
            <UiTableCell colspan={showBulkSelection ? 5 : 4} className="ui-text-subtle">{$t('admin.loading')}</UiTableCell>
          </UiTableRow>
        {:else if activeEdits.length === 0}
          <UiTableRow>
            <UiTableCell colspan={showBulkSelection ? 5 : 4} className="ui-text-subtle">{$t('admin.empty')}</UiTableCell>
          </UiTableRow>
        {:else}
          {#each activeEdits as edit (`${edit.id || edit.editId}`)}
            <EditListItem
              edit={edit}
              selected={selectedEditIds.includes(getEditId(edit))}
              selectable={isPendingEdit(edit)}
              selectionBusy={bulkModerationBusy || moderationBusy || editsLoading}
              showSelection={showBulkSelection}
              onOpen={openEdit}
              onToggleSelection={toggleEditSelection}
            />
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
          <UiScrollArea className="ui-scroll-surface max-h-72 rounded-xl" contentClassName="space-y-2 p-2">
            <UiTable framed={false}>
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
                  <EditListItem edit={edit} archived onOpen={openEdit} />
                {/each}
              </UiTableBody>
            </UiTable>
          </UiScrollArea>
        </div>
      </details>
    {/if}
  </section>

  {#if detailPaneVisible}
    <EditDetailPane
      bind:fieldDecisions
      bind:fieldValues
      bind:moderationComment
      bind:reassignTargetType
      bind:reassignTargetId
      bind:reassignForce
      {selectedEdit}
      {detailLoading}
      {detailStatus}
      {selectedEditIsReadOnly}
      {isMasterAdmin}
      {reassignTargetTypeItems}
      {moderationBusy}
      onClose={closeEditPanel}
      onOutroEnd={onDetailPaneOutroEnd}
      setAll={setAll}
      applyDecision={applyDecision}
      reassignSelectedEdit={reassignSelectedEdit}
      deleteSelectedEdit={deleteSelectedEdit}
    />
  {/if}
</div>
