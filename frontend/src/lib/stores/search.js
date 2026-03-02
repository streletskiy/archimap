import { writable } from 'svelte/store';

const initialState = {
  modalOpen: false,
  query: '',
  items: [],
  hasMore: false,
  nextCursor: null,
  loading: false,
  loadingMore: false,
  status: 'Введите минимум 2 символа.',
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

export function resetSearchState(message = 'Введите минимум 2 символа.') {
  searchState.update((state) => ({
    ...state,
    items: [],
    hasMore: false,
    nextCursor: null,
    loading: false,
    loadingMore: false,
    status: String(message || 'Введите минимум 2 символа.'),
    error: ''
  }));
}

export function setSearchLoading({ append = false } = {}) {
  searchState.update((state) => ({
    ...state,
    loading: !append,
    loadingMore: Boolean(append),
    error: '',
    status: append ? `Найдено: ${state.items.length}` : 'Ищем по базе...'
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
      status: nextItems.length > 0 ? `Найдено: ${nextItems.length}` : 'Ничего не найдено.',
      fitSeq: append ? state.fitSeq : state.fitSeq + 1
    };
  });
}

export function setSearchError(message, { append = false } = {}) {
  const text = String(message || 'Не удалось выполнить поиск.');
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
