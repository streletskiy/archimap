import { get, writable } from 'svelte/store';
import { translateNow } from '$lib/i18n/index';
import { buildingFilterLayers, resetBuildingFilterLayers } from './filters';

const initialState = {
  modalOpen: false,
  query: '',
  scope: 'global',
  bboxHash: '',
  items: [],
  total: 0,
  hasMore: false,
  nextCursor: null,
  loading: false,
  loadingMore: false,
  mapActive: false,
  status: translateNow('search.minChars'),
  error: '',
  fitSeq: 0
};

const initialMapState = {
  query: '',
  bboxHash: '',
  items: [],
  total: 0,
  truncated: false,
  loading: false,
  error: ''
};

export const searchState = writable(initialState);
export const searchCommand = writable(null);
export const searchMapState = writable(initialMapState);

function buildFoundStatus(count, total) {
  const loadedCount = Math.max(0, Number(count) || 0);
  const totalCount = Math.max(loadedCount, Number(total) || 0);
  const base = translateNow('search.found', { count: loadedCount });
  return totalCount > loadedCount ? `${base} / ${totalCount}` : base;
}

export function setSearchQuery(value) {
  const next = String(value || '').slice(0, 120);
  searchState.update((state) => ({
    ...state,
    query: next
  }));
}

export function openSearchModal(prefill: string = '') {
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

export function resetSearchState(message = translateNow('search.minChars')) {
  searchState.update((state) => ({
    ...state,
    items: [],
    scope: 'global',
    bboxHash: '',
    total: 0,
    hasMore: false,
    nextCursor: null,
    loading: false,
    loadingMore: false,
    mapActive: false,
    status: String(message || translateNow('search.minChars')),
    error: ''
  }));
}

export function setSearchLoading({ append = false, background = false }: LooseRecord = {}) {
  searchState.update((state) => ({
    ...state,
    loading: background ? false : !append,
    loadingMore: Boolean(append),
    mapActive: true,
    error: '',
    status: append
      ? buildFoundStatus(state.items.length, state.total)
      : translateNow('search.searching')
  }));
}

export function applySearchResults({
  query,
  items,
  total,
  hasMore,
  nextCursor,
  append = false,
  scope = 'global',
  bboxHash = '',
  fit = !append
}: LooseRecord) {
  const inputItems = Array.isArray(items) ? items : [];
  searchState.update((state) => {
    const nextItems = append ? state.items.concat(inputItems) : inputItems;
    const nextTotal = Math.max(
      nextItems.length,
      append ? Math.max(Number(state.total) || 0, Number(total) || 0) : (Number(total) || 0)
    );
    return {
      ...state,
      query: String(query || '').slice(0, 120),
      scope: append ? state.scope : String(scope || 'global'),
      bboxHash: append ? state.bboxHash : String(bboxHash || ''),
      items: nextItems,
      total: nextTotal,
      hasMore: Boolean(hasMore),
      nextCursor: Number.isFinite(Number(nextCursor)) ? Number(nextCursor) : null,
      loading: false,
      loadingMore: false,
      mapActive: true,
      error: '',
      status: nextItems.length > 0 ? buildFoundStatus(nextItems.length, nextTotal) : translateNow('search.notFound'),
      fitSeq: append || fit === false ? state.fitSeq : state.fitSeq + 1
    };
  });
}

export function setSearchError(message, { append = false }: LooseRecord = {}) {
  const text = String(message || translateNow('search.failed'));
  searchState.update((state) => ({
    ...state,
    loading: false,
    loadingMore: false,
    error: text,
    status: text,
    total: append ? state.total : 0,
    hasMore: append ? state.hasMore : false,
    nextCursor: append ? state.nextCursor : null,
    items: append ? state.items : []
  }));
}

export function resetSearchMapState() {
  searchMapState.set(initialMapState);
}

export function setSearchMapLoading({ query, bboxHash, preserveItems = true }: LooseRecord = {}) {
  searchMapState.update((state) => ({
    ...state,
    query: String(query || state.query || '').slice(0, 120),
    bboxHash: String(bboxHash || state.bboxHash || ''),
    loading: true,
    error: '',
    items: preserveItems ? state.items : [],
    total: preserveItems ? state.total : 0,
    truncated: preserveItems ? state.truncated : false
  }));
}

export function applySearchMapResults({ query, bboxHash, items, total, truncated = false }: LooseRecord) {
  const nextItems = Array.isArray(items) ? items : [];
  searchMapState.set({
    query: String(query || '').slice(0, 120),
    bboxHash: String(bboxHash || ''),
    items: nextItems,
    total: Math.max(nextItems.length, Number(total) || 0),
    truncated: Boolean(truncated),
    loading: false,
    error: ''
  });
}

export function setSearchMapError(message, { preserveItems = true }: LooseRecord = {}) {
  const text = String(message || translateNow('search.failed'));
  searchMapState.update((state) => ({
    ...state,
    loading: false,
    error: text,
    items: preserveItems ? state.items : [],
    total: preserveItems ? state.total : 0,
    truncated: preserveItems ? state.truncated : false
  }));
}

export function requestSearch({
  query,
  append = false,
  scope,
  fit,
  background = false,
  reason = 'manual'
}: LooseRecord) {
  const current = get(searchState);
  const resolvedScope = String(scope || (append ? current.scope : 'global') || 'global');
  const nextQuery = String(query || '').slice(0, 120);
  if (nextQuery.trim().length >= 2) {
    const currentFilters = get(buildingFilterLayers);
    if (Array.isArray(currentFilters) && currentFilters.length > 0) {
      resetBuildingFilterLayers();
    }
  }
  searchState.update((state) => ({
    ...state,
    mapActive: nextQuery.trim().length >= 2
  }));
  searchCommand.set({
    id: Date.now() + Math.random(),
    query: nextQuery,
    append: Boolean(append),
    scope: resolvedScope,
    fit: append ? false : fit !== false,
    background: Boolean(background),
    reason: String(reason || 'manual')
  });
}
