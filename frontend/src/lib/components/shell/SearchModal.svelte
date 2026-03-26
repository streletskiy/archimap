<script>
  import { browser } from '$app/environment';
  import { createEventDispatcher, onDestroy, onMount, tick } from 'svelte';
  import { UiBadge, UiButton, UiInput, UiScrollArea } from '$lib/components/base';
  import CloseIcon from '$lib/components/icons/CloseIcon.svelte';
  import SearchIcon from '$lib/components/icons/SearchIcon.svelte';
  import {
    closeSearchModal,
    requestSearch,
    resetSearchState,
    searchMapState,
    searchState,
    setSearchQuery
  } from '$lib/stores/search';
  import { locale, t } from '$lib/i18n/index';
  import { toHumanArchitectureStyle } from '$lib/utils/architecture-style';

  const dispatch = createEventDispatcher();
  const DESKTOP_INTERACTIVE_MEDIA_QUERY = '(min-width: 768px)';
  const SEARCH_VISIBLE_PRIORITY_LIMIT = 120;
  const SEARCH_RENDER_LIMIT = 200;

  let debounceTimer = null;
  let searchInputEl = null;
  let hadOpenState;
  let isDesktopInteractive = false;
  let removeDesktopMediaListener = null;
  let displayedResults;
  let visibleResultsTotal;
  let queryIsActive;
  let showVisibleMapStatus;
  let visibleListLimited;

  function onDialogKeydown(event) {
    if (event.key === 'Escape') {
      closeSearchModal();
    }
  }

  function onSearchSubmit(event) {
    event.preventDefault();
    const text = String($searchState.query || '').trim();
    requestSearch({ query: text, append: false });
  }

  function onSearchInput(event) {
    const text = String(event.currentTarget.value || '').slice(0, 120);
    setSearchQuery(text);
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      const normalized = String(text || '').trim();
      if (normalized.length === 0) {
        resetSearchState($t('search.minChars'));
        return;
      }
      requestSearch({ query: normalized, append: false });
    }, 320);
  }

  function loadMore() {
    requestSearch({ query: $searchState.query, append: true });
  }

  function selectResult(item) {
    dispatch('selectResult', item);
  }

  function getItemKey(item) {
    const osmType = String(item?.osmType || '').trim();
    const osmId = Number(item?.osmId);
    if (!osmType || !Number.isInteger(osmId) || osmId <= 0) return '';
    return `${osmType}/${osmId}`;
  }

  function buildDisplayedResults(visibleItems, searchItems) {
    const entries = [];
    const seen = new Set();
    let visibleCount = 0;

    for (const item of Array.isArray(visibleItems) ? visibleItems : []) {
      const key = getItemKey(item);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      entries.push({
        key,
        item,
        visibleOnMap: true
      });
      visibleCount += 1;
      if (visibleCount >= SEARCH_VISIBLE_PRIORITY_LIMIT || entries.length >= SEARCH_RENDER_LIMIT) {
        break;
      }
    }

    for (const item of Array.isArray(searchItems) ? searchItems : []) {
      if (entries.length >= SEARCH_RENDER_LIMIT) break;
      const key = getItemKey(item);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      entries.push({
        key,
        item,
        visibleOnMap: false
      });
    }

    return entries;
  }

  function updateDesktopInteractiveState(matches = false) {
    isDesktopInteractive = Boolean(matches);
  }

  onMount(() => {
    if (!browser || typeof window.matchMedia !== 'function') return undefined;
    const mediaQuery = window.matchMedia(DESKTOP_INTERACTIVE_MEDIA_QUERY);
    const handleChange = (event) => {
      updateDesktopInteractiveState(event.matches);
    };
    updateDesktopInteractiveState(mediaQuery.matches);

    if (typeof mediaQuery.addEventListener === 'function') {
      mediaQuery.addEventListener('change', handleChange);
      removeDesktopMediaListener = () => mediaQuery.removeEventListener('change', handleChange);
    } else if (typeof mediaQuery.addListener === 'function') {
      mediaQuery.addListener(handleChange);
      removeDesktopMediaListener = () => mediaQuery.removeListener(handleChange);
    }

    return () => {
      removeDesktopMediaListener?.();
      removeDesktopMediaListener = null;
    };
  });

  onDestroy(() => {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    removeDesktopMediaListener?.();
    removeDesktopMediaListener = null;
  });

  $: if ($searchState.modalOpen && !hadOpenState) {
    hadOpenState = true;
    tick().then(() => searchInputEl?.focus());
  } else if (!$searchState.modalOpen && hadOpenState) {
    hadOpenState = false;
  }
  $: void hadOpenState;

  $: displayedResults = buildDisplayedResults($searchMapState.items, $searchState.items);
  $: visibleResultsTotal = Math.max(0, Number($searchMapState.total || 0));
  $: queryIsActive = String($searchState.query || '').trim().length >= 2;
  $: visibleListLimited = Boolean($searchMapState.truncated || visibleResultsTotal > SEARCH_VISIBLE_PRIORITY_LIMIT);
  $: showVisibleMapStatus = queryIsActive && ($searchMapState.loading || visibleResultsTotal > 0 || $searchMapState.truncated);
</script>

{#if $searchState.modalOpen}
  <div id="search-modal" class="search-backdrop">
    {#if !isDesktopInteractive}
      <button
        type="button"
        class="search-dismiss-layer"
        tabindex="-1"
        aria-label={$t('common.close')}
        on:click={closeSearchModal}
      ></button>
    {/if}

    <div
      class="search-modal"
      role="dialog"
      tabindex="-1"
      aria-modal={isDesktopInteractive ? 'false' : 'true'}
      aria-label={$t('search.modalAriaLabel')}
      on:keydown={onDialogKeydown}
    >
      <div class="search-handle" aria-hidden="true"></div>

      <header class="search-head">
        <div class="search-head-copy">
          <p class="ui-kicker">{$t('common.search')}</p>
          <h3>{$t('search.modalTitle')}</h3>
        </div>
        <UiButton
          type="button"
          variant="secondary"
          size="close"
          className="shrink-0"
          onclick={closeSearchModal}
          aria-label={$t('common.close')}
        >
          <CloseIcon class="ui-close-icon" />
        </UiButton>
      </header>

      <form class="search-form" on:submit={onSearchSubmit}>
        <div class="search-field-shell">
          <SearchIcon width="16" height="16" />
          <UiInput
            id="search-modal-input"
            bind:this={searchInputEl}
            type="search"
            placeholder={$t('search.inputPlaceholder')}
            value={$searchState.query}
            className="border-0 bg-transparent px-0 shadow-none hover:bg-transparent focus:bg-transparent focus-visible:ring-0 focus-visible:ring-offset-0"
            oninput={onSearchInput}
          />
        </div>
      </form>

      <div class="search-meta">
        <div class="search-meta-copy">
          <p id="search-results-status" class="search-status">{$searchState.status}</p>
          {#if showVisibleMapStatus}
            <p class="search-viewport-status" data-loading={$searchMapState.loading ? 'true' : 'false'}>
              {#if $searchMapState.loading}
                {$t('search.visibleLoading')}
              {:else}
                {$t('search.visibleNow', { count: visibleResultsTotal })}
                {#if visibleListLimited}
                  <span class="search-viewport-status-note">{$t('search.visibleTruncated')}</span>
                {/if}
              {/if}
            </p>
          {/if}
        </div>
        {#if $searchState.total > 0}
          <span class="search-total">{$searchState.total}</span>
        {/if}
      </div>

      <UiScrollArea
        id="search-results-list"
        className="min-h-0 [overscroll-behavior:contain]"
        contentClassName="grid content-start gap-[0.65rem] pr-[0.2rem]"
      >
        {#if $searchState.loading}
          <div class="search-empty search-empty-loading">{$t('search.loading')}</div>
        {:else if displayedResults.length === 0}
          <div class="search-empty">{$t('search.notFound')}</div>
        {:else}
          {#each displayedResults as entry (entry.key)}
            <button type="button" class="search-item" on:click={() => selectResult(entry.item)}>
              <div class="search-item-head">
                <div>
                  <div class="search-item-title">{entry.item.name || $t('search.untitled')}</div>
                  <div class="search-item-key">{entry.item.osmType}/{entry.item.osmId}</div>
                </div>
                <UiBadge
                  variant="accent"
                  className="whitespace-nowrap rounded-full px-[0.72rem] py-[0.42rem] text-[0.76rem] font-bold [background:var(--accent-soft)] [color:var(--accent-ink)]"
                >
                  {$t('search.toBuilding')}
                </UiBadge>
              </div>

              <div class="search-item-body">
                {#if entry.item.address}
                  <div class="search-item-line">
                    <span class="search-item-label">{$t('search.address')}</span>
                    <span>{entry.item.address}</span>
                  </div>
                {/if}

                <div class="search-badges">
                  {#if entry.visibleOnMap}
                    <UiBadge
                      variant="accent"
                      className="inline-flex flex-wrap gap-[0.3rem] rounded-full border px-[0.62rem] py-[0.42rem] text-[0.76rem] leading-[1.25] [border-color:color-mix(in_srgb,var(--accent)_26%,var(--panel-border))] [background:var(--accent-soft)] [color:var(--accent-ink)]"
                    >
                      <strong class="[color:var(--fg-strong)]">{$t('search.visibleOnMap')}</strong>
                    </UiBadge>
                  {/if}

                  {#if entry.item.style}
                    <UiBadge
                      variant="default"
                      className="inline-flex flex-wrap gap-[0.3rem] rounded-full border px-[0.62rem] py-[0.42rem] text-[0.76rem] leading-[1.25] [border-color:var(--panel-border)] [background:var(--panel-solid)] [color:var(--muted-strong)]"
                    >
                      <strong class="[color:var(--fg-strong)]">{$t('search.style')}</strong>
                      {toHumanArchitectureStyle(entry.item.style, $locale) || entry.item.style}
                    </UiBadge>
                  {/if}

                  {#if entry.item.architect}
                    <UiBadge
                      variant="default"
                      className="inline-flex flex-wrap gap-[0.3rem] rounded-full border px-[0.62rem] py-[0.42rem] text-[0.76rem] leading-[1.25] [border-color:var(--panel-border)] [background:var(--panel-solid)] [color:var(--muted-strong)]"
                    >
                      <strong class="[color:var(--fg-strong)]">{$t('search.architect')}</strong>
                      {entry.item.architect}
                    </UiBadge>
                  {/if}

                  {#if entry.item.designRef}
                    <UiBadge
                      variant="default"
                      className="inline-flex flex-wrap gap-[0.3rem] rounded-full border px-[0.62rem] py-[0.42rem] text-[0.76rem] leading-[1.25] [border-color:var(--panel-border)] [background:var(--panel-solid)] [color:var(--muted-strong)]"
                    >
                      <strong class="[color:var(--fg-strong)]">{$t('buildingModal.designRef')}</strong>
                      {entry.item.designRef}
                    </UiBadge>
                  {/if}
                </div>
              </div>
            </button>
          {/each}
        {/if}
      </UiScrollArea>

      {#if $searchState.hasMore}
        <UiButton
          id="search-load-more-btn"
          type="button"
          variant="secondary"
          className="w-full justify-center"
          onclick={loadMore}
          disabled={$searchState.loadingMore}
        >
          {$searchState.loadingMore ? $t('search.loadingMore') : $t('search.loadMore')}
        </UiButton>
      {/if}
    </div>
  </div>
{/if}

<style>
  .search-backdrop {
    --search-modal-top-gap: calc(var(--desktop-nav-clearance) + 0.55rem);
    --search-modal-side-gap: 0.75rem;
    --search-modal-bottom-gap: calc(0.75rem + env(safe-area-inset-bottom, 0px));
    position: fixed;
    inset: 0;
    z-index: 980;
    display: flex;
    align-items: flex-start;
    justify-content: flex-start;
    padding: var(--search-modal-top-gap) var(--search-modal-side-gap) var(--search-modal-bottom-gap);
    background: transparent;
  }

  .search-dismiss-layer {
    position: absolute;
    inset: 0;
    border: 0;
    padding: 0;
    background: transparent;
  }

  .search-modal {
    position: relative;
    z-index: 1;
    width: 100%;
    height: calc(100vh - var(--search-modal-top-gap) - var(--search-modal-bottom-gap));
    height: calc(100dvh - var(--search-modal-top-gap) - var(--search-modal-bottom-gap));
    max-height: calc(100vh - var(--search-modal-top-gap) - var(--search-modal-bottom-gap));
    max-height: calc(100dvh - var(--search-modal-top-gap) - var(--search-modal-bottom-gap));
    overflow: hidden;
    display: grid;
    grid-template-rows: auto auto auto minmax(0, 1fr) auto;
    gap: 0.8rem;
    padding: 0.95rem 1rem 1rem;
    border: 1px solid var(--panel-border);
    border-radius: 1.35rem;
    background: var(--panel-solid);
    box-shadow: var(--shadow-panel);
    overscroll-behavior: contain;
  }

  .search-handle {
    display: none;
  }

  .search-head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 0.75rem;
  }

  .search-head-copy {
    display: grid;
    gap: 0.2rem;
  }

  .search-head h3 {
    margin: 0;
    font-size: 1.15rem;
    color: var(--fg-strong);
  }

  .search-form {
    margin: 0;
  }

  .search-field-shell {
    display: flex;
    align-items: center;
    gap: 0.65rem;
    padding: 0 0.3rem 0 0.9rem;
    border: 1px solid var(--panel-border);
    border-radius: 999px;
    background: var(--panel-solid);
    color: var(--muted);
  }

  .search-meta {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
    min-height: 1.5rem;
  }

  .search-meta-copy {
    min-width: 0;
    display: grid;
    gap: 0.18rem;
  }

  .search-status {
    margin: 0;
    color: var(--muted);
    font-size: 0.84rem;
  }

  .search-viewport-status {
    margin: 0;
    color: var(--accent-ink);
    font-size: 0.76rem;
    font-weight: 600;
  }

  .search-viewport-status[data-loading='true'] {
    color: var(--muted);
  }

  .search-viewport-status-note {
    color: var(--muted);
    font-weight: 500;
  }

  .search-total {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 1.9rem;
    padding: 0.25rem 0.55rem;
    border-radius: 999px;
    background: var(--accent-soft);
    color: var(--accent-ink);
    font-size: 0.76rem;
    font-weight: 700;
  }

  .search-item {
    width: 100%;
    text-align: left;
    display: grid;
    gap: 0.8rem;
    padding: 0.85rem 0.95rem;
    border: 1px solid var(--panel-border);
    border-radius: 1.1rem;
    background: var(--panel-solid);
    box-shadow: 0 10px 24px rgba(15, 23, 42, 0.06);
    cursor: pointer;
    transition: transform 0.18s ease, border-color 0.18s ease, box-shadow 0.18s ease, background-color 0.18s ease;
  }

  .search-item:hover,
  .search-item:focus-visible {
    transform: translateY(-1px);
    border-color: color-mix(in srgb, var(--accent) 30%, var(--panel-border));
    box-shadow: 0 16px 36px rgba(15, 23, 42, 0.1);
    outline: none;
  }

  .search-item-head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 0.75rem;
  }

  .search-item-title {
    font-weight: 800;
    font-size: 0.98rem;
    color: var(--fg-strong);
  }

  .search-item-key {
    margin-top: 0.18rem;
    color: var(--muted);
    font-size: 0.73rem;
  }

  .search-item-body {
    display: grid;
    gap: 0.55rem;
  }

  .search-item-line {
    display: grid;
    gap: 0.18rem;
    color: var(--muted-strong);
    font-size: 0.82rem;
    line-height: 1.35;
  }

  .search-item-label {
    font-size: 0.7rem;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--muted);
  }

  .search-badges {
    display: flex;
    flex-wrap: wrap;
    gap: 0.45rem;
  }

  .search-empty {
    padding: 1rem;
    border-radius: 1rem;
    border: 1px dashed var(--panel-border-strong);
    background: var(--panel-solid);
    color: var(--muted);
    font-size: 0.88rem;
  }

  .search-empty-loading {
    border-style: solid;
  }

  @media (min-width: 768px) {
    .search-backdrop {
      --search-modal-top-gap: calc(var(--desktop-nav-clearance) + var(--desktop-surface-gap));
      --search-modal-side-gap: 0.85rem;
      --search-modal-bottom-gap: 0.85rem;
      background: transparent;
      pointer-events: none;
    }

    .search-modal {
      width: clamp(25rem, 32vw, 31rem);
      pointer-events: auto;
    }

    .search-dismiss-layer {
      display: none;
    }
  }

  @media (max-width: 520px) {
    .search-item-head {
      flex-direction: column;
    }

  }
</style>
