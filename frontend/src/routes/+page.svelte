<script>
  import { onDestroy, onMount } from 'svelte';
  import { pushState, replaceState } from '$app/navigation';
  import { page } from '$app/stores';
  import { get } from 'svelte/store';
  import BuildingModal from '$lib/components/shell/BuildingModal.svelte';
  import SearchModal from '$lib/components/shell/SearchModal.svelte';
  import { parseUrlState, patchUrlState } from '$lib/client/urlState';
  import { t, translateNow } from '$lib/i18n/index';
  import { getRuntimeConfig } from '$lib/services/config';
  import { apiJson, apiJsonCached } from '$lib/services/http';
  import { session } from '$lib/stores/auth';
  import { mapCenter, mapReady, mapViewport, mapZoom, requestMapFocus, selectedBuilding, setSelectedBuilding } from '$lib/stores/map';
  import { buildingModalOpen, closeBuildingModal, openBuildingModal } from '$lib/stores/ui';
  import { normalizeArchitectureStyleKey } from '$lib/utils/architecture-style';
  import { resolveAddressText } from '$lib/utils/building-address';
  import {
    filterSearchItemsByStyleKey,
    filterSearchItemsByStyleKeys,
    resolveArchitectureStyleSearchKey,
    resolveArchitectureStyleSearchKeys
  } from '$lib/utils/architecture-style';
  import {
    applySearchMapResults,
    applySearchResults,
    closeSearchModal,
    requestSearch,
    resetSearchMapState,
    resetSearchState,
    searchCommand,
    searchMapState,
    searchState,
    setSearchMapError,
    setSearchMapLoading,
    setSearchError,
    setSearchLoading
  } from '$lib/stores/search';

  let buildingDetails = null;
  let MapCanvasComponent = null;
  let selectedBuildingIdentity = null;
  let saveBuildingPending = false;
  let saveBuildingStatus = '';
  let lastSearchCommandId = null;
  let activeSearchRequestToken = 0;
  let activeSearchAbortController = null;
  let activeSearchMapRequestToken = 0;
  let activeSearchMapAbortController = null;
  let searchViewportRefreshTimer = null;
  let searchMapRefreshTimer = null;
  let stopViewportSearchSync = null;
  let urlUpdateInFlight = false;
  let cameraApplyInFlight = false;
  let buildingApplyInFlight = false;
  let buildingCloseInFlight = false;
  let activeBuildingDetailsAbortController = null;
  let activeBuildingDetailsToken = 0;
  let lastAppliedCameraKey = '';
  let lastAppliedBuildingKey = '';
  let lastUrlBuildingKey = '';
  let handledUrlSignature = '';
  let lastViewportRefreshKey = '';
  let lastSearchMapRefreshKey = '';
  const SEARCH_PAGE_SIZE = 120;
  const SEARCH_MAP_RESULTS_LIMIT = 5000;
  const SEARCH_VIEWPORT_REFRESH_DEBOUNCE_MS = 260;
  const EMPTY_OPTIONAL_TEXT_TOKENS = new Set(['-', '--', '—', 'n/a', 'na', 'null']);

  function isSelectionDebugEnabled() {
    const cfg = getRuntimeConfig();
    const isLocalRuntime = typeof window !== 'undefined'
      && ['localhost', '127.0.0.1'].includes(window.location.hostname);
    return Boolean(cfg?.mapSelection?.debug || import.meta.env.DEV || isLocalRuntime);
  }

  function syncSearchToViewport(viewportValue) {
    if (!get(mapReady)) return;
    const currentSearch = get(searchState);
    const currentMapSearch = get(searchMapState);
    const activeQuery = String(currentSearch.query || '').trim();
    const viewport = normalizeSearchViewport(viewportValue);
    const viewportHash = buildSearchViewportHash(viewport);
    const shouldRefreshViewportSearch = Boolean(
      viewport &&
      viewportHash &&
      activeQuery.length >= 2 &&
      String(currentSearch.bboxHash || '') &&
      viewportHash !== String(currentSearch.bboxHash || '') &&
      !currentSearch.loading &&
      !currentSearch.loadingMore
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
      viewport &&
      viewportHash &&
      activeQuery.length >= 2 &&
      String(currentMapSearch.bboxHash || '') &&
      viewportHash !== String(currentMapSearch.bboxHash || '') &&
      !currentMapSearch.loading
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

  onMount(async () => {
    stopViewportSearchSync = mapViewport.subscribe(syncSearchToViewport);
    const module = await import('$lib/components/map/MapCanvas.svelte');
    MapCanvasComponent = module.default;
  });

  onDestroy(() => {
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
    if (activeBuildingDetailsAbortController) {
      activeBuildingDetailsAbortController.abort();
      activeBuildingDetailsAbortController = null;
    }
  });

  function debugSelectionLog(eventName, payload = {}) {
    if (!isSelectionDebugEnabled()) return;
    console.debug('[map-selection]', eventName, {
      ts: new Date().toISOString(),
      ...payload
    });
  }

  function updateSelectionDebugHook(selection) {
    if (!isSelectionDebugEnabled() || typeof document === 'undefined') return;
    const key = selection?.osmType && selection?.osmId
      ? `${selection.osmType}/${selection.osmId}`
      : '';
    document.body.dataset.selectedBuildingId = key;
    window.__APP_STATE__ = window.__APP_STATE__ || {};
    window.__APP_STATE__.selectedBuildingId = key || null;
  }

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

  function toBuildingUrlParam(selection) {
    const osmType = String(selection?.osmType || '').trim();
    const osmId = Number(selection?.osmId);
    if (!['way', 'relation'].includes(osmType) || !Number.isInteger(osmId) || osmId <= 0) return null;
    return { osmType, osmId };
  }

  function getUrlStateSignature(state) {
    return `${state.camera?.lat ?? ''},${state.camera?.lng ?? ''},${state.camera?.z ?? ''}|${state.building?.osmType ?? ''}/${state.building?.osmId ?? ''}`;
  }

  function getUrlBuildingKey(state) {
    return state.building
      ? `${state.building.osmType}/${state.building.osmId}`
      : '';
  }

  function updateUrlState(patch, { replaceState: shouldReplaceState = true } = {}) {
    if (typeof window === 'undefined') return;
    const current = new URL(window.location.href);
    const next = patchUrlState(current, patch);
    if (next.toString() === current.toString()) return;
    const nextState = parseUrlState(next);
    urlUpdateInFlight = true;
    try {
      handledUrlSignature = getUrlStateSignature(nextState);
      lastUrlBuildingKey = getUrlBuildingKey(nextState);
      const target = `${next.pathname}${next.search}${next.hash}`;
      if (shouldReplaceState) {
        replaceState(target, $page.state);
      } else {
        pushState(target, $page.state);
      }
    } finally {
      queueMicrotask(() => {
        urlUpdateInFlight = false;
      });
    }
  }

  async function applyBuildingFromUrl(building) {
    const osmType = String(building?.osmType || '').trim();
    const osmId = Number(building?.osmId);
    if (!['way', 'relation'].includes(osmType) || !Number.isInteger(osmId) || osmId <= 0) return;
    const buildingKey = `${osmType}/${osmId}`;
    if (buildingKey === lastAppliedBuildingKey && $buildingModalOpen) return;
    buildingApplyInFlight = true;
    try {
      selectBuilding({
        osmType,
        osmId,
        lon: null,
        lat: null,
        feature: null
      });
      lastAppliedBuildingKey = buildingKey;
    } finally {
      buildingApplyInFlight = false;
    }
  }

  async function applyUrlStateToUi() {
    if (typeof window === 'undefined') return;
    if (urlUpdateInFlight) return;

    const state = parseUrlState(new URL(window.location.href));
    const signature = getUrlStateSignature(state);
    if (signature === handledUrlSignature) return;
    handledUrlSignature = signature;
    if (buildingCloseInFlight) return;
    const nextUrlBuildingKey = getUrlBuildingKey(state);
    const hadUrlBuildingKey = lastUrlBuildingKey;
    lastUrlBuildingKey = nextUrlBuildingKey;

    if (state.camera && $mapReady) {
      const cameraKey = `${state.camera.lat}:${state.camera.lng}:${state.camera.z ?? ''}`;
      if (cameraKey !== lastAppliedCameraKey) {
        cameraApplyInFlight = true;
        requestMapFocus({
          lon: state.camera.lng,
          lat: state.camera.lat,
          zoom: Number.isFinite(Number(state.camera.z)) ? Number(state.camera.z) : undefined,
          duration: 0
        });
        lastAppliedCameraKey = cameraKey;
        queueMicrotask(() => {
          cameraApplyInFlight = false;
        });
      }
    }

    if (state.building) {
      await applyBuildingFromUrl(state.building);
    } else if (hadUrlBuildingKey && ($buildingModalOpen || $selectedBuilding)) {
      if (!buildingApplyInFlight) {
        if (activeBuildingDetailsAbortController) {
          activeBuildingDetailsAbortController.abort();
          activeBuildingDetailsAbortController = null;
        }
        buildingDetails = null;
        setSelectedBuilding(null);
        closeBuildingModal();
      }
    }
  }

  function normalizeArchiInfo(payload) {
    const info = payload || {};
    const styleRaw = pickNullableText(
      info.style,
      info.architecture,
      info['building:style'],
      info['building:architecture']
    );
    return {
      name: pickNullableText(info.name, info['name:ru'], info['name:en']),
      style: styleRaw,
      styleRaw,
      levels: coerceNullableIntegerText(info.levels ?? info['building:levels'], 0, 300),
      year_built: coerceNullableIntegerText(
        info.year_built ?? info['building:year'] ?? info.start_date,
        1000,
        2100
      ),
      architect: pickNullableText(info.architect, info['building:architect']),
      address: resolveAddressText(info, pickNullableText, info.address),
      description: pickNullableText(info.description),
      archimap_description: pickNullableText(info.archimap_description, info.description),
      _sourceTags: info._sourceTags && typeof info._sourceTags === 'object' ? info._sourceTags : {}
    };
  }

  async function loadBuildingDetails(detail) {
    const token = ++activeBuildingDetailsToken;
    if (activeBuildingDetailsAbortController) {
      activeBuildingDetailsAbortController.abort();
    }
    activeBuildingDetailsAbortController = new AbortController();
    const signal = activeBuildingDetailsAbortController.signal;
    debugSelectionLog('details-load-start', {
      selectionKey: `${detail.osmType}/${detail.osmId}`
    });

    try {
      const data = await apiJson(`/api/building-info/${detail.osmType}/${detail.osmId}`, { signal });
      let sourceTags = {};
      try {
        const feature = await apiJson(`/api/building/${detail.osmType}/${detail.osmId}`, { signal });
        sourceTags = feature?.properties?.source_tags || {};
      } catch (featureError) {
        if (!isAbortError(featureError)) {
          sourceTags = detail?.feature?.properties?.source_tags || {};
        } else {
          throw featureError;
        }
      }
      if (token !== activeBuildingDetailsToken) return;
      buildingDetails = {
        properties: {
          archiInfo: normalizeArchiInfo({
            ...data,
            _sourceTags: sourceTags
          })
        }
      };
      debugSelectionLog('details-load-success', {
        selectionKey: `${detail.osmType}/${detail.osmId}`
      });
      return;
    } catch (primaryError) {
      if (isAbortError(primaryError)) return;
      try {
        const feature = await apiJson(`/api/building/${detail.osmType}/${detail.osmId}`, { signal });
        const archiInfo = feature?.properties?.archiInfo || feature?.properties?.source_tags || feature?.properties || {};
        if (token !== activeBuildingDetailsToken) return;
        buildingDetails = {
          properties: {
            archiInfo: normalizeArchiInfo({
              ...archiInfo,
              _sourceTags: feature?.properties?.source_tags || {}
            })
          }
        };
      } catch (fallbackError) {
        if (isAbortError(fallbackError)) return;
        if (token !== activeBuildingDetailsToken) return;
        buildingDetails = {
          properties: {
            archiInfo: {
              name: null,
              style: null,
              styleRaw: null,
              levels: null,
              year_built: null,
              architect: null,
              address: null,
              _sourceTags: {}
            }
          }
        };
      }
    } finally {
      if (activeBuildingDetailsAbortController?.signal === signal) {
        activeBuildingDetailsAbortController = null;
      }
    }
  }

  function selectBuilding(detail) {
    if (!detail?.osmType || !detail?.osmId) return;
    const normalized = {
      osmType: detail.osmType,
      osmId: Number(detail.osmId),
      lon: Number.isFinite(Number(detail?.lon)) ? Number(detail.lon) : null,
      lat: Number.isFinite(Number(detail?.lat)) ? Number(detail.lat) : null,
      feature: detail?.feature || null
    };
    setSelectedBuilding({
      osmType: normalized.osmType,
      osmId: normalized.osmId,
      lon: normalized.lon,
      lat: normalized.lat
    });
    updateSelectionDebugHook(normalized);
    selectedBuildingIdentity = {
      osmType: normalized.osmType,
      osmId: normalized.osmId
    };
    lastAppliedBuildingKey = `${normalized.osmType}/${normalized.osmId}`;
    saveBuildingStatus = '';
    debugSelectionLog('panel-open', {
      selectionKey: `${normalized.osmType}/${normalized.osmId}`
    });
    openBuildingModal();
    buildingDetails = null;
    void loadBuildingDetails(normalized);
  }

  function closeBuildingSelection() {
    buildingCloseInFlight = true;
    if (activeBuildingDetailsAbortController) {
      activeBuildingDetailsAbortController.abort();
      activeBuildingDetailsAbortController = null;
    }
    buildingDetails = null;
    setSelectedBuilding(null);
    closeBuildingModal();
    if ($mapReady) {
      updateUrlState({ building: null });
    }
    queueMicrotask(() => {
      buildingCloseInFlight = false;
    });
  }

  async function onBuildingClick(event) {
    const detail = event?.detail;
    if (!detail?.osmType || !detail?.osmId) return;
    selectBuilding(detail);
  }

  function coerceNullableText(value) {
    if (value == null) return null;
    const text = String(value ?? '').trim();
    if (!text) return null;
    if (EMPTY_OPTIONAL_TEXT_TOKENS.has(text.toLowerCase())) return null;
    return text;
  }

  function pickNullableText(...values) {
    for (const value of values) {
      const text = coerceNullableText(value);
      if (text) return text;
    }
    return null;
  }

  function coerceNullableIntegerText(value, min, max) {
    const text = coerceNullableText(value);
    if (!text) return null;
    const parsed = Number(text);
    if (!Number.isInteger(parsed) || parsed < min || parsed > max) return null;
    return String(parsed);
  }

  function normalizeEditedBuildingFields(value) {
    const allowed = new Set(['name', 'style', 'levels', 'yearBuilt', 'architect', 'address', 'archimapDescription']);
    if (!Array.isArray(value)) return [];
    const out = [];
    const seen = new Set();
    for (const item of value) {
      const key = String(item || '').trim();
      if (!allowed.has(key) || seen.has(key)) continue;
      seen.add(key);
      out.push(key);
    }
    return out;
  }

  function toDisplayArchiInfoFromPayload(currentInfo, payload, editedFields = []) {
    const next = currentInfo && typeof currentInfo === 'object'
      ? { ...currentInfo }
      : { _sourceTags: {} };
    const rawStyle = coerceNullableText(payload?.style);
    const editedFieldSet = new Set(normalizeEditedBuildingFields(editedFields));
    const applyAll = editedFieldSet.size === 0;

    if (applyAll || editedFieldSet.has('name')) next.name = coerceNullableText(payload?.name);
    if (applyAll || editedFieldSet.has('style')) {
      next.styleRaw = rawStyle;
      next.style = rawStyle;
    }
    if (applyAll || editedFieldSet.has('levels')) next.levels = coerceNullableIntegerText(payload?.levels, 0, 300);
    if (applyAll || editedFieldSet.has('yearBuilt')) next.year_built = coerceNullableIntegerText(payload?.yearBuilt, 1000, 2100);
    if (applyAll || editedFieldSet.has('architect')) next.architect = coerceNullableText(payload?.architect);
    if (applyAll || editedFieldSet.has('address')) next.address = coerceNullableText(payload?.address);
    if (applyAll || editedFieldSet.has('archimapDescription')) {
      next.archimap_description = coerceNullableText(payload?.archimapDescription);
      next.description = coerceNullableText(payload?.archimapDescription);
    }

    next._sourceTags = currentInfo?._sourceTags || buildingDetails?.properties?.archiInfo?._sourceTags || {};
    return next;
  }

  async function onSaveBuildingEdit(event) {
    const detail = event?.detail || {};
    if (!detail?.osmType || !detail?.osmId) return;
    if (!$session.authenticated) {
      saveBuildingStatus = translateNow('mapPage.authRequired');
      return;
    }
    const editedFields = normalizeEditedBuildingFields(detail.editedFields);
    if (editedFields.length === 0) {
      saveBuildingStatus = translateNow('buildingModal.noChanges');
      return;
    }
    saveBuildingPending = true;
    saveBuildingStatus = translateNow('mapPage.saving');
    const payload = {
      osmType: detail.osmType,
      osmId: Number(detail.osmId),
      name: coerceNullableText(detail.name),
      style: coerceNullableText(normalizeArchitectureStyleKey(detail.style)),
      levels: coerceNullableIntegerText(detail.levels, 0, 300),
      yearBuilt: coerceNullableIntegerText(detail.yearBuilt, 1000, 2100),
      architect: coerceNullableText(detail.architect),
      address: coerceNullableText(detail.address),
      archimapDescription: coerceNullableText(detail.archimapDescription),
      editedFields
    };

    try {
      await apiJson('/api/building-info', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      if (
        selectedBuildingIdentity &&
        selectedBuildingIdentity.osmType === payload.osmType &&
        selectedBuildingIdentity.osmId === payload.osmId
      ) {
        buildingDetails = {
          properties: {
            archiInfo: toDisplayArchiInfoFromPayload(buildingDetails?.properties?.archiInfo, payload, editedFields)
          }
        };
      }
      saveBuildingStatus = translateNow('mapPage.submitted');
    } catch (error) {
      saveBuildingStatus = String(error?.message || translateNow('mapPage.saveFailed'));
    } finally {
      saveBuildingPending = false;
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
    const viewport = normalizeSearchViewport($mapViewport);
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

    const viewport = normalizeSearchViewport($mapViewport);
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

  async function onSelectSearchResult(event) {
    const item = event?.detail || {};
    if (!item?.osmType || !item?.osmId) return;
    if (Number.isFinite(Number(item?.lon)) && Number.isFinite(Number(item?.lat))) {
      requestMapFocus({
        lon: Number(item.lon),
        lat: Number(item.lat),
        offsetX: window.innerWidth >= 1024 ? -Math.round(window.innerWidth * 0.18) : 0,
        offsetY: 0,
        zoom: 16,
        duration: 450
      });
    }
    closeSearchModal();
    await onBuildingClick({
      detail: {
        osmType: item.osmType,
        osmId: item.osmId,
        lon: item.lon,
        lat: item.lat
      }
    });
  }

  $: if ($searchCommand && $searchCommand.id !== lastSearchCommandId) {
    lastSearchCommandId = $searchCommand.id;
    runSearchRequest($searchCommand);
    if (!$searchCommand.append) {
      runSearchMapRequest($searchCommand.query, {
        background: Boolean($searchCommand.background)
      });
    }
  }

  $: if (String($searchState.query || '').trim().length < 2) {
    resetSearchMapState();
    lastSearchMapRefreshKey = '';
  }

  $: if (isSelectionDebugEnabled()) {
    updateSelectionDebugHook($selectedBuilding);
  }

  $: {
    $page;
    $mapReady;
    applyUrlStateToUi();
  }

  $: if ($mapReady && !$buildingModalOpen && !$selectedBuilding) {
    updateUrlState({ building: null });
  }

  $: if ($mapReady && $buildingModalOpen && $selectedBuilding && !buildingApplyInFlight) {
    const building = toBuildingUrlParam($selectedBuilding);
    updateUrlState(
      { building },
      { replaceState: Boolean(lastUrlBuildingKey) }
    );
  }

  $: if ($mapReady && $mapCenter && Number.isFinite(Number($mapZoom)) && !cameraApplyInFlight) {
    updateUrlState({
      camera: {
        lat: $mapCenter.lat,
        lng: $mapCenter.lng,
        z: $mapZoom
      }
    });
  }
</script>

{#if MapCanvasComponent}
  <svelte:component this={MapCanvasComponent} on:buildingClick={onBuildingClick} />
{:else}
  <div class="map-loading">{$t('mapPage.mapLoading')}</div>
{/if}
<BuildingModal
  {buildingDetails}
  isAuthenticated={$session.authenticated}
  canEditBuildings={Boolean($session.user?.canEditBuildings || $session.user?.isAdmin)}
  savePending={saveBuildingPending}
  saveStatus={saveBuildingStatus}
  on:save={onSaveBuildingEdit}
  on:close={closeBuildingSelection}
/>
<SearchModal on:selectResult={onSelectSearchResult} />

<style>
  .map-loading {
    position: fixed;
    inset: 0;
    display: grid;
    place-items: center;
    font-size: 0.95rem;
    color: #64748b;
    background: linear-gradient(180deg, #f8fafc 0%, #e2e8f0 100%);
  }
</style>
