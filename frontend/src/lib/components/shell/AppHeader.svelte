<script>
  import { get } from 'svelte/store';
  import { onMount } from 'svelte';
  import { page } from '$app/stores';
  import FilterIcon from '$lib/components/icons/FilterIcon.svelte';
  import MenuIcon from '$lib/components/icons/MenuIcon.svelte';
  import SearchIcon from '$lib/components/icons/SearchIcon.svelte';
  import AuthModal from '$lib/components/shell/AuthModal.svelte';
  import FilterPanel from '$lib/components/shell/FilterPanel.svelte';
  import SearchInput from '$lib/components/shell/SearchInput.svelte';
  import UserMenu from '$lib/components/shell/UserMenu.svelte';
  import { buildAccountUrl, buildAdminUrl, buildInfoUrl } from '$lib/client/section-routes';
  import { patchUrlState } from '$lib/client/urlState';
  import { apiJson } from '$lib/services/http';
  import { clearSession, session, setSession } from '$lib/stores/auth';
  import { lastMapCamera } from '$lib/stores/map';
  import { openSearchModal, requestSearch, searchState, setSearchQuery } from '$lib/stores/search';
  import { t } from '$lib/i18n/index';
  import { getUserInitials, getUserLabel } from '$lib/utils/user-display';

  let menuOpen = false;
  let authOpen = false;
  let authPreferredTab = 'login';
  let authRequestId = 0;
  let filterOpen = false;
  let searchText = '';
  let visibleFilterCount = 0;

  $: currentPathname = $page.url.pathname;
  $: basePrefix = currentPathname === '/app' || currentPathname.startsWith('/app/') ? '/app' : '';
  $: normalizedPathname = basePrefix ? (currentPathname.slice(basePrefix.length) || '/') : currentPathname;
  $: isMapRoute = normalizedPathname === '/';
  $: mapHref = navHref('/', basePrefix, isMapRoute, $lastMapCamera);
  $: infoHref = navHref(buildInfoUrl('/info', 'about').pathname, basePrefix, isMapRoute, $lastMapCamera);
  $: accountHref = navHref(buildAccountUrl('/account', 'settings').pathname, basePrefix, isMapRoute, $lastMapCamera);
  $: adminHref = navHref(buildAdminUrl('/admin', 'edits').pathname, basePrefix, isMapRoute, $lastMapCamera);
  $: termsHref = navHref(buildInfoUrl('/info', 'agreement').pathname, basePrefix, isMapRoute, $lastMapCamera);
  $: privacyHref = navHref(buildInfoUrl('/info', 'privacy').pathname, basePrefix, isMapRoute, $lastMapCamera);
  $: primaryLinks = [
    { href: mapHref, label: $t('header.map'), active: normalizedPathname === '/' },
    { href: infoHref, label: $t('header.info'), active: isActive(normalizedPathname, '/info') },
    ...($session.authenticated ? [{ href: accountHref, label: $t('header.profile'), active: isActive(normalizedPathname, '/account') }] : []),
    ...($session.user?.isAdmin ? [{ href: adminHref, label: $t('header.admin'), active: isActive(normalizedPathname, '/admin') }] : [])
  ];
  $: userInitials = getUserInitials($session.user);
  $: menuIdentityLabel = $session.authenticated ? getUserLabel($session.user) : $t('common.appName');
  $: if (!isMapRoute && filterOpen) {
    filterOpen = false;
  }

  function navHref(path, currentBasePrefix, currentIsMapRoute, currentLastMapCamera) {
    const target = path === '/' ? '' : path;
    const pathname = `${currentBasePrefix}${target || '/'}`;
    if (path !== '/' || currentIsMapRoute || !currentLastMapCamera) {
      return pathname;
    }
    const nextUrl = patchUrlState(new URL(pathname, 'http://localhost'), {
      camera: currentLastMapCamera
    });
    return `${nextUrl.pathname}${nextUrl.search}${nextUrl.hash}`;
  }

  function isActive(pathname, href) {
    return pathname === href || pathname.startsWith(`${href}/`);
  }

  async function loadMe() {
    try {
      const data = await apiJson('/api/me');
      setSession(data);
    } catch {
      clearSession();
    }
  }

  function openAuth(tab = 'login') {
    authPreferredTab = tab === 'register' ? 'register' : 'login';
    authRequestId = Date.now() + Math.random();
    authOpen = true;
    menuOpen = false;
  }

  function toggleFilterPanel() {
    menuOpen = false;
    filterOpen = !filterOpen;
  }

  function toggleMenuPanel() {
    filterOpen = false;
    menuOpen = !menuOpen;
  }

  function closeFloatingPanels() {
    menuOpen = false;
    filterOpen = false;
  }

  function openMobileSearch() {
    const text = String(searchText || '').trim().slice(0, 120);
    setSearchQuery(text);
    openSearchModal(text);
    if (text.length >= 2) {
      requestSearch({ query: text, append: false });
    }
  }

  onMount(() => {
    loadMe();
    searchText = String(get(searchState)?.query || '');
  });
</script>

<header class="nav-shell">
  <div class="nav">
    <div class="brand-cluster">
      <a href={mapHref} class="logo" aria-label={$t('common.appName')}>
        <span class="logo-copy">
          <span class="logo-name">{$t('common.appName')}</span>
        </span>
      </a>

      <nav class="nav-links" aria-label={$t('header.openMenu')}>
        {#each primaryLinks as link}
          <a href={link.href} class:active={link.active} on:click={() => (menuOpen = false)}>{link.label}</a>
        {/each}
      </nav>
    </div>

    {#if isMapRoute}
      <SearchInput bind:value={searchText} />
    {:else}
      <div class="nav-center-spacer" aria-hidden="true"></div>
    {/if}

    <div class="right-controls">
      {#if isMapRoute}
        <button
          type="button"
          data-testid="filter-trigger"
          class:active={filterOpen}
          class:has-rules={visibleFilterCount > 0}
          class="filter-trigger"
          aria-label={$t('header.openFilters')}
          aria-expanded={filterOpen}
          on:click={toggleFilterPanel}
        >
          <FilterIcon class="filter-trigger-icon" width="20" height="20" />
          <span class="filter-trigger-copy">
            <span class="filter-trigger-title">{$t('header.filterTitle')}</span>
          </span>
          {#if visibleFilterCount > 0}
            <span class="filter-trigger-badge">{visibleFilterCount}</span>
          {/if}
        </button>
      {/if}

      {#if isMapRoute}
        <button
          type="button"
          class="icon-btn search-mobile-btn"
          aria-label={$t('header.openSearch')}
          on:click={openMobileSearch}
        >
          <SearchIcon class="search-mobile-icon" width="20" height="20" />
        </button>
      {/if}

      <button
        type="button"
        class:guest={!$session.authenticated}
        class="menu-btn-trigger"
        aria-label={$t('header.openMenu')}
        aria-expanded={menuOpen}
        on:click={toggleMenuPanel}
      >
        {#if $session.authenticated}
          <span class="menu-avatar">{userInitials}</span>
          <span class="menu-btn-label">{menuIdentityLabel}</span>
        {:else}
          <MenuIcon width="20" height="20" />
        {/if}
      </button>
    </div>
  </div>

  {#if menuOpen || (filterOpen && isMapRoute)}
    <button
      type="button"
      class="nav-backdrop"
      aria-label={$t('header.closePanels')}
      on:click={closeFloatingPanels}
    ></button>
  {/if}

  <FilterPanel
    open={filterOpen && isMapRoute}
    bind:visibleCount={visibleFilterCount}
    on:close={() => (filterOpen = false)}
  />
  <UserMenu
    open={menuOpen}
    {primaryLinks}
    on:close={() => (menuOpen = false)}
    on:openAuth={(event) => openAuth(event.detail?.tab)}
  />
  <AuthModal bind:open={authOpen} preferredTab={authPreferredTab} requestId={authRequestId} {termsHref} {privacyHref} />
</header>

<style>
  .nav-shell {
    position: fixed;
    inset-inline: 0;
    top: 0;
    z-index: 1005;
    padding: 0.75rem;
    pointer-events: none;
  }

  .nav {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto;
    align-items: center;
    gap: 0.75rem;
    padding: 0.65rem 0.75rem 0.65rem 1.1rem;
    border: 1px solid var(--panel-border);
    border-radius: 1.35rem;
    background: color-mix(in srgb, var(--panel-solid) 82%, transparent);
    box-shadow: var(--shadow-panel);
    backdrop-filter: blur(18px);
    pointer-events: auto;
    position: relative;
    z-index: 2;
  }

  .brand-cluster {
    display: flex;
    align-items: center;
    gap: 1.15rem;
    min-width: 0;
    max-width: max-content;
  }

  .logo {
    display: flex;
    align-items: center;
    gap: 0;
    min-width: 0;
    text-decoration: none;
  }

  .logo-copy {
    display: grid;
    gap: 0;
    min-width: 0;
  }

  .logo-name {
    font-family: var(--font-display);
    font-size: 1.25rem;
    font-weight: 800;
    color: var(--fg-strong);
    line-height: 1;
  }

  .nav-links {
    display: flex;
    flex-wrap: wrap;
    gap: 0.35rem;
  }

  .nav-links a {
    padding: 0.48rem 0.78rem;
    border-radius: 999px;
    color: var(--muted-strong);
    text-decoration: none;
    font-size: 0.82rem;
    font-weight: 700;
    transition: background-color 0.18s ease, color 0.18s ease;
  }

  .nav-links a:hover {
    background: color-mix(in srgb, var(--accent-soft) 45%, transparent);
  }

  .nav-links a.active {
    background: var(--accent-soft);
    color: var(--accent-ink);
  }

  .nav-center-spacer {
    min-width: 0;
    width: 100%;
    min-height: 3rem;
  }

  .icon-btn,
  .menu-btn-trigger,
  .filter-trigger {
    border: 1px solid var(--panel-border);
    background: color-mix(in srgb, var(--panel-solid) 84%, transparent);
    color: var(--muted-strong);
    cursor: pointer;
    transition: background-color 0.18s ease, border-color 0.18s ease, color 0.18s ease, transform 0.18s ease, box-shadow 0.18s ease;
  }

  .icon-btn:hover,
  .menu-btn-trigger:hover,
  .filter-trigger:hover {
    transform: translateY(-1px);
    border-color: var(--panel-border-strong);
    background: var(--panel-solid);
    color: var(--fg-strong);
    box-shadow: 0 14px 28px rgba(15, 23, 42, 0.1);
  }

  .icon-btn {
    width: 2.7rem;
    height: 2.7rem;
    border-radius: 0.9rem;
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }

  .right-controls {
    display: flex;
    align-items: center;
    gap: 0.55rem;
    justify-self: end;
  }

  .filter-trigger {
    display: inline-flex;
    align-items: center;
    gap: 0.7rem;
    min-height: 2.9rem;
    padding: 0.45rem 0.55rem 0.45rem 0.9rem;
    border-radius: 1rem;
  }

  .filter-trigger.active,
  .filter-trigger.has-rules {
    border-color: color-mix(in srgb, var(--accent) 32%, var(--panel-border));
  }

  .filter-trigger-copy {
    display: grid;
    gap: 0;
    text-align: left;
  }

  .filter-trigger-title {
    font-size: 0.8rem;
    font-weight: 700;
    color: var(--fg-strong);
  }

  .filter-trigger-badge {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 1.55rem;
    height: 1.55rem;
    padding: 0 0.38rem;
    border-radius: 999px;
    background: linear-gradient(135deg, var(--accent) 0%, var(--accent-brass) 100%);
    color: var(--accent-contrast);
    font-size: 0.73rem;
    font-weight: 800;
  }

  .menu-btn-trigger {
    min-height: 2.9rem;
    max-width: 14rem;
    display: inline-flex;
    align-items: center;
    gap: 0.55rem;
    padding: 0.38rem 0.55rem;
    border-radius: 1rem;
  }

  .menu-btn-trigger.guest {
    width: 2.9rem;
    justify-content: center;
  }

  .menu-avatar {
    width: 1.95rem;
    height: 1.95rem;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border-radius: 0.75rem;
    background: var(--accent-soft);
    color: var(--accent-ink);
    font-size: 0.8rem;
    font-weight: 800;
    flex: none;
  }

  .menu-btn-label {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 0.82rem;
    font-weight: 700;
    color: var(--fg-strong);
  }

  .search-mobile-btn {
    display: none;
  }

  .nav-backdrop {
    position: fixed;
    inset: 0;
    z-index: 1;
    border: 0;
    margin: 0;
    padding: 0;
    background: transparent;
  }

  @media (max-width: 1180px) {
    .filter-trigger-copy {
      display: none;
    }

    .menu-btn-label {
      max-width: 7rem;
    }
  }

  @media (max-width: 1024px) {
    .nav-links {
      display: none;
    }
  }

  @media (max-width: 768px) {
    .nav-center-spacer {
      display: none;
    }

    .search-mobile-btn {
      display: inline-flex;
    }

    .filter-trigger {
      width: 2.7rem;
      height: 2.7rem;
      min-width: 2.7rem;
      min-height: 2.7rem;
      padding: 0;
      gap: 0;
      justify-content: center;
      border-radius: 0.9rem;
    }

    .filter-trigger-copy,
    .filter-trigger-badge {
      display: none;
    }

    .nav {
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 0.55rem;
    }

    .logo-name {
      font-size: 1.1rem;
    }

    .menu-btn-label {
      display: none;
    }
  }
</style>
