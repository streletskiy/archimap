import { get } from 'svelte/store';
import { translateNow } from '$lib/i18n/index';
import { apiJsonCached } from '$lib/services/http';
import { mapCenter, mapReady, mapViewport } from '$lib/stores/map';
import {
  applySearchMapResults,
  applySearchResults,
  requestSearch,
  resetSearchMapState,
  resetSearchState,
  searchCommand,
  searchMapState,
  searchState,
  setSearchError,
  setSearchLoading,
  setSearchMapError,
  setSearchMapLoading
} from '$lib/stores/search';
import {
  filterSearchItemsByStyleKey,
  filterSearchItemsByStyleKeys,
  resolveArchitectureStyleSearchKey,
  resolveArchitectureStyleSearchKeys
} from '$lib/utils/architecture-style';

const SEARCH_PAGE_SIZE = 120;
const SEARCH_MAP_RESULTS_LIMIT = 5000;
const SEARCH_VIEWPORT_REFRESH_DEBOUNCE_MS = 260;

function isAbortError(error) {
  return String(error?.name || '').toLowerCase() === 'aborterror';
}

function normalizeSearchViewport(viewport) {
  const west = Number(viewport?.west);
  const south = Number(viewport?.south);
  const east = Number(viewport?.east);
  const north = Number(viewport?.north);
  if (![west, south, east, north].every(Number.isFinite) || west >= east || south >= north) {
    return null;
  }
  return { west, south, east, north };
}

function buildSearchViewportHash(viewport) {
  if (!viewport) return '';
  return [
    Number(viewport.west).toFixed(4),
    Number(viewport.south).toFixed(4),
    Number(viewport.east).toFixed(4),
    Number(viewport.north).toFixed(4)
  ].join(':');
}

function appendSearchViewportParams(params, viewport) {
  if (!viewport) return;
  params.set('west', String(viewport.west));
  params.set('south', String(viewport.south));
  params.set('east', String(viewport.east));
  params.set('north', String(viewport.north));
}

export function createSearchManager() {
  let activeSearchRequestToken = 0;
  let activeSearchAbortController = null;
  let activeSearchMapRequestToken = 0;
  let activeSearchMapAbortController = null;
  let searchViewportRefreshTimer = null;
  let searchMapRefreshTimer = null;
  let lastViewportRefreshKey = '';
  let lastSearchMapRefreshKey = '';
  let lastSearchCommandId = null;
  let stopViewportSearchSync = null;
  let stopCommandSync = null;
  let stopSearchStateSync = null;

  function scheduleViewportSearchRefresh(queryText) {
    if (searchViewportRefreshTimer) {
      clearTimeout(searchViewportRefreshTimer);
      searchViewportRefreshTimer = null;
    }
    searchViewportRefreshTimer = setTimeout(() => {
      searchViewportRefreshTimer = null;
      requestSearch({
        query: queryText,
        append: false,
        scope: 'viewport',
        fit: false,
        background: true,
        reason: 'viewport'
      });
    }, SEARCH_VIEWPORT_REFRESH_DEBOUNCE_MS);
  }

  function scheduleViewportSearchMapRefresh(queryText) {
    if (searchMapRefreshTimer) {
      clearTimeout(searchMapRefreshTimer);
      searchMapRefreshTimer = null;
    }
    searchMapRefreshTimer = setTimeout(() => {
      searchMapRefreshTimer = null;
      runSearchMapRequest(queryText, { background: true });
    }, SEARCH_VIEWPORT_REFRESH_DEBOUNCE_MS);
  }

  function syncSearchToViewport(viewportValue) {
    if (!get(mapReady)) return;
    const currentSearch = get(searchState);
    const currentMapSearch = get(searchMapState);
    const activeQuery = String(currentSearch.query || '').trim();
    const viewport = normalizeSearchViewport(viewportValue);
    const viewportHash = buildSearchViewportHash(viewport);
    const shouldRefreshViewportSearch = Boolean(
      viewport
      && viewportHash
      && activeQuery.length >= 2
      && String(currentSearch.bboxHash || '')
      && viewportHash !== String(currentSearch.bboxHash || '')
      && !currentSearch.loading
      && !currentSearch.loadingMore
    );

    if (shouldRefreshViewportSearch) {
      const refreshKey = `${activeQuery}|${viewportHash}`;
      if (refreshKey !== lastViewportRefreshKey) {
        lastViewportRefreshKey = refreshKey;
        scheduleViewportSearchRefresh(activeQuery);
      }
    }

    if (activeQuery.length < 2) {
      lastViewportRefreshKey = '';
      if (searchViewportRefreshTimer) {
        clearTimeout(searchViewportRefreshTimer);
        searchViewportRefreshTimer = null;
      }
    }

    const shouldRefreshMapSearch = Boolean(
      viewport
      && viewportHash
      && activeQuery.length >= 2
      && String(currentMapSearch.bboxHash || '')
      && viewportHash !== String(currentMapSearch.bboxHash || '')
      && !currentMapSearch.loading
    );

    if (shouldRefreshMapSearch) {
      const refreshKey = `${activeQuery}|${viewportHash}`;
      if (refreshKey !== lastSearchMapRefreshKey) {
        lastSearchMapRefreshKey = refreshKey;
        scheduleViewportSearchMapRefresh(activeQuery);
      }
      return;
    }

    if (activeQuery.length < 2) {
      lastSearchMapRefreshKey = '';
      if (searchMapRefreshTimer) {
        clearTimeout(searchMapRefreshTimer);
        searchMapRefreshTimer = null;
      }
    }
  }

  async function runSearchRequest(command) {
    const append = Boolean(command?.append);
    const text = String(command?.query || '').trim().slice(0, 120);
    const current = get(searchState);
    const scope = String(command?.scope || (append ? current.scope : 'global') || 'global');
    const fit = !append && command?.fit !== false;
    const background = !append && Boolean(command?.background);
    const styleSearchKey = resolveArchitectureStyleSearchKey(text);
    const styleSearchKeys = resolveArchitectureStyleSearchKeys(text);
    const searchQuery = String(styleSearchKey || text).slice(0, 120);
    if (text.length < 2) {
      resetSearchState(translateNow('search.minChars'));
      resetSearchMapState();
      lastViewportRefreshKey = '';
      lastSearchMapRefreshKey = '';
      return;
    }

    if (append && !current.hasMore) return;

    const center = get(mapCenter);
    const viewport = normalizeSearchViewport(get(mapViewport));
    const viewportHash = buildSearchViewportHash(viewport);
    const useViewportScope = scope === 'viewport' && Boolean(viewport);
    const cursor = append ? Number(current.nextCursor || 0) : 0;
    const token = ++activeSearchRequestToken;
    if (activeSearchAbortController) {
      activeSearchAbortController.abort();
    }
    activeSearchAbortController = new AbortController();
    const signal = activeSearchAbortController.signal;
    const hasStyleDictionaryMatch = styleSearchKeys.length > 0;

    if (hasStyleDictionaryMatch) {
      if (append) return;
      setSearchLoading({ append: false, background });
      try {
        const keysToQuery = styleSearchKeys.slice(0, 5);
        const chunks = await Promise.all(keysToQuery.map(async (key) => {
          const params = new URLSearchParams({
            q: String(key).slice(0, 120),
            limit: String(SEARCH_PAGE_SIZE)
          });
          if (Number.isFinite(Number(center?.lng)) && Number.isFinite(Number(center?.lat))) {
            params.set('lon', String(center.lng));
            params.set('lat', String(center.lat));
          }
          appendSearchViewportParams(params, useViewportScope ? viewport : null);
          const url = `/api/search-buildings?${params.toString()}`;
          const data = await apiJsonCached(url, {
            ttlMs: 10_000,
            signal
          });
          return Array.isArray(data?.items) ? data.items : [];
        }));
        if (token !== activeSearchRequestToken) return;

        const merged = [];
        const seen = new Set();
        for (const item of chunks.flat()) {
          const key = `${String(item?.osmType || '')}/${String(item?.osmId || '')}`;
          if (!key || seen.has(key)) continue;
          seen.add(key);
          merged.push(item);
        }

        const filtered = filterSearchItemsByStyleKeys(merged, styleSearchKeys);
        applySearchResults({
          query: text,
          items: filtered.slice(0, SEARCH_PAGE_SIZE),
          total: filtered.length,
          hasMore: false,
          nextCursor: null,
          append: false,
          scope,
          bboxHash: viewportHash,
          fit
        });
      } catch (error) {
        if (isAbortError(error)) return;
        if (token !== activeSearchRequestToken) return;
        setSearchError(error?.message || translateNow('mapPage.searchFailed'), {
          append: background
        });
      }
      return;
    }

    setSearchLoading({ append, background });
    const params = new URLSearchParams({
      q: searchQuery,
      limit: String(SEARCH_PAGE_SIZE)
    });
    if (Number.isFinite(Number(center?.lng)) && Number.isFinite(Number(center?.lat))) {
      params.set('lon', String(center.lng));
      params.set('lat', String(center.lat));
    }
    appendSearchViewportParams(params, useViewportScope ? viewport : null);
    if (append && cursor > 0) {
      params.set('cursor', String(cursor));
    }

    try {
      const url = `/api/search-buildings?${params.toString()}`;
      const data = await apiJsonCached(url, {
        ttlMs: 10_000,
        signal
      });
      if (token !== activeSearchRequestToken) return;
      const itemsRaw = Array.isArray(data?.items) ? data.items : [];
      const items = filterSearchItemsByStyleKey(itemsRaw, styleSearchKey);
      applySearchResults({
        query: text,
        items,
        total: data?.total,
        hasMore: Boolean(data?.hasMore),
        nextCursor: data?.nextCursor,
        append,
        scope,
        bboxHash: viewportHash,
        fit
      });
    } catch (error) {
      if (isAbortError(error)) return;
      if (token !== activeSearchRequestToken) return;
      setSearchError(error?.message || translateNow('mapPage.searchFailed'), {
        append: append || background
      });
    } finally {
      if (activeSearchAbortController?.signal === signal) {
        activeSearchAbortController = null;
      }
    }
  }

  async function runSearchMapRequest(queryText, { background = false } = {}) {
    const text = String(queryText || '').trim().slice(0, 120);
    if (text.length < 2) {
      resetSearchMapState();
      lastSearchMapRefreshKey = '';
      return;
    }

    const viewport = normalizeSearchViewport(get(mapViewport));
    const viewportHash = buildSearchViewportHash(viewport);
    if (!viewport || !viewportHash) {
      resetSearchMapState();
      return;
    }

    const center = get(mapCenter);
    const styleSearchKey = resolveArchitectureStyleSearchKey(text);
    const styleSearchKeys = resolveArchitectureStyleSearchKeys(text);
    const token = ++activeSearchMapRequestToken;
    if (activeSearchMapAbortController) {
      activeSearchMapAbortController.abort();
    }
    activeSearchMapAbortController = new AbortController();
    const signal = activeSearchMapAbortController.signal;

    setSearchMapLoading({
      query: text,
      bboxHash: viewportHash,
      preserveItems: background
    });

    try {
      if (styleSearchKeys.length > 0) {
        const keysToQuery = styleSearchKeys.slice(0, 5);
        const chunks = await Promise.all(keysToQuery.map(async (key) => {
          const params = new URLSearchParams({
            q: String(key).slice(0, 120),
            limit: String(SEARCH_MAP_RESULTS_LIMIT)
          });
          if (Number.isFinite(Number(center?.lng)) && Number.isFinite(Number(center?.lat))) {
            params.set('lon', String(center.lng));
            params.set('lat', String(center.lat));
          }
          appendSearchViewportParams(params, viewport);
          const data = await apiJsonCached(`/api/search-buildings-map?${params.toString()}`, {
            ttlMs: 10_000,
            signal
          });
          return {
            items: Array.isArray(data?.items) ? data.items : [],
            truncated: Boolean(data?.truncated)
          };
        }));
        if (token !== activeSearchMapRequestToken) return;

        const merged = [];
        const seen = new Set();
        for (const item of chunks.flatMap((chunk) => chunk.items)) {
          const key = `${String(item?.osmType || '')}/${String(item?.osmId || '')}`;
          if (!key || seen.has(key)) continue;
          seen.add(key);
          merged.push(item);
        }

        const filtered = filterSearchItemsByStyleKeys(merged, styleSearchKeys);
        applySearchMapResults({
          query: text,
          bboxHash: viewportHash,
          items: filtered.slice(0, SEARCH_MAP_RESULTS_LIMIT),
          total: filtered.length,
          truncated: chunks.some((chunk) => chunk.truncated) || filtered.length >= SEARCH_MAP_RESULTS_LIMIT
        });
        return;
      }

      const params = new URLSearchParams({
        q: String(styleSearchKey || text).slice(0, 120),
        limit: String(SEARCH_MAP_RESULTS_LIMIT)
      });
      if (Number.isFinite(Number(center?.lng)) && Number.isFinite(Number(center?.lat))) {
        params.set('lon', String(center.lng));
        params.set('lat', String(center.lat));
      }
      appendSearchViewportParams(params, viewport);
      const data = await apiJsonCached(`/api/search-buildings-map?${params.toString()}`, {
        ttlMs: 10_000,
        signal
      });
      if (token !== activeSearchMapRequestToken) return;

      const itemsRaw = Array.isArray(data?.items) ? data.items : [];
      const items = filterSearchItemsByStyleKey(itemsRaw, styleSearchKey);
      applySearchMapResults({
        query: text,
        bboxHash: viewportHash,
        items,
        total: data?.total,
        truncated: Boolean(data?.truncated) || (Number(data?.total || 0) > items.length)
      });
    } catch (error) {
      if (isAbortError(error)) return;
      if (token !== activeSearchMapRequestToken) return;
      setSearchMapError(error?.message || translateNow('mapPage.searchFailed'), {
        preserveItems: background
      });
    } finally {
      if (activeSearchMapAbortController?.signal === signal) {
        activeSearchMapAbortController = null;
      }
    }
  }

  function handleSearchCommand(command) {
    if (!command || command.id === lastSearchCommandId) return;
    lastSearchCommandId = command.id;
    runSearchRequest(command);
    if (!command.append) {
      runSearchMapRequest(command.query, {
        background: Boolean(command.background)
      });
    }
  }

  function start() {
    if (!stopViewportSearchSync) {
      stopViewportSearchSync = mapViewport.subscribe(syncSearchToViewport);
    }
    if (!stopCommandSync) {
      stopCommandSync = searchCommand.subscribe(handleSearchCommand);
    }
    if (!stopSearchStateSync) {
      stopSearchStateSync = searchState.subscribe((value) => {
        if (String(value?.query || '').trim().length < 2) {
          resetSearchMapState();
          lastSearchMapRefreshKey = '';
        }
      });
    }
  }

  function destroy() {
    if (activeSearchAbortController) {
      activeSearchAbortController.abort();
      activeSearchAbortController = null;
    }
    if (activeSearchMapAbortController) {
      activeSearchMapAbortController.abort();
      activeSearchMapAbortController = null;
    }
    if (searchViewportRefreshTimer) {
      clearTimeout(searchViewportRefreshTimer);
      searchViewportRefreshTimer = null;
    }
    if (searchMapRefreshTimer) {
      clearTimeout(searchMapRefreshTimer);
      searchMapRefreshTimer = null;
    }
    if (stopViewportSearchSync) {
      stopViewportSearchSync();
      stopViewportSearchSync = null;
    }
    if (stopCommandSync) {
      stopCommandSync();
      stopCommandSync = null;
    }
    if (stopSearchStateSync) {
      stopSearchStateSync();
      stopSearchStateSync = null;
    }
  }

  return {
    destroy,
    start
  };
}
