<script>
  import { createEventDispatcher, onMount } from 'svelte';
  import { fade } from 'svelte/transition';

  import { t, translateNow } from '$lib/i18n/index';
  import { apiJson } from '$lib/services/http';
  import { getGeometryCenter } from '$lib/utils/map-geometry';
  import {
    formatUiDate,
    getChangeCounters,
    getEditAddress,
    getEditKey,
    getStatusBadgeMeta,
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
  let editsLoading = false;
  let editsStatus = translateNow('admin.loading');
  let editsError = '';
  let editsFilter = 'all';
  let editsLimit = 200;
  let editsQuery = '';
  let editsDate = '';
  let editsUser = '';
  let editsUsers = [];

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

  function normalizeEditId(value) {
    const numeric = Number(value || 0);
    return Number.isInteger(numeric) && numeric > 0 ? numeric : null;
  }

  function resetReassignDraft() {
    reassignTargetType = 'way';
    reassignTargetId = '';
    reassignForce = false;
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
    const date = String(editsDate || '').trim();
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
      const updatedAt = String(item?.updatedAt || '');
      if (query && !address.includes(query) && !osmKey.includes(query)) return false;
      if (date && !updatedAt.startsWith(date)) return false;
      if (user && author !== user) return false;
      if (status !== 'all' && String(item?.status || '').trim().toLowerCase() !== status) return false;
      return true;
    });

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
      editsStatus = visibleEdits.length
        ? translateNow('admin.edits.statusShown', { visible: visibleEdits.length, total: edits.length })
        : translateNow('admin.empty');
    }
  }

  $: dispatch('summary', { total: edits.length, visible: visibleEdits.length });

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

  $: adminPaneOpen = detailPaneVisible || detailLoading || Boolean(selectedEdit) || Boolean(detailStatus);

  onMount(() => {
    void loadEdits();
  });
</script>

<div
  class="mt-3 grid gap-4 overflow-x-hidden"
  class:lg:grid-cols-[1.1fr_1fr]={adminPaneOpen}
  class:lg:grid-cols-1={!adminPaneOpen}
>
  <section class="space-y-3 rounded-2xl border ui-border ui-surface-base p-3">
    <div class="grid gap-2 lg:grid-cols-[1.4fr_repeat(4,minmax(0,1fr))]">
      <input class="ui-field" type="search" placeholder={$t('admin.edits.search')} bind:value={editsQuery} />
      <input class="ui-field" type="date" bind:value={editsDate} />
      <select class="ui-field" bind:value={editsUser}
        ><option value="">{$t('admin.edits.userAll')}</option>{#each editsUsers as user (user)}<option value={user}
            >{user}</option
          >{/each}</select
      >
      <select class="ui-field ui-field-xs" bind:value={editsFilter}
        ><option value="all">{$t('admin.edits.statusAll')}</option><option value="pending"
          >{$t('admin.edits.statusPending')}</option
        ><option value="accepted">{$t('admin.edits.statusAccepted')}</option><option value="partially_accepted"
          >{$t('admin.edits.statusPartiallyAccepted')}</option
        ><option value="rejected">{$t('admin.edits.statusRejected')}</option><option value="superseded"
          >{$t('admin.edits.statusSuperseded')}</option
        ></select
      >
      <div class="flex gap-2">
        <select class="ui-field ui-field-xs" bind:value={editsLimit} on:change={loadEdits}
          ><option value={100}>100</option><option value={200}>200</option><option value={500}>500</option></select
        >
        <button type="button" class="ui-btn ui-btn-secondary ui-btn-xs" on:click={loadEdits}>{$t('common.refresh')}</button>
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

    <div class="overflow-x-auto rounded-xl border ui-border">
      <table class="min-w-full text-sm">
        <thead>
          <tr class="border-b ui-border text-left ui-text-muted">
            <th class="px-3 py-2">{$t('admin.edits.tableBuilding')}</th>
            <th class="px-3 py-2">{$t('admin.edits.tableAuthor')}</th>
            <th class="px-3 py-2">{$t('admin.edits.tableStatus')}</th>
            <th class="px-3 py-2">{$t('admin.edits.tableChanges')}</th>
          </tr>
        </thead>
        <tbody>
          {#if editsLoading}
            <tr><td colspan="4" class="px-3 py-3 ui-text-subtle">{$t('admin.loading')}</td></tr>
          {:else if visibleEdits.length === 0}
            <tr><td colspan="4" class="px-3 py-3 ui-text-subtle">{$t('admin.empty')}</td></tr>
          {:else}
            {#each visibleEdits as edit (`${edit.id || edit.editId}`)}
              {@const statusMeta = getStatusBadgeMeta(edit.status, translateNow)}
              {@const counters = getChangeCounters(edit.changes)}
              <tr class="cursor-pointer border-b ui-border-soft ui-hover-surface" on:click={() => openEdit(edit.id || edit.editId)}>
                <td class="px-3 py-2">
                  <p class="font-semibold ui-text-strong">{getEditAddress(edit)}</p>
                  <p class="text-xs ui-text-subtle">ID: {edit.osmType}/{edit.osmId}</p>
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
                  </div>
                </td>
                <td class="px-3 py-2">{edit.updatedBy || '-'}</td>
                <td class="px-3 py-2"
                  ><span class="badge-pill rounded-full px-2.5 py-1 text-xs font-semibold {statusMeta.cls}"
                    >{statusMeta.text}</span
                  ></td
                >
                <td class="px-3 py-2">
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
                </td>
              </tr>
            {/each}
          {/if}
        </tbody>
      </table>
    </div>
  </section>

  {#if detailPaneVisible}
    <section
      class="space-y-3 rounded-2xl border ui-border ui-surface-base p-3"
      in:fade={{ duration: 180 }}
      out:fade={{ duration: 180 }}
      on:outroend={onDetailPaneOutroEnd}
    >
      <div class="flex items-center justify-between gap-2">
        <h3 class="text-base font-bold ui-text-strong">{$t('admin.edits.detailTitle')}</h3>
        <button
          type="button"
          class="ui-btn ui-btn-secondary ui-btn-xs ui-btn-close"
          aria-label={$t('admin.edits.closeDetail')}
          on:click={() => closeEditPanel()}
          ><svg class="ui-close-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true"
            ><path d="M6 6L18 18" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" /><path
              d="M18 6L6 18"
              stroke="currentColor"
              stroke-width="2.25"
              stroke-linecap="round"
            /></svg
          ></button
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
        </p>

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

        <div class="max-h-[42vh] space-y-2 overflow-auto rounded-xl border ui-border p-2">
          {#if !Array.isArray(selectedEdit.changes) || selectedEdit.changes.length === 0}
            <p class="text-sm ui-text-subtle">{$t('admin.edits.noChanges')}</p>
          {:else}
            {#each selectedEdit.changes as change (`${change.field}`)}
              <div class="rounded-lg border ui-border ui-surface-muted p-2">
                <div class="mb-1 flex items-center justify-between gap-2">
                  <p class="text-sm font-semibold ui-text-strong">{change.label || change.field}</p>
                  <div class="flex items-center gap-1">
                    <button
                      type="button"
                      class="ui-btn ui-btn-xs"
                      class:ui-btn-primary={fieldDecisions[change.field] !== 'reject'}
                      class:ui-btn-secondary={fieldDecisions[change.field] === 'reject'}
                      on:click={() => (fieldDecisions = { ...fieldDecisions, [change.field]: 'accept' })}
                      >{$t('admin.edits.accept')}</button
                    >
                    <button
                      type="button"
                      class="ui-btn ui-btn-xs"
                      class:ui-btn-primary={fieldDecisions[change.field] === 'reject'}
                      class:ui-btn-secondary={fieldDecisions[change.field] !== 'reject'}
                      on:click={() => (fieldDecisions = { ...fieldDecisions, [change.field]: 'reject' })}
                      >{$t('admin.edits.reject')}</button
                    >
                  </div>
                </div>
                <p class="text-xs ui-text-muted">
                  <span class="line-through">{String(change.osmValue ?? $t('admin.edits.emptyValue'))}</span> ->
                  <strong>{String(change.localValue ?? $t('admin.edits.emptyValue'))}</strong>
                </p>
                {#if fieldDecisions[change.field] !== 'reject'}
                  <input
                    class="ui-field mt-2"
                    value={fieldValues[change.field] ?? ''}
                    on:input={(event) => (fieldValues = { ...fieldValues, [change.field]: event.currentTarget.value })}
                  />
                {/if}
              </div>
            {/each}
          {/if}
        </div>

        <textarea
          class="ui-field min-h-[84px]"
          placeholder={$t('admin.edits.moderatorComment')}
          bind:value={moderationComment}
        ></textarea>

        {#if selectedEdit.canReassign}
          <div class="space-y-2 rounded-xl border ui-border ui-surface-muted p-3">
            <p class="text-sm font-semibold ui-text-strong">{$t('admin.edits.reassignTitle')}</p>
            <p class="text-xs ui-text-muted">{$t('admin.edits.reassignHelp')}</p>
            <div class="grid gap-2 sm:grid-cols-[120px_1fr_auto]">
              <select class="ui-field" bind:value={reassignTargetType}>
                <option value="way">way</option>
                <option value="relation">relation</option>
              </select>
              <input
                class="ui-field"
                type="number"
                min="1"
                bind:value={reassignTargetId}
                placeholder={$t('admin.edits.reassignTargetId')}
              />
              <button
                type="button"
                class="ui-btn ui-btn-secondary"
                disabled={moderationBusy}
                on:click={reassignSelectedEdit}>{$t('admin.edits.reassignAction')}</button
              >
            </div>
            <label class="flex items-center gap-2 text-xs ui-text-body"
              ><input type="checkbox" bind:checked={reassignForce} />
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
            <button
              type="button"
              class="ui-btn ui-btn-danger"
              disabled={moderationBusy || !selectedEdit.canHardDelete}
              on:click={deleteSelectedEdit}>{$t('admin.edits.deleteAction')}</button
            >
          </div>
        {/if}

        <div class="flex flex-wrap gap-2">
          <button type="button" class="ui-btn ui-btn-secondary" on:click={() => setAll('accept')}
            >{$t('admin.edits.acceptAll')}</button
          >
          <button type="button" class="ui-btn ui-btn-secondary" on:click={() => setAll('reject')}
            >{$t('admin.edits.rejectAll')}</button
          >
          <button
            type="button"
            class="ui-btn ui-btn-primary"
            disabled={moderationBusy}
            on:click={() => applyDecision('apply')}>{$t('admin.edits.applyDecision')}</button
          >
          <button
            type="button"
            class="ui-btn ui-btn-danger"
            disabled={moderationBusy}
            on:click={() => applyDecision('reject')}>{$t('admin.edits.rejectEdit')}</button
          >
        </div>

        {#if detailStatus}
          <p class="text-sm ui-text-muted">{detailStatus}</p>
        {/if}
      {/if}
    </section>
  {/if}
</div>
