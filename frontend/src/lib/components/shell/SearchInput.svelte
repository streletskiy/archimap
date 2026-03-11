<script>
  import SearchIcon from '$lib/components/icons/SearchIcon.svelte';
  import { t, translateNow } from '$lib/i18n/index';
  import { openSearchModal, requestSearch, resetSearchState, setSearchQuery } from '$lib/stores/search';

  export let value = '';

  $: activeSearchText = String(value || '').trim();
  $: searchReady = activeSearchText.length >= 2;

  function submitSearch(event) {
    event.preventDefault();
    const text = String(value || '').trim().slice(0, 120);
    setSearchQuery(text);
    openSearchModal(text);
    requestSearch({ query: text, append: false });
  }

  function onSearchInput(event) {
    const text = String(event.currentTarget.value || '').slice(0, 120);
    value = text;
    setSearchQuery(text);
    if (String(text).trim().length === 0) {
      resetSearchState(translateNow('search.minChars'));
    }
  }
</script>

<form class="search" on:submit={submitSearch}>
  <SearchIcon width="16" height="16" />
  <input
    type="search"
    placeholder={$t('header.searchPlaceholder')}
    bind:value
    on:input={onSearchInput}
  />
  {#if searchReady}
    <button type="submit" class="search-submit">{$t('common.search')}</button>
  {/if}
</form>

<style>
  .search {
    display: flex;
    align-items: center;
    gap: 0.65rem;
    min-width: 0;
    width: 100%;
    height: 3rem;
    padding: 0.25rem 0.35rem 0.25rem 0.95rem;
    border: 1px solid var(--panel-border);
    border-radius: 999px;
    background: color-mix(in srgb, var(--panel-solid) 82%, transparent);
    color: var(--muted);
  }

  .search input {
    min-width: 0;
    width: 100%;
    border: 0;
    outline: 0;
    background: transparent;
    color: var(--fg-strong);
    font-size: 0.92rem;
  }

  .search input::placeholder {
    color: var(--muted);
  }

  .search-submit {
    border: 0;
    padding: 0.62rem 0.95rem;
    border-radius: 999px;
    background: linear-gradient(135deg, var(--accent) 0%, var(--accent-brass) 100%);
    color: var(--accent-contrast);
    font-size: 0.8rem;
    font-weight: 700;
    cursor: pointer;
  }

  @media (max-width: 768px) {
    .search {
      display: none;
    }
  }
</style>
