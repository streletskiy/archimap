<script>
  import { createEventDispatcher } from 'svelte';
  import { searchState, closeSearchModal, requestSearch, resetSearchState, setSearchQuery } from '$lib/stores/search';
  import { locale, t } from '$lib/i18n/index';
  import { toHumanArchitectureStyle } from '$lib/utils/architecture-style';

  const dispatch = createEventDispatcher();
  let debounceTimer = null;

  function onBackdropClick(event) {
    if (event.target === event.currentTarget) {
      closeSearchModal();
    }
  }

  function onBackdropKeydown(event) {
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
</script>

{#if $searchState.modalOpen}
  <div id="search-modal" class="search-backdrop" role="button" tabindex="0" on:click={onBackdropClick} on:keydown={onBackdropKeydown}>
    <div class="search-modal" role="dialog" aria-modal="true" aria-label={$t('search.modalAriaLabel')}>
      <header class="search-head">
        <h3>{$t('search.modalTitle')}</h3>
        <button type="button" class="ui-btn ui-btn-secondary ui-btn-xs" on:click={closeSearchModal}>{$t('common.close')}</button>
      </header>

      <form class="search-form" on:submit={onSearchSubmit}>
        <input
          id="search-modal-input"
          class="ui-field"
          type="search"
          placeholder={$t('search.inputPlaceholder')}
          value={$searchState.query}
          on:input={onSearchInput}
        />
      </form>

      <p id="search-results-status" class="search-status">{$searchState.status}</p>

      <div id="search-results-list" class="search-results-list">
        {#if $searchState.loading}
          <div class="search-skeleton">{$t('search.loading')}</div>
        {:else if $searchState.items.length === 0}
          <div class="search-empty">{$t('search.notFound')}</div>
        {:else}
          {#each $searchState.items as item (`${item.osmType}/${item.osmId}`)}
            <article class="search-item">
              <div class="search-item-title">{item.name || $t('search.untitled')}</div>
              <div class="search-item-line">
                {#if item.address}{$t('search.address')}: {item.address}{/if}
                {#if item.address && item.style} • {/if}
                {#if item.style}{$t('search.style')}: {toHumanArchitectureStyle(item.style, $locale) || item.style}{/if}
              </div>
              {#if item.architect}
                <div class="search-item-line">{$t('search.architect')}: {item.architect}</div>
              {/if}
              <div class="search-item-actions">
                <span class="search-item-key">{item.osmType}/{item.osmId}</span>
                <button type="button" class="ui-btn ui-btn-secondary ui-btn-xs" on:click={() => selectResult(item)}>{$t('search.toBuilding')}</button>
              </div>
            </article>
          {/each}
        {/if}
      </div>

      {#if $searchState.hasMore}
        <button
          id="search-load-more-btn"
          type="button"
          class="ui-btn ui-btn-secondary"
          on:click={loadMore}
          disabled={$searchState.loadingMore}
        >
          {$searchState.loadingMore ? $t('search.loadingMore') : $t('search.loadMore')}
        </button>
      {/if}
    </div>
  </div>
{/if}

<style>
  .search-backdrop {
    position: fixed;
    inset: 0;
    z-index: 70;
    background: rgba(15, 23, 42, 0.35);
    display: grid;
    place-items: center;
    padding: 0.75rem;
  }

  .search-modal {
    width: min(35rem, 100%);
    max-height: calc(100vh - 6rem);
    overflow: auto;
    border-radius: 1rem;
    border: 1px solid #e2e8f0;
    background: #ffffff;
    box-shadow: 0 20px 40px rgba(15, 23, 42, 0.12);
    padding: 0.85rem;
    display: grid;
    gap: 0.65rem;
  }

  .search-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
  }

  .search-head h3 {
    margin: 0;
  }

  .search-form {
    margin: 0;
  }

  .search-status {
    margin: 0;
    color: #64748b;
    font-size: 0.85rem;
  }

  .search-results-list {
    display: grid;
    gap: 0.5rem;
    min-height: 8rem;
    align-content: start;
  }

  .search-item {
    border: 1px solid #e2e8f0;
    border-radius: 1rem;
    background: #ffffff;
    padding: 0.7rem;
  }

  .search-item-title {
    font-weight: 700;
    font-size: 0.9rem;
    color: #0f172a;
    margin-bottom: 0.3rem;
  }

  .search-item-line {
    font-size: 0.76rem;
    color: #334155;
    margin-bottom: 0.25rem;
  }

  .search-item-actions {
    margin-top: 0.35rem;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
  }

  .search-item-key {
    font-size: 0.7rem;
    color: #64748b;
  }

  .search-empty,
  .search-skeleton {
    border: 1px dashed #cbd5e1;
    border-radius: 0.8rem;
    padding: 0.75rem;
    color: #64748b;
    font-size: 0.85rem;
  }

  @media (min-width: 768px) {
    .search-backdrop {
      place-items: end start;
      padding: 5.15rem 0.75rem 0.75rem;
      background: transparent;
      pointer-events: none;
    }

    .search-modal {
      pointer-events: auto;
      max-height: calc(100vh - 6rem);
    }
  }

  :global(html[data-theme='dark']) .search-backdrop {
    background: rgba(2, 6, 23, 0.68);
  }

  :global(html[data-theme='dark']) .search-modal {
    border-color: #334155;
    background: #111a2d;
    box-shadow: 0 20px 40px rgba(2, 6, 23, 0.62);
    color: #e2e8f0;
  }

  :global(html[data-theme='dark']) .search-status,
  :global(html[data-theme='dark']) .search-item-line,
  :global(html[data-theme='dark']) .search-item-key,
  :global(html[data-theme='dark']) .search-empty,
  :global(html[data-theme='dark']) .search-skeleton {
    color: #94a3b8;
  }

  :global(html[data-theme='dark']) .search-item {
    border-color: #334155;
    background: #0f172a;
  }

  :global(html[data-theme='dark']) .search-item-title {
    color: #e2e8f0;
  }

  :global(html[data-theme='dark']) .search-empty,
  :global(html[data-theme='dark']) .search-skeleton {
    border-color: #334155;
    background: #0f172a;
  }

  :global(html[data-theme='dark']) .search-form .ui-field {
    border-color: #334155;
    background: #0f172a;
    color: #e2e8f0;
  }

  :global(html[data-theme='dark']) .search-form .ui-field::placeholder {
    color: #94a3b8;
  }

  @media (min-width: 768px) {
    :global(html[data-theme='dark']) .search-backdrop {
      background: transparent;
    }
  }
</style>
