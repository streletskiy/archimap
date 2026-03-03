import { writable } from 'svelte/store';
import { UI_STRINGS } from '$lib/i18n/ui-strings';

const initialState = {
  modalOpen: false,
  query: '',
  items: [],
  hasMore: false,
  nextCursor: null,
  loading: false,
  loadingMore: false,
  status: UI_STRINGS.search.minChars,
  error: '',
  fitSeq: 0
};

export const searchState = writable(initialState);
export const searchCommand = writable(null);

export function setSearchQuery(value) {
  const next = String(value || '').slice(0, 120);
  searchState.update((state) => ({
    ...state,
    query: next
  }));
}

export function openSearchModal(prefill = '') {
  const text = String(prefill || '').slice(0, 120);
  searchState.update((state) => ({
    ...state,
    modalOpen: true,
    query: text || state.query
  }));
}

export function closeSearchModal() {
  searchState.update((state) => ({
    ...state,
    modalOpen: false
  }));
}

export function resetSearchState(message = UI_STRINGS.search.minChars) {
  searchState.update((state) => ({
    ...state,
    items: [],
    hasMore: false,
    nextCursor: null,
    loading: false,
    loadingMore: false,
    status: String(message || UI_STRINGS.search.minChars),
    error: ''
  }));
}

export function setSearchLoading({ append = false } = {}) {
  searchState.update((state) => ({
    ...state,
    loading: !append,
    loadingMore: Boolean(append),
    error: '',
    status: append ? UI_STRINGS.search.found(state.items.length) : UI_STRINGS.search.searching
  }));
}

export function applySearchResults({ query, items, hasMore, nextCursor, append = false }) {
  const inputItems = Array.isArray(items) ? items : [];
  searchState.update((state) => {
    const nextItems = append ? state.items.concat(inputItems) : inputItems;
    return {
      ...state,
      query: String(query || '').slice(0, 120),
      items: nextItems,
      hasMore: Boolean(hasMore),
      nextCursor: Number.isFinite(Number(nextCursor)) ? Number(nextCursor) : null,
      loading: false,
      loadingMore: false,
      error: '',
      status: nextItems.length > 0 ? UI_STRINGS.search.found(nextItems.length) : UI_STRINGS.search.notFound,
      fitSeq: append ? state.fitSeq : state.fitSeq + 1
    };
  });
}

export function setSearchError(message, { append = false } = {}) {
  const text = String(message || UI_STRINGS.search.failed);
  searchState.update((state) => ({
    ...state,
    loading: false,
    loadingMore: false,
    error: text,
    status: text,
    hasMore: append ? state.hasMore : false,
    nextCursor: append ? state.nextCursor : null,
    items: append ? state.items : []
  }));
}

export function requestSearch({ query, append = false }) {
  searchCommand.set({
    id: Date.now() + Math.random(),
    query: String(query || ''),
    append: Boolean(append)
  });
}
