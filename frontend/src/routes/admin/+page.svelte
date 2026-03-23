<script>
  import { onMount } from 'svelte';
  import { get } from 'svelte/store';
  import { beforeNavigate, goto } from '$app/navigation';
  import { page } from '$app/stores';

  import { UiTabsNav } from '$lib/components/base';
  import PortalFrame from '$lib/components/shell/PortalFrame.svelte';
  import AdminDataTab from '$lib/components/admin/AdminDataTab.svelte';
  import AdminEditsTab from '$lib/components/admin/AdminEditsTab.svelte';
  import AdminFiltersTab from '$lib/components/admin/AdminFiltersTab.svelte';
  import AdminOsmSyncTab from '$lib/components/admin/AdminOsmSyncTab.svelte';
  import AdminSettingsTab from '$lib/components/admin/AdminSettingsTab.svelte';
  import AdminStylesTab from '$lib/components/admin/AdminStylesTab.svelte';
  import AdminUsersTab from '$lib/components/admin/AdminUsersTab.svelte';
  import { createAdminDataController } from '$lib/components/admin/admin-data-controller.js';
  import { buildAdminUrl, resolveAdminTabFromUrl } from '$lib/client/section-routes';
  import { parseUrlState, patchUrlState } from '$lib/client/urlState';
  import { t } from '$lib/i18n/index';
  import { session } from '$lib/stores/auth';

  const dataController = createAdminDataController();
  const filtersDirty = dataController.filtersDirty;

  let activeTab = resolveAdminTabFromUrl(get(page).url);
  let tabNavValue = activeTab;
  let pendingUrlEditId = normalizeEditId(parseUrlState(get(page).url)?.editId);
  let adminUrlSyncBusy = false;
  let dataBootstrapTabKey;

  function normalizeEditId(value) {
    const numeric = Number(value || 0);
    return Number.isInteger(numeric) && numeric > 0 ? numeric : null;
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
      tabNavValue = activeTab;
      return;
    }

    activeTab = tab;
    tabNavValue = tab;
    if (tab !== 'edits') {
      pendingUrlEditId = null;
    }
    if (syncUrl) {
      await replaceAdminUrlState({ editId: null }, tab);
    }
  }

  $: {
    const nextDataBootstrapTabKey =
      $session.user?.isMasterAdmin && (activeTab === 'data' || activeTab === 'filters')
        ? activeTab
        : '';
    if (nextDataBootstrapTabKey && nextDataBootstrapTabKey !== dataBootstrapTabKey) {
      dataBootstrapTabKey = nextDataBootstrapTabKey;
      void dataController.ensureLoaded({ preserveSelection: true });
    } else if (!nextDataBootstrapTabKey) {
      dataBootstrapTabKey = '';
    }
    void dataBootstrapTabKey;
  }

  async function handleEditIdChange(event) {
    pendingUrlEditId = normalizeEditId(event.detail?.editId);
    await replaceAdminUrlState({ editId: pendingUrlEditId }, activeTab);
  }

  async function handleTabNavChange(event) {
    const nextTab = String(event.detail?.value || '').trim();
    if (!nextTab) {
      tabNavValue = activeTab;
      return;
    }
    await switchTab(nextTab);
  }

  beforeNavigate((navigation) => {
    if (!get(filtersDirty)) return;
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
      tabNavValue = activeTab;
    });

    const onBeforeUnload = (event) => {
      if (!get(filtersDirty)) return;
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
  <PortalFrame title={$t('admin.title')} description={$t('admin.subtitle')}>
    <div class="portal-notice">
      <h2 class="text-xl font-extrabold ui-text-strong">{$t('admin.authRequired')}</h2>
    </div>
  </PortalFrame>
{:else if !$session.user?.isAdmin}
  <PortalFrame title={$t('admin.title')} description={$t('admin.subtitle')}>
    <div class="portal-notice">
      <h2 class="text-xl font-extrabold ui-text-strong">{$t('admin.forbidden')}</h2>
    </div>
  </PortalFrame>
{:else}
  <PortalFrame title={$t('admin.title')} description={$t('admin.subtitle')}>
    <UiTabsNav
      bind:value={tabNavValue}
      items={[
        { value: 'edits', label: $t('admin.tabs.edits') },
        { value: 'users', label: $t('admin.tabs.users') },
        { value: 'data', label: $t('admin.tabs.data') },
        { value: 'osm', label: $t('admin.tabs.osm') },
        { value: 'filters', label: $t('admin.tabs.filters') },
        { value: 'styles', label: $t('admin.tabs.styles') },
        { value: 'settings', label: $t('admin.tabs.settings') }
      ]}
      onchange={handleTabNavChange}
    />

    {#if activeTab === 'users'}
      <AdminUsersTab isMasterAdmin={$session.user?.isMasterAdmin} />
    {:else if activeTab === 'data'}
      <AdminDataTab controller={dataController} isMasterAdmin={$session.user?.isMasterAdmin} />
    {:else if activeTab === 'osm'}
      <AdminOsmSyncTab isMasterAdmin={$session.user?.isMasterAdmin} />
    {:else if activeTab === 'filters'}
      <AdminFiltersTab controller={dataController} isMasterAdmin={$session.user?.isMasterAdmin} />
    {:else if activeTab === 'styles'}
      <AdminStylesTab />
    {:else if activeTab === 'settings'}
      <AdminSettingsTab isMasterAdmin={$session.user?.isMasterAdmin} />
    {:else}
      <AdminEditsTab
        requestedEditId={pendingUrlEditId}
        isMasterAdmin={$session.user?.isMasterAdmin}
        on:editidchange={handleEditIdChange}
      />
    {/if}
  </PortalFrame>
{/if}
