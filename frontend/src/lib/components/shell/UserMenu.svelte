<script>
  import { createEventDispatcher, onDestroy, onMount } from 'svelte';
  import { fly } from 'svelte/transition';
  import ArchitectureIcon from '$lib/components/icons/ArchitectureIcon.svelte';
  import MoonIcon from '$lib/components/icons/MoonIcon.svelte';
  import SunIcon from '$lib/components/icons/SunIcon.svelte';
  import { apiJson } from '$lib/services/http';
  import { availableLocales, locale, setLocale, t, translateNow } from '$lib/i18n/index';
  import { clearSession, session } from '$lib/stores/auth';
  import { mapLabelsVisible, setMapLabelsVisible } from '$lib/stores/map';
  import { getUserInitials, getUserLabel } from '$lib/utils/user-display';

  export let open = false;
  export let primaryLinks = [];

  const dispatch = createEventDispatcher();

  let darkTheme = false;
  let themeObserver = null;

  $: userInitials = getUserInitials($session.user);
  $: menuIdentityLabel = $session.authenticated ? getUserLabel($session.user) : $t('common.appName');
  $: menuIdentityMeta = $session.authenticated ? String($session.user?.email || '').trim() : $t('header.authTitle');

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
        <button type="button" class="ui-btn ui-btn-primary menu-btn" on:click={() => requestAuth('login')}>
          {$t('header.login')}
        </button>
        <button type="button" class="ui-btn ui-btn-secondary menu-btn" on:click={() => requestAuth('register')}>
          {$t('header.register')}
        </button>
      </div>
    {/if}

    <div class="menu-links">
      {#each primaryLinks as link}
        <a href={link.href} class:active={link.active} on:click={closePanel}>{link.label}</a>
      {/each}
    </div>

    <div class="theme-row">
      <span>{$t('locale.label')}</span>
      <select
        class="ui-field ui-field-xs locale-select"
        bind:value={$locale}
        on:change={(event) => setLocale(event.currentTarget.value)}
      >
        {#each availableLocales as item}
          <option value={item}>{$t(`locale.${item}`)}</option>
        {/each}
      </select>
    </div>

    <div class="theme-row">
      <span>{$t('header.labels')}</span>
      <label
        class="switch switch-icons switch-labels"
        aria-label={$mapLabelsVisible ? $t('header.labelsHide') : $t('header.labelsShow')}
      >
        <input
          type="checkbox"
          checked={$mapLabelsVisible}
          on:change={(event) => applyLabelsVisibility(event.currentTarget.checked)}
        />
        <span class="icon-center" aria-hidden="true">
          <ArchitectureIcon width="12" height="12" />
        </span>
        <span class="slider"></span>
      </label>
    </div>

    <div class="theme-row">
      <span>{$t('header.theme')}</span>
      <label class="switch switch-icons" aria-label={$t('header.toggleTheme')}>
        <input
          type="checkbox"
          checked={darkTheme}
          on:change={(event) => applyTheme(event.currentTarget.checked ? 'dark' : 'light')}
        />
        <span class="icon-center" aria-hidden="true">
          {#if darkTheme}
            <MoonIcon width="14" height="14" />
          {:else}
            <SunIcon width="14" height="14" />
          {/if}
        </span>
        <span class="slider"></span>
      </label>
    </div>

    {#if $session.authenticated}
      <button type="button" class="ui-btn ui-btn-danger menu-btn" on:click={logout}>
        {$t('header.logout')}
      </button>
    {/if}
  </div>
{/if}

<style>
  .menu {
    position: absolute;
    top: calc(100% + 0.5rem);
    right: 0.75rem;
    width: min(21rem, calc(100vw - 1.5rem));
    padding: 0.75rem;
    display: grid;
    gap: 0.75rem;
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

  .menu-btn {
    width: 100%;
  }

  .theme-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
    padding: 0.7rem 0.8rem;
    border: 1px solid var(--panel-border);
    border-radius: 1rem;
    background: color-mix(in srgb, var(--panel-solid) 76%, transparent);
    font-size: 0.88rem;
    font-weight: 700;
    color: var(--muted-strong);
  }

  .locale-select {
    margin-left: auto;
    min-width: 6.8rem;
  }

  .switch {
    position: relative;
    --switch-width: 3.15rem;
    --switch-height: 1.5rem;
    --switch-pad: 0.12rem;
    --knob-size: 1.25rem;
    --switch-knob-icon: #0f172a;
    width: var(--switch-width);
    height: var(--switch-height);
    display: inline-flex;
  }

  .switch-icons {
    --switch-width: 3.15rem;
    width: var(--switch-width);
  }

  .switch-icons .icon-center {
    position: absolute;
    top: 50%;
    left: calc(var(--switch-pad) + 0.03rem);
    z-index: 2;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: var(--knob-size);
    height: var(--knob-size);
    transform: translateY(-50%);
    color: var(--switch-knob-icon);
    transition: color 0.2s, transform 0.2s;
    pointer-events: none;
  }

  .switch-icons input:checked ~ .icon-center {
    transform: translate(calc(var(--switch-width) - var(--knob-size) - (var(--switch-pad) * 2)), -50%);
  }

  .switch input {
    position: absolute;
    inset: 0;
    opacity: 0;
    width: 100%;
    height: 100%;
    margin: 0;
    cursor: pointer;
  }

  .slider {
    position: absolute;
    inset: 0;
    border-radius: 999px;
    background: color-mix(in srgb, var(--muted) 40%, transparent);
    transition: 0.2s;
  }

  .slider::before {
    content: '';
    position: absolute;
    width: var(--knob-size);
    height: var(--knob-size);
    left: var(--switch-pad);
    top: 50%;
    border-radius: 50%;
    background: #fff;
    transform: translateY(-50%);
    transition: 0.2s;
    box-shadow: 0 1px 2px rgba(15, 23, 42, 0.16);
  }

  .switch-icons input:checked ~ .slider {
    background: var(--accent);
  }

  .switch-icons input:checked ~ .slider::before {
    transform: translate(calc(var(--switch-width) - var(--knob-size) - (var(--switch-pad) * 2)), -50%);
  }

  @media (max-width: 768px) {
    .menu {
      left: 0.75rem;
      right: 0.75rem;
      width: auto;
    }

    .theme-row {
      align-items: flex-start;
      flex-direction: column;
    }

    .locale-select {
      width: 100%;
      min-width: 0;
    }
  }
</style>
