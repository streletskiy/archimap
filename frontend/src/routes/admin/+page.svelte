<script>
  import { onMount } from 'svelte';
  import { get } from 'svelte/store';
  import { beforeNavigate, goto } from '$app/navigation';
  import { page } from '$app/stores';

  import PortalFrame from '$lib/components/shell/PortalFrame.svelte';
  import AdminDataTab from '$lib/components/admin/AdminDataTab.svelte';
  import AdminEditsTab from '$lib/components/admin/AdminEditsTab.svelte';
  import AdminFiltersTab from '$lib/components/admin/AdminFiltersTab.svelte';
  import AdminSettingsTab from '$lib/components/admin/AdminSettingsTab.svelte';
  import AdminUsersTab from '$lib/components/admin/AdminUsersTab.svelte';
  import { createAdminDataController } from '$lib/components/admin/admin-data-controller.js';
  import { buildAdminUrl, resolveAdminTabFromUrl } from '$lib/client/section-routes';
  import { parseUrlState, patchUrlState } from '$lib/client/urlState';
  import { t, translateNow } from '$lib/i18n/index';
  import { session } from '$lib/stores/auth';

  const dataController = createAdminDataController();
  const filterTagAllowlistDirty = dataController.filterTagAllowlistDirty;

  let activeTab = resolveAdminTabFromUrl(get(page).url);
  let pendingUrlEditId = normalizeEditId(parseUrlState(get(page).url)?.editId);
  let adminUrlSyncBusy = false;

  let usersCount = null;
  let editsTotal = null;
  let editsVisible = null;

  function normalizeEditId(value) {
    const numeric = Number(value || 0);
    return Number.isInteger(numeric) && numeric > 0 ? numeric : null;
  }

  function formatCount(value) {
    return Number.isFinite(value) ? String(value) : '---';
  }

  function getActiveTabLabel(tab = activeTab) {
    if (tab === 'users') return translateNow('admin.tabs.users');
    if (tab === 'settings') return translateNow('admin.tabs.settings');
    if (tab === 'data') return translateNow('admin.tabs.data');
    if (tab === 'filters') return translateNow('admin.tabs.filters');
    return translateNow('admin.tabs.edits');
  }

  async function replaceAdminUrlState(patch, tab = activeTab) {
    if (typeof window === 'undefined') return;

    const current = new URL(window.location.href);
    const next = patchUrlState(buildAdminUrl(current, tab), patch);
    if (next.toString() === current.toString()) return;

    adminUrlSyncBusy = true;
    try {
      await goto(`${next.pathname}${next.search}${next.hash}`, {
        replaceState: true,
        keepFocus: true,
        noScroll: true
      });
    } finally {
      queueMicrotask(() => {
        adminUrlSyncBusy = false;
      });
    }
  }

  async function switchTab(tab, options = {}) {
    const { syncUrl = true, force = false } = options;
    if (!force && tab !== activeTab && !dataController.confirmDiscardFilterTagChanges()) {
      return;
    }

    activeTab = tab;
    if (tab !== 'edits') {
      pendingUrlEditId = null;
    }
    if (syncUrl) {
      await replaceAdminUrlState({ editId: null }, tab);
    }
  }

  function handleUsersSummary(event) {
    usersCount = Number(event.detail?.count || 0);
  }

  function handleEditsSummary(event) {
    editsTotal = Number(event.detail?.total || 0);
    editsVisible = Number(event.detail?.visible || 0);
  }

  async function handleEditIdChange(event) {
    pendingUrlEditId = normalizeEditId(event.detail?.editId);
    await replaceAdminUrlState({ editId: pendingUrlEditId }, activeTab);
  }

  beforeNavigate((navigation) => {
    if (!get(filterTagAllowlistDirty)) return;
    const nextPathname = String(navigation?.to?.url?.pathname || '').trim();
    if (!nextPathname) return;
    if (typeof window !== 'undefined' && nextPathname !== window.location.pathname && !dataController.confirmDiscardFilterTagChanges()) {
      navigation.cancel();
    }
  });

  onMount(() => {
    const unsubscribePage = page.subscribe(($pageState) => {
      pendingUrlEditId = normalizeEditId(parseUrlState($pageState.url)?.editId);
      if (adminUrlSyncBusy) return;

      const nextTab = resolveAdminTabFromUrl($pageState.url);
      if (nextTab !== activeTab) {
        activeTab = nextTab;
      }
    });

    const onBeforeUnload = (event) => {
      if (!get(filterTagAllowlistDirty)) return;
      event.preventDefault();
      event.returnValue = '';
    };

    window.addEventListener('beforeunload', onBeforeUnload);

    return () => {
      unsubscribePage();
      window.removeEventListener('beforeunload', onBeforeUnload);
    };
  });
</script>

{#if !$session.authenticated}
  <PortalFrame eyebrow="Archimap" title={$t('admin.title')} description={$t('admin.subtitle')}>
    <div class="portal-notice">
      <h2 class="text-xl font-extrabold ui-text-strong">{$t('admin.authRequired')}</h2>
    </div>
  </PortalFrame>
{:else if !$session.user?.isAdmin}
  <PortalFrame eyebrow="Archimap" title={$t('admin.title')} description={$t('admin.subtitle')}>
    <div class="portal-notice">
      <h2 class="text-xl font-extrabold ui-text-strong">{$t('admin.forbidden')}</h2>
    </div>
  </PortalFrame>
{:else}
  <PortalFrame eyebrow="Archimap" title={$t('admin.title')} description={$t('admin.subtitle')}>
    <svelte:fragment slot="meta">
      <span class="ui-chip"><strong>{$t('admin.tabs.users')}</strong>{formatCount(usersCount)}</span>
      <span class="ui-chip"><strong>{$t('admin.tabs.edits')}</strong>{formatCount(editsTotal)}</span>
    </svelte:fragment>

    <svelte:fragment slot="lead">
      <div class="portal-lead-grid">
        <article class="portal-stat">
          <span>{$t('admin.tabs.users')}</span>
          <strong>{formatCount(usersCount)}</strong>
        </article>
        <article class="portal-stat">
          <span>{$t('admin.tabs.edits')}</span>
          <strong>{formatCount(editsVisible)} / {formatCount(editsTotal)}</strong>
        </article>
        <article class="portal-stat">
          <span>{$t('admin.currentSection')}</span>
          <strong>{getActiveTabLabel(activeTab)}</strong>
        </article>
      </div>
    </svelte:fragment>

    <ul class="ui-tab-shell flex flex-wrap gap-1" role="tablist">
      <li>
        <button
          type="button"
          class="ui-tab-btn"
          class:ui-tab-btn-active={activeTab === 'edits'}
          on:click={() => switchTab('edits')}>{$t('admin.tabs.edits')}</button
        >
      </li>
      <li>
        <button
          type="button"
          class="ui-tab-btn"
          class:ui-tab-btn-active={activeTab === 'users'}
          on:click={() => switchTab('users')}>{$t('admin.tabs.users')}</button
        >
      </li>
      <li>
        <button
          type="button"
          class="ui-tab-btn"
          class:ui-tab-btn-active={activeTab === 'data'}
          on:click={() => switchTab('data')}>{$t('admin.tabs.data')}</button
        >
      </li>
      <li>
        <button
          type="button"
          class="ui-tab-btn"
          class:ui-tab-btn-active={activeTab === 'filters'}
          on:click={() => switchTab('filters')}>{$t('admin.tabs.filters')}</button
        >
      </li>
      <li>
        <button
          type="button"
          class="ui-tab-btn"
          class:ui-tab-btn-active={activeTab === 'settings'}
          on:click={() => switchTab('settings')}>{$t('admin.tabs.settings')}</button
        >
      </li>
    </ul>

    {#if activeTab === 'users'}
      <AdminUsersTab isMasterAdmin={$session.user?.isMasterAdmin} on:summary={handleUsersSummary} />
    {:else if activeTab === 'data'}
      <AdminDataTab controller={dataController} isMasterAdmin={$session.user?.isMasterAdmin} />
    {:else if activeTab === 'filters'}
      <AdminFiltersTab controller={dataController} isMasterAdmin={$session.user?.isMasterAdmin} />
    {:else if activeTab === 'settings'}
      <AdminSettingsTab isMasterAdmin={$session.user?.isMasterAdmin} />
    {:else}
      <AdminEditsTab
        requestedEditId={pendingUrlEditId}
        isMasterAdmin={$session.user?.isMasterAdmin}
        on:editidchange={handleEditIdChange}
        on:summary={handleEditsSummary}
      />
    {/if}
  </PortalFrame>
{/if}
