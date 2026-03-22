<script>
  import { createEventDispatcher, onDestroy, onMount } from 'svelte';
  import { fly } from 'svelte/transition';
  import { UiButton, UiSelect, UiSwitch } from '$lib/components/base';
  import ArchitectureIcon from '$lib/components/icons/ArchitectureIcon.svelte';
  import BuildingPartsIcon from '$lib/components/icons/BuildingPartsIcon.svelte';
  import MoonIcon from '$lib/components/icons/MoonIcon.svelte';
  import SunIcon from '$lib/components/icons/SunIcon.svelte';
  import { apiJson } from '$lib/services/http';
  import { availableLocales, locale, setLocale, t, translateNow } from '$lib/i18n/index';
  import { clearSession, session } from '$lib/stores/auth';
  import {
    mapBuildingPartsVisible,
    mapLabelsVisible,
    setMapBuildingPartsVisible,
    setMapLabelsVisible
  } from '$lib/stores/map';
  import { getUserInitials, getUserLabel } from '$lib/utils/user-display';

  export let open = false;
  export let primaryLinks = [];

  const dispatch = createEventDispatcher();

  let darkTheme = false;
  let themeObserver = null;
  let localeItems;

  $: userInitials = getUserInitials($session.user);
  $: menuIdentityLabel = $session.authenticated ? getUserLabel($session.user) : $t('common.appName');
  $: menuIdentityMeta = $session.authenticated ? String($session.user?.email || '').trim() : $t('header.authTitle');
  $: localeItems = availableLocales.map((item) => ({
    value: item,
    label: $t(`locale.${item}`)
  }));

  function closePanel() {
    dispatch('close');
  }

  function requestAuth(tab) {
    dispatch('openAuth', { tab });
  }

  function getCurrentTheme() {
    return String(document.documentElement.getAttribute('data-theme') || '').toLowerCase() === 'dark' ? 'dark' : 'light';
  }

  function applyTheme(theme) {
    const next = theme === 'dark' ? 'dark' : 'light';
    document.documentElement.setAttribute('data-theme', next);
    darkTheme = next === 'dark';
    try {
      localStorage.setItem('archimap-theme', next);
    } catch {
      // ignore
    }
  }

  function applyLabelsVisibility(visible) {
    const next = Boolean(visible);
    setMapLabelsVisible(next);
    try {
      localStorage.setItem('archimap-map-labels-visible', next ? '1' : '0');
    } catch {
      // ignore
    }
  }

  function applyBuildingPartsVisibility(visible) {
    const next = Boolean(visible);
    setMapBuildingPartsVisible(next);
    try {
      localStorage.setItem('archimap-map-building-parts-visible', next ? '1' : '0');
    } catch {
      // ignore
    }
  }

  async function logout() {
    try {
      await apiJson('/api/logout', { method: 'POST' });
    } catch {
      // ignore
    }
    clearSession();
    closePanel();
  }

  onMount(() => {
    darkTheme = getCurrentTheme() === 'dark';
    try {
      const storedLabels = localStorage.getItem('archimap-map-labels-visible');
      if (storedLabels === '0' || storedLabels === '1') {
        setMapLabelsVisible(storedLabels === '1');
      }
      const storedParts = localStorage.getItem('archimap-map-building-parts-visible');
      if (storedParts === '0' || storedParts === '1') {
        setMapBuildingPartsVisible(storedParts === '1');
      }
    } catch {
      // ignore
    }
    themeObserver = new MutationObserver(() => {
      darkTheme = getCurrentTheme() === 'dark';
    });
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  });

  onDestroy(() => {
    if (themeObserver) {
      themeObserver.disconnect();
      themeObserver = null;
    }
  });
</script>

{#if open}
  <div
    class="menu"
    in:fly={{ x: 10, y: -8, duration: 190, opacity: 0.2 }}
    out:fly={{ x: 10, y: -8, duration: 170, opacity: 0.2 }}
  >
    <div class="menu-identity">
      <span class="menu-avatar menu-avatar-large">{userInitials}</span>
      <div class="menu-identity-copy">
        <strong>{menuIdentityLabel}</strong>
        <span>{menuIdentityMeta}</span>
      </div>
    </div>

    {#if !$session.authenticated}
      <div class="menu-auth-actions">
        <UiButton type="button" className="w-full" onclick={() => requestAuth('login')}>
          {$t('header.loginRegister')}
        </UiButton>
      </div>
    {/if}

    <div class="menu-links">
      {#each primaryLinks as link}
        <a href={link.href} class:active={link.active} on:click={closePanel}>{link.label}</a>
      {/each}
    </div>

    <div class="toggle-row toggle-row-locale">
      <span class="toggle-row-label">{$t('locale.label')}</span>
      <div data-testid="locale-select" class="locale-select">
        <UiSelect
          value={$locale}
          items={localeItems}
          className="w-full"
          contentClassName="ui-floating-layer-user-menu"
          onchange={(event) => setLocale(event.detail.value)}
        />
      </div>
    </div>

    <div class="toggle-row">
      <span>{$t('header.labels')}</span>
      <div class="switch-row">
        <span class="switch-icon" aria-hidden="true">
          <ArchitectureIcon width="24" height="24" />
        </span>
        <UiSwitch
          checked={$mapLabelsVisible}
          aria-label={$mapLabelsVisible ? $t('header.labelsHide') : $t('header.labelsShow')}
          onchange={(event) => applyLabelsVisibility(event.detail.checked)}
        />
      </div>
    </div>

    <div class="toggle-row">
      <span>{$t('header.buildingParts')}</span>
      <div class="switch-row">
        <span class="switch-icon" aria-hidden="true">
          <BuildingPartsIcon width="24" height="24" />
        </span>
        <UiSwitch
          checked={$mapBuildingPartsVisible}
          aria-label={$mapBuildingPartsVisible ? $t('header.buildingPartsHide') : $t('header.buildingPartsShow')}
          onchange={(event) => applyBuildingPartsVisibility(event.detail.checked)}
        />
      </div>
    </div>

    <div class="toggle-row">
      <span>{$t('header.theme')}</span>
      <div class="switch-row">
        <span class="switch-icon" aria-hidden="true">
          {#if darkTheme}
            <MoonIcon width="28" height="28" />
          {:else}
            <SunIcon width="28" height="28" />
          {/if}
        </span>
        <UiSwitch
          checked={darkTheme}
          aria-label={$t('header.toggleTheme')}
          onchange={(event) => applyTheme(event.detail.checked ? 'dark' : 'light')}
        />
      </div>
    </div>

    {#if $session.authenticated}
      <UiButton type="button" variant="danger" className="menu-btn" onclick={logout}>
        {$t('header.logout')}
      </UiButton>
    {/if}
  </div>
{/if}

<style>
  .menu {
    position: absolute;
    top: calc(100% + 0.5rem);
    right: 0.75rem;
    width: min(21rem, calc(100vw - 1.5rem));
    max-height: calc(100dvh - 6rem);
    padding: 0.75rem;
    display: grid;
    gap: 0.75rem;
    overflow-y: auto;
    overscroll-behavior: contain;
    -webkit-overflow-scrolling: touch;
    border: 1px solid var(--panel-border);
    border-radius: 1.2rem;
    background: color-mix(in srgb, var(--panel-solid) 88%, transparent);
    box-shadow: var(--shadow-panel);
    backdrop-filter: blur(18px);
    pointer-events: auto;
    z-index: 2;
  }

  .menu-identity {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.25rem;
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

  .menu-avatar-large {
    width: 2.65rem;
    height: 2.65rem;
    border-radius: 0.95rem;
    font-size: 0.95rem;
  }

  .menu-identity-copy {
    display: grid;
    gap: 0.2rem;
    min-width: 0;
  }

  .menu-identity-copy strong {
    color: var(--fg-strong);
    font-size: 0.96rem;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .menu-identity-copy span {
    color: var(--muted);
    font-size: 0.8rem;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .menu-auth-actions,
  .menu-links {
    display: grid;
    gap: 0.45rem;
  }

  .menu-links a {
    padding: 0.7rem 0.85rem;
    border-radius: 0.95rem;
    text-decoration: none;
    font-size: 0.88rem;
    font-weight: 700;
    color: var(--muted-strong);
    background: color-mix(in srgb, var(--panel-solid) 72%, transparent);
    border: 1px solid transparent;
    transition: background-color 0.18s ease, border-color 0.18s ease, color 0.18s ease;
  }

  .menu-links a:hover,
  .menu-links a.active {
    border-color: color-mix(in srgb, var(--accent) 22%, var(--panel-border));
    background: var(--accent-soft);
    color: var(--accent-ink);
  }

  .toggle-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.65rem;
    padding: 0.5rem 0.7rem;
    border: 1px solid var(--panel-border);
    border-radius: 1rem;
    background: color-mix(in srgb, var(--panel-solid) 76%, transparent);
    font-size: 0.88rem;
    font-weight: 700;
    color: var(--muted-strong);
  }

  .toggle-row-label {
    min-width: 0;
    white-space: nowrap;
  }

  .toggle-row-locale {
    align-items: center;
  }

  .locale-select {
    min-width: 6.8rem;
    max-width: 9.5rem;
    margin-left: auto;
    flex: 0 0 auto;
  }

  .switch-row {
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
  }

  .switch-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    color: var(--muted-strong);
  }

  @media (max-width: 768px) {
    .menu {
      left: 0.75rem;
      right: 0.75rem;
      width: auto;
      max-height: calc(100dvh - 6.5rem - env(safe-area-inset-bottom, 0px));
      margin-bottom: calc(0.75rem + env(safe-area-inset-bottom, 0px));
    }

    .toggle-row {
      gap: 0.6rem;
      align-items: center;
      flex-direction: row;
    }

    .locale-select {
      max-width: min(9.5rem, 48vw);
    }
  }
</style>
