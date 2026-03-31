import { get } from 'svelte/store';
import { translateNow } from '$lib/i18n/index';
import { apiJsonCached } from '$lib/services/http';
import {
  buildSearchRequestParams,
  buildSearchViewportHash,
  mergeChunkedSearchResults,
  normalizeSearchViewport
} from '$lib/services/search-params';
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
import { isAbortError } from '$lib/utils/error';
import { clampText } from '$lib/utils/text';
import { searchOverpassBuildings } from '$lib/services/map/overpass-buildings';

const SEARCH_PAGE_SIZE = 120;
const SEARCH_MAP_RESULTS_LIMIT = 5000;
const SEARCH_VIEWPORT_REFRESH_DEBOUNCE_MS = 260;

function getSearchItemKey(item) {
  const osmType = String(item?.osmType || '').trim();
  const osmId = Number(item?.osmId);
  if (!osmType || !Number.isInteger(osmId) || osmId <= 0) return '';
  return `${osmType}/${osmId}`;
}

function mergeSearchItems(primaryItems, secondaryItems) {
  const merged = [];
  const seen = new Set();
  for (const item of [...(Array.isArray(primaryItems) ? primaryItems : []), ...(Array.isArray(secondaryItems) ? secondaryItems : [])]) {
    const key = getSearchItemKey(item);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    merged.push(item);
  }
  return merged;
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
  let lastSearchMapActive = false;
  let stopViewportSearchSync = null;
  let stopCommandSync = null;
  let stopSearchStateSync = null;

  function clearSearchTimers() {
    if (searchViewportRefreshTimer) {
      clearTimeout(searchViewportRefreshTimer);
      searchViewportRefreshTimer = null;
    }
    if (searchMapRefreshTimer) {
      clearTimeout(searchMapRefreshTimer);
      searchMapRefreshTimer = null;
    }
  }

  function invalidateSearchRequests() {
    activeSearchRequestToken += 1;
    activeSearchMapRequestToken += 1;
  }

  function abortSearchRequests({ resetMapState = false }: { resetMapState?: boolean } = {}) {
    if (activeSearchAbortController) {
      activeSearchAbortController.abort();
      activeSearchAbortController = null;
    }
    if (activeSearchMapAbortController) {
      activeSearchMapAbortController.abort();
      activeSearchMapAbortController = null;
    }
    clearSearchTimers();
    invalidateSearchRequests();
    lastViewportRefreshKey = '';
    lastSearchMapRefreshKey = '';
    if (resetMapState) {
      resetSearchMapState();
    }
  }

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
    const searchEnabled = Boolean(currentSearch?.mapActive) && activeQuery.length >= 2;
    const viewport = normalizeSearchViewport(viewportValue);
    const viewportHash = buildSearchViewportHash(viewport);
    const shouldRefreshViewportSearch = Boolean(
      viewport
      && viewportHash
      && searchEnabled
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

    if (!searchEnabled) {
      lastViewportRefreshKey = '';
      if (searchViewportRefreshTimer) {
        clearTimeout(searchViewportRefreshTimer);
        searchViewportRefreshTimer = null;
      }
    }

    const shouldRefreshMapSearch = Boolean(
      viewport
      && viewportHash
      && searchEnabled
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

    if (!searchEnabled) {
      lastSearchMapRefreshKey = '';
      if (searchMapRefreshTimer) {
        clearTimeout(searchMapRefreshTimer);
        searchMapRefreshTimer = null;
      }
    }
  }

  async function runSearchRequest(command) {
    const append = Boolean(command?.append);
    const text = clampText(command?.query);
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
          const params = buildSearchRequestParams({
            query: String(key || ''),
            center,
            viewport: useViewportScope ? viewport : null,
            limit: SEARCH_PAGE_SIZE
          });
          const url = `/api/search-buildings?${params.toString()}`;
          const data = await apiJsonCached(url, {
            ttlMs: 10_000,
            signal
          });
          return Array.isArray(data?.items) ? data.items : [];
        }));
        if (token !== activeSearchRequestToken) return;
        const merged = mergeChunkedSearchResults(chunks);
        const localOverpassItems = searchOverpassBuildings(text).filter(Boolean);
        const filtered = filterSearchItemsByStyleKeys(
          mergeSearchItems(merged, localOverpassItems),
          styleSearchKeys
        );
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
    const params = buildSearchRequestParams({
      query: searchQuery,
      center,
      viewport: useViewportScope ? viewport : null,
      limit: SEARCH_PAGE_SIZE,
      cursor: append ? cursor : null
    });

    try {
      const url = `/api/search-buildings?${params.toString()}`;
      const data = await apiJsonCached(url, {
        ttlMs: 10_000,
        signal
      });
      if (token !== activeSearchRequestToken) return;
      const itemsRaw = Array.isArray(data?.items) ? data.items : [];
      const localOverpassItems = append ? [] : searchOverpassBuildings(text);
      const items = filterSearchItemsByStyleKey(
        mergeSearchItems(itemsRaw, localOverpassItems),
        styleSearchKey
      );
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

  async function runSearchMapRequest(queryText, { background = false }: LooseRecord = {}) {
    const text = clampText(queryText);
    if (text.length < 2) {
      resetSearchMapState();
      lastSearchMapRefreshKey = '';
      return;
    }
    if (!get(searchState)?.mapActive) {
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
          const params = buildSearchRequestParams({
            query: String(key || ''),
            center,
            viewport,
            limit: SEARCH_MAP_RESULTS_LIMIT
          });
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
        const merged = mergeChunkedSearchResults(chunks);

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

      const params = buildSearchRequestParams({
        query: String(styleSearchKey || text),
        center,
        viewport,
        limit: SEARCH_MAP_RESULTS_LIMIT
      });
      const data = await apiJsonCached(`/api/search-buildings-map?${params.toString()}`, {
        ttlMs: 10_000,
        signal
      });
      if (token !== activeSearchMapRequestToken) return;

      const itemsRaw = Array.isArray(data?.items) ? data.items : [];
      const localOverpassItems = searchOverpassBuildings(text, {
        viewport,
        limit: SEARCH_MAP_RESULTS_LIMIT
      });
      const items = filterSearchItemsByStyleKey(
        mergeSearchItems(itemsRaw, localOverpassItems),
        styleSearchKey
      );
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
      lastSearchMapActive = Boolean(get(searchState)?.mapActive);
      stopSearchStateSync = searchState.subscribe((value) => {
        const nextActive = Boolean(value?.mapActive);
        if (nextActive === lastSearchMapActive) {
          return;
        }
        lastSearchMapActive = nextActive;
        if (!nextActive) {
          abortSearchRequests({ resetMapState: true });
        }
      });
      if (!lastSearchMapActive) {
        abortSearchRequests({ resetMapState: true });
      }
    }
  }

  function destroy() {
    abortSearchRequests({ resetMapState: false });
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
