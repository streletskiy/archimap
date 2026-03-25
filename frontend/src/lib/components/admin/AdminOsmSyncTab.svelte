<script>
  import { createEventDispatcher, onMount } from 'svelte';

  import {
    UiBadge,
    UiButton,
    UiCheckbox,
    UiInput,
    UiScrollArea,
    UiTable,
    UiTableBody,
    UiTableHead,
    UiTableHeader,
    UiTableRow
  } from '$lib/components/base';
  import { apiJson } from '$lib/services/http';
  import { t, translateNow } from '$lib/i18n/index';
  import SyncCandidateCard from './SyncCandidateCard.svelte';
  import SyncCandidateDetailPane from './SyncCandidateDetailPane.svelte';

  export let isMasterAdmin = false;

  const dispatch = createEventDispatcher();

  let loading = false;
  let candidates = [];
  let selectedCandidate = null;
  let selectedCandidateDetail = null;
  let selectedCandidateKeys = [];
  let statusText = translateNow('admin.osm.loading');
  let settingsStatus = '';
  let saveBusy = false;
  let connectBusy = false;
  let syncBusy = false;
  let detailBusy = false;
  let settings = null;
  let activeCandidates = [];
  let archivedCandidates = [];
  let syncableCandidates = [];
  let selectedSyncCandidates = [];

  let draft = {
    providerName: 'OpenStreetMap',
    authBaseUrl: 'https://www.openstreetmap.org',
    apiBaseUrl: 'https://api.openstreetmap.org',
    clientId: '',
    clientSecret: '',
    redirectUri: ''
  };

  function message(error, fallback) {
    return String(error?.message || fallback);
  }

  function candidateKey(candidate) {
    return candidate ? `${candidate.osmType}/${candidate.osmId}` : '';
  }

  function isArchivedCandidate(candidate) {
    const normalized = String(candidate?.syncStatus || 'unsynced').trim().toLowerCase();
    return normalized === 'synced' || normalized === 'cleaned';
  }

  function isOsmConnected() {
    return Boolean(settings?.osm?.hasAccessToken);
  }

  function canSyncCandidate(candidate) {
    return isOsmConnected() && Boolean(candidate?.canSync) && !isArchivedCandidate(candidate);
  }

  function canStartOsmOAuth() {
    const clientId = String(draft.clientId || settings?.osm?.clientId || '').trim();
    const clientSecret = String(draft.clientSecret || '').trim() || Boolean(settings?.osm?.hasClientSecret);
    const redirectUri = String(draft.redirectUri || settings?.oauth?.redirectUri || settings?.osm?.redirectUri || '').trim();
    return Boolean(clientId && clientSecret && redirectUri);
  }

  function selectedCount() {
    return selectedCandidateKeys.length;
  }

  function setSelectedCandidates(items) {
    selectedCandidateKeys = [...new Set((Array.isArray(items) ? items : []).map(candidateKey).filter(Boolean))];
  }

  function pruneSelectedCandidates() {
    const allowedKeys = new Set(syncableCandidates.map(candidateKey));
    const next = selectedCandidateKeys.filter((key) => allowedKeys.has(key));
    if (next.length === selectedCandidateKeys.length && next.every((key, index) => key === selectedCandidateKeys[index])) {
      return;
    }
    selectedCandidateKeys = next;
  }

  function toggleCandidateSelection(candidate, checked) {
    const key = candidateKey(candidate);
    if (!key) return;
    if (checked) {
      if (!selectedCandidateKeys.includes(key)) {
        selectedCandidateKeys = [...selectedCandidateKeys, key];
      }
      return;
    }
    selectedCandidateKeys = selectedCandidateKeys.filter((item) => item !== key);
  }

  function selectAllCandidates() {
    setSelectedCandidates(syncableCandidates);
  }

  function clearSelection() {
    selectedCandidateKeys = [];
  }

  function resolveSelectedSyncCandidates(sourceCandidates = candidates, selectedKeys = selectedCandidateKeys) {
    if (!Array.isArray(sourceCandidates) || !Array.isArray(selectedKeys) || selectedKeys.length === 0) {
      return [];
    }
    const selected = new Set(selectedKeys);
    return sourceCandidates.filter((item) => selected.has(candidateKey(item)) && canSyncCandidate(item));
  }

  function snapshotSettings(item) {
    settings = item || null;
    const osm = item?.osm || {};
    draft = {
      providerName: osm.providerName || 'OpenStreetMap',
      authBaseUrl: osm.authBaseUrl || 'https://www.openstreetmap.org',
      apiBaseUrl: osm.apiBaseUrl || 'https://api.openstreetmap.org',
      clientId: osm.clientId || '',
      clientSecret: '',
      redirectUri: osm.redirectUri || ''
    };
  }

  async function loadState() {
    loading = true;
    statusText = translateNow('admin.osm.loading');
    try {
      const [settingsResponse, candidatesResponse] = await Promise.all([
        apiJson('/api/admin/app-settings/osm'),
        apiJson('/api/admin/osm-sync/candidates?limit=200')
      ]);
      snapshotSettings(settingsResponse?.item || null);
      candidates = Array.isArray(candidatesResponse?.items) ? candidatesResponse.items : [];
      activeCandidates = candidates.filter((item) => !isArchivedCandidate(item));
      archivedCandidates = candidates.filter((item) => isArchivedCandidate(item));
      syncableCandidates = activeCandidates.filter((item) => canSyncCandidate(item));
      pruneSelectedCandidates();
      statusText = activeCandidates.length
        ? translateNow('admin.osm.status.loaded', { count: activeCandidates.length })
        : translateNow('admin.osm.status.empty');
    } catch (error) {
      candidates = [];
      activeCandidates = [];
      archivedCandidates = [];
      syncableCandidates = [];
      statusText = message(error, translateNow('admin.osm.status.loadFailed'));
    } finally {
      loading = false;
      dispatch('summary', { total: activeCandidates.length, archived: archivedCandidates.length });
    }
  }

  async function saveSettings() {
    if (!isMasterAdmin || saveBusy) return;
    saveBusy = true;
    settingsStatus = translateNow('admin.osm.status.saving');
    try {
      const payload = { ...draft };
      if (!String(payload.clientSecret || '').trim()) {
        delete payload.clientSecret;
      }
      const response = await apiJson('/api/admin/app-settings/osm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ osm: payload })
      });
      snapshotSettings(response?.item || null);
      settingsStatus = translateNow('admin.osm.status.saved');
    } catch (error) {
      settingsStatus = message(error, translateNow('admin.osm.status.saveFailed'));
    } finally {
      saveBusy = false;
    }
  }

  async function startOAuth() {
    if (!isMasterAdmin || connectBusy) return;
    connectBusy = true;
    settingsStatus = translateNow('admin.osm.status.connecting');
    try {
      await saveSettings();
      const response = await apiJson('/api/admin/app-settings/osm/oauth/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ osm: {
          ...draft,
          clientSecret: String(draft.clientSecret || '').trim() ? draft.clientSecret : undefined
        } })
      });
      const authorizeUrl = String(response?.item?.authorizeUrl || '').trim();
      if (!authorizeUrl) {
        throw new Error(translateNow('admin.osm.status.connectFailed'));
      }
      if (typeof window !== 'undefined') {
        window.location.href = authorizeUrl;
      }
    } catch (error) {
      settingsStatus = message(error, translateNow('admin.osm.status.connectFailed'));
    } finally {
      connectBusy = false;
    }
  }

  async function loadCandidate(candidate) {
    selectedCandidate = candidate || null;
    selectedCandidateDetail = null;
    if (!candidate) return;
    detailBusy = true;
    try {
      const response = await apiJson(`/api/admin/osm-sync/candidates/${encodeURIComponent(candidate.osmType)}/${encodeURIComponent(candidate.osmId)}`);
      selectedCandidateDetail = response?.item || null;
    } catch (error) {
      selectedCandidateDetail = {
        preflightError: message(error, translateNow('admin.osm.status.detailLoadFailed'))
      };
    } finally {
      detailBusy = false;
    }
  }

  async function syncCandidate(candidate) {
    if (!isMasterAdmin || syncBusy || !candidate || !canSyncCandidate(candidate)) return;
    syncBusy = true;
    settingsStatus = translateNow('admin.osm.status.syncing');
    try {
      const response = await apiJson(`/api/admin/osm-sync/candidates/${encodeURIComponent(candidate.osmType)}/${encodeURIComponent(candidate.osmId)}/sync`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      });
      settingsStatus = response?.item?.noChange
        ? translateNow('admin.osm.status.syncedNoChange')
        : translateNow('admin.osm.status.synced');
      await loadState();
      if (selectedCandidate?.osmType === candidate.osmType && selectedCandidate?.osmId === candidate.osmId) {
        await loadCandidate(candidate);
      }
    } catch (error) {
      settingsStatus = message(error, translateNow('admin.osm.status.syncFailed'));
      await loadState();
      if (selectedCandidate?.osmType === candidate.osmType && selectedCandidate?.osmId === candidate.osmId) {
        await loadCandidate(candidate);
      }
    } finally {
      syncBusy = false;
    }
  }

  async function syncSelectedCandidates() {
    if (!isMasterAdmin || syncBusy || selectedCandidateKeys.length === 0) return;
    if (!isOsmConnected()) {
      settingsStatus = translateNow('admin.osm.list.syncRequiresConnection');
      return;
    }
    const selectedItems = selectedSyncCandidates;
    if (selectedItems.length === 0) {
      settingsStatus = translateNow('admin.osm.list.selectedNotSyncable');
      return;
    }

    syncBusy = true;
    settingsStatus = translateNow('admin.osm.status.syncing');
    try {
      const response = await apiJson('/api/admin/osm-sync/candidates/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          items: selectedItems.map((item) => ({ osmType: item.osmType, osmId: item.osmId }))
        })
      });
      const summary = response?.item?.summary || {};
      settingsStatus = Number(summary?.syncedCount || 0) > 0
        ? translateNow('admin.osm.status.synced')
        : translateNow('admin.osm.status.syncedNoChange');
      clearSelection();
      await loadState();
      if (selectedCandidate) {
        await loadCandidate(selectedCandidate);
      }
    } catch (error) {
      settingsStatus = message(error, translateNow('admin.osm.status.syncFailed'));
      await loadState();
      if (selectedCandidate) {
        await loadCandidate(selectedCandidate);
      }
    } finally {
      syncBusy = false;
    }
  }

  $: activeCandidates = candidates.filter((item) => !isArchivedCandidate(item));
  $: archivedCandidates = candidates.filter((item) => isArchivedCandidate(item));
  $: syncableCandidates = activeCandidates.filter((item) => canSyncCandidate(item));
  $: selectedSyncCandidates = resolveSelectedSyncCandidates(candidates, selectedCandidateKeys);
  $: pruneSelectedCandidates();
  $: dispatch('summary', { total: activeCandidates.length, archived: archivedCandidates.length });

  onMount(() => {
    void loadState();
  });
</script>

<section class="mt-3 flex flex-col space-y-4 rounded-2xl border ui-border ui-surface-base p-4 min-w-0 min-h-0 overflow-hidden">
  <div class="flex flex-wrap items-start justify-between gap-3">
    <div class="space-y-1">
      <h3 class="text-base font-bold ui-text-strong">{$t('admin.osm.title')}</h3>
      <p class="text-sm ui-text-muted">{$t('admin.osm.subtitle')}</p>
    </div>
    <div class="flex flex-wrap gap-2">
      <UiButton type="button" variant="secondary" size="xs" onclick={loadState} disabled={loading || saveBusy || connectBusy || syncBusy}>
        {$t('common.refresh')}
      </UiButton>
      {#if isMasterAdmin}
        <UiButton type="button" variant="secondary" size="xs" onclick={startOAuth} disabled={connectBusy || saveBusy || syncBusy || !canStartOsmOAuth()}>
          {$t('admin.osm.connect')}
        </UiButton>
      {/if}
    </div>
  </div>

  <div class="grid gap-3 lg:grid-cols-3">
    <article class="osm-summary-card rounded-xl p-3 text-sm ui-text-body lg:col-span-2">
      <div class="flex flex-wrap items-center gap-2">
        <UiBadge variant={settings?.osm?.hasAccessToken ? 'success' : 'default'}>
          {settings?.osm?.hasAccessToken ? $t('admin.osm.connected') : $t('admin.osm.disconnected')}
        </UiBadge>
        <UiBadge variant="default">
          <strong>{$t('admin.osm.count')}</strong>{activeCandidates.length}
        </UiBadge>
      </div>
      {#if settings?.osm?.connectedUser}
        <p class="mt-2 text-xs ui-text-subtle break-words">{settings.osm.connectedUser}</p>
      {/if}
      <p class="mt-1 text-xs ui-text-subtle break-words">{settings?.oauth?.redirectUri || draft.redirectUri || '---'}</p>
      {#if settings && !isOsmConnected() && !canStartOsmOAuth()}
        <p class="mt-2 text-xs ui-text-warning">{$t('admin.osm.list.connectConfigMissing')}</p>
      {/if}
      {#if settingsStatus}
        <p class="mt-2 text-sm ui-text-muted">{settingsStatus}</p>
      {/if}
    </article>
    <article class="osm-summary-card rounded-xl p-3 text-sm ui-text-body">
      <p><strong>{$t('admin.osm.settings.providerName')}:</strong> {settings?.osm?.providerName || '---'}</p>
      <p><strong>{$t('admin.osm.settings.authBaseUrl')}:</strong> {settings?.osm?.authBaseUrl || '---'}</p>
      <p><strong>{$t('admin.osm.settings.apiBaseUrl')}:</strong> {settings?.osm?.apiBaseUrl || '---'}</p>
      <p><strong>{$t('admin.osm.settings.clientId')}:</strong> {settings?.osm?.clientId || '---'}</p>
    </article>
  </div>

  {#if isMasterAdmin}
    <section class="osm-form-card space-y-3 rounded-2xl p-4">
      <div class="flex items-center justify-between gap-2">
        <h4 class="text-base font-bold ui-text-strong">{$t('admin.osm.settings.title')}</h4>
        <span class="text-xs ui-text-subtle">{settings?.osm?.updatedAt || '---'}</span>
      </div>
      <div class="grid gap-3 md:grid-cols-2">
        <label class="space-y-1 text-sm ui-text-body">
          <span>{$t('admin.osm.settings.providerName')}</span>
          <UiInput bind:value={draft.providerName} />
        </label>
        <label class="space-y-1 text-sm ui-text-body">
          <span>{$t('admin.osm.settings.clientId')}</span>
          <UiInput bind:value={draft.clientId} />
        </label>
        <label class="space-y-1 text-sm ui-text-body">
          <span>{$t('admin.osm.settings.clientSecret')}</span>
          <UiInput type="password" bind:value={draft.clientSecret} placeholder={$t('admin.osm.settings.clientSecretPlaceholder')} />
        </label>
        <label class="space-y-1 text-sm ui-text-body">
          <span>{$t('admin.osm.settings.redirectUri')}</span>
          <UiInput bind:value={draft.redirectUri} />
        </label>
        <label class="space-y-1 text-sm ui-text-body">
          <span>{$t('admin.osm.settings.authBaseUrl')}</span>
          <UiInput bind:value={draft.authBaseUrl} />
        </label>
        <label class="space-y-1 text-sm ui-text-body">
          <span>{$t('admin.osm.settings.apiBaseUrl')}</span>
          <UiInput bind:value={draft.apiBaseUrl} />
        </label>
      </div>
      <div class="flex flex-wrap gap-2">
        <UiButton type="button" onclick={saveSettings} disabled={saveBusy || connectBusy || loading}>
          {saveBusy ? $t('admin.osm.settings.saving') : $t('admin.osm.settings.save')}
        </UiButton>
        <UiButton type="button" variant="secondary" onclick={startOAuth} disabled={connectBusy || saveBusy || loading || !canStartOsmOAuth()}>
          {connectBusy ? $t('admin.osm.settings.connecting') : $t('admin.osm.connect')}
        </UiButton>
      </div>
      {#if !isOsmConnected() && !canStartOsmOAuth()}
        <p class="text-xs ui-text-warning">{$t('admin.osm.list.connectConfigMissing')}</p>
      {/if}
    </section>
  {:else}
    <p class="text-sm ui-text-muted">{$t('admin.osm.masterOnly')}</p>
  {/if}

  <section class="space-y-3 min-w-0">
    <div class="flex items-center justify-between gap-2">
      <h4 class="text-sm font-semibold uppercase tracking-wide ui-text-muted">{$t('admin.osm.list.title')}</h4>
      <span class="text-xs ui-text-subtle">{selectedCount() ? `${selectedCount()} / ` : ''}{activeCandidates.length}</span>
    </div>

    {#if isMasterAdmin && activeCandidates.length > 0}
      <div class="flex flex-wrap items-center gap-2 rounded-xl border ui-border ui-surface-base px-3 py-2 text-sm ui-text-body">
        <UiButton type="button" variant="secondary" size="xs" onclick={selectAllCandidates} disabled={syncBusy || loading}>
          {$t('admin.osm.list.selectAll')}
        </UiButton>
      <UiButton type="button" variant="secondary" size="xs" onclick={clearSelection} disabled={syncBusy || loading || selectedCandidateKeys.length === 0}>
        {$t('admin.osm.list.clearSelection')}
      </UiButton>
      <UiButton type="button" size="xs" onclick={syncSelectedCandidates} disabled={syncBusy || loading || !isOsmConnected() || selectedSyncCandidates.length === 0}>
        {syncBusy ? $t('admin.osm.status.syncingState') : $t('admin.osm.list.syncSelected')}
      </UiButton>
      <span class="text-xs ui-text-subtle">{$t('admin.osm.list.selected', { count: selectedCandidateKeys.length })}</span>
      {#if !isOsmConnected() && activeCandidates.length > 0}
        <span class="text-xs ui-text-warning">{$t('admin.osm.list.syncRequiresConnection')}</span>
      {/if}
      {#if selectedCandidateKeys.length > 0 && selectedSyncCandidates.length !== selectedCandidateKeys.length}
        <span class="text-xs ui-text-warning">{$t('admin.osm.list.selectedNotSyncable')}</span>
      {/if}
      {#if syncBusy || settingsStatus}
        <span class="text-xs ui-text-subtle">{syncBusy ? $t('admin.osm.status.syncing') : settingsStatus}</span>
      {/if}
    </div>
  {/if}

    {#if loading}
      <p class="osm-summary-card rounded-xl px-3 py-2 text-sm ui-text-subtle">{$t('admin.osm.loading')}</p>
    {:else if activeCandidates.length === 0}
      <p class="rounded-xl border border-dashed ui-border-strong px-3 py-4 text-sm ui-text-subtle">{$t('admin.osm.list.empty')}</p>
    {:else}
      <UiScrollArea className="ui-scroll-surface max-h-[32rem] rounded-xl" contentClassName="space-y-2 p-2">
        <UiTable framed={false}>
          <UiTableHeader>
            <UiTableRow className="hover:[&>th]:bg-transparent">
                {#if isMasterAdmin}
                  <UiTableHead className="w-10">
                    <UiCheckbox
                      checked={syncableCandidates.length > 0 && selectedCandidateKeys.length === syncableCandidates.length}
                      indeterminate={selectedCandidateKeys.length > 0 && selectedCandidateKeys.length < syncableCandidates.length}
                      disabled={syncableCandidates.length === 0}
                      onchange={({ detail }) => (detail?.checked ? selectAllCandidates() : clearSelection())}
                    />
                  </UiTableHead>
                {/if}
              <UiTableHead>{$t('admin.osm.list.building')}</UiTableHead>
              <UiTableHead>{$t('admin.osm.list.author')}</UiTableHead>
              <UiTableHead>{$t('admin.osm.list.syncState')}</UiTableHead>
              <UiTableHead>{$t('admin.osm.list.updated')}</UiTableHead>
              <UiTableHead>{$t('admin.osm.list.actions')}</UiTableHead>
            </UiTableRow>
          </UiTableHeader>
          <UiTableBody>
            {#each activeCandidates as item (`osm-sync-${item.osmType}-${item.osmId}`)}
              <SyncCandidateCard
                candidate={item}
                isMasterAdmin={isMasterAdmin}
                selected={selectedCandidateKeys.includes(candidateKey(item))}
                syncable={canSyncCandidate(item)}
                syncBusy={syncBusy}
                onOpen={loadCandidate}
                onSync={syncCandidate}
                onToggleSelection={toggleCandidateSelection}
              />
            {/each}
          </UiTableBody>
        </UiTable>
      </UiScrollArea>
    {/if}

    {#if !loading && archivedCandidates.length > 0}
      <details class="overflow-hidden rounded-xl border ui-border ui-surface-muted" open={false}>
        <summary class="flex cursor-pointer list-none items-center justify-between gap-2 p-3">
          <div>
            <p class="text-sm font-semibold ui-text-strong">{$t('admin.osm.archive.title')}</p>
            <p class="text-xs ui-text-muted">{$t('admin.osm.archive.hint')}</p>
          </div>
          <span class="text-xs ui-text-subtle">{archivedCandidates.length}</span>
        </summary>
        <div class="space-y-2 border-t ui-border px-3 py-3">
          <UiScrollArea className="ui-scroll-surface max-h-60 rounded-lg" contentClassName="space-y-2 p-2">
            <UiTable framed={false}>
              <UiTableHeader>
                <UiTableRow className="hover:[&>th]:bg-transparent">
                  <UiTableHead>{$t('admin.osm.list.building')}</UiTableHead>
                  <UiTableHead>{$t('admin.osm.list.syncState')}</UiTableHead>
                  <UiTableHead>{$t('admin.osm.list.updated')}</UiTableHead>
                  <UiTableHead>{$t('admin.osm.list.actions')}</UiTableHead>
                </UiTableRow>
              </UiTableHeader>
              <UiTableBody>
                {#each archivedCandidates as item (`osm-sync-archive-${item.osmType}-${item.osmId}`)}
                  <SyncCandidateCard
                    candidate={item}
                    archived
                    isMasterAdmin={isMasterAdmin}
                    selected={false}
                    syncable={false}
                    syncBusy={syncBusy}
                    onOpen={loadCandidate}
                    onSync={syncCandidate}
                    onToggleSelection={toggleCandidateSelection}
                  />
                {/each}
              </UiTableBody>
            </UiTable>
          </UiScrollArea>
        </div>
      </details>
    {/if}
  </section>

  {#if selectedCandidate}
    <SyncCandidateDetailPane
      {selectedCandidate}
      {selectedCandidateDetail}
      {detailBusy}
      {isMasterAdmin}
      onClose={() => (selectedCandidate = null)}
      onRefresh={loadState}
      onSync={syncCandidate}
    />
  {/if}
</section>

<style>
  .osm-summary-card,
  .osm-form-card {
    border: 1px solid var(--panel-border);
    background: var(--panel-solid);
    box-shadow: var(--shadow-soft);
  }
</style>
