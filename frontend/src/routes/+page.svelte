<script>
  import { onDestroy, onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { page } from '$app/stores';
  import { get } from 'svelte/store';
  import BuildingModal from '$lib/components/shell/BuildingModal.svelte';
  import SearchModal from '$lib/components/shell/SearchModal.svelte';
  import { parseUrlState, patchUrlState } from '$lib/client/urlState';
  import { t, translateNow } from '$lib/i18n/index';
  import { getRuntimeConfig } from '$lib/services/config';
  import { apiJson, apiJsonCached } from '$lib/services/http';
  import { session } from '$lib/stores/auth';
  import { mapCenter, mapReady, mapZoom, requestMapFocus, selectedBuilding, setSelectedBuilding } from '$lib/stores/map';
  import { buildingModalOpen, openBuildingModal } from '$lib/stores/ui';
  import { normalizeArchitectureStyleKey } from '$lib/utils/architecture-style';
  import {
    filterSearchItemsByStyleKey,
    filterSearchItemsByStyleKeys,
    resolveArchitectureStyleSearchKey,
    resolveArchitectureStyleSearchKeys
  } from '$lib/utils/architecture-style';
  import {
    applySearchResults,
    closeSearchModal,
    resetSearchState,
    searchCommand,
    searchState,
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
  let urlUpdateInFlight = false;
  let cameraApplyInFlight = false;
  let buildingApplyInFlight = false;
  let activeBuildingDetailsAbortController = null;
  let activeBuildingDetailsToken = 0;
  let lastAppliedCameraKey = '';
  let lastAppliedBuildingKey = '';
  let handledUrlSignature = '';

  function isSelectionDebugEnabled() {
    const cfg = getRuntimeConfig();
    const isLocalRuntime = typeof window !== 'undefined'
      && ['localhost', '127.0.0.1'].includes(window.location.hostname);
    return Boolean(cfg?.mapSelection?.debug || import.meta.env.DEV || isLocalRuntime);
  }

  onMount(async () => {
    const module = await import('$lib/components/map/MapCanvas.svelte');
    MapCanvasComponent = module.default;
  });

  onDestroy(() => {
    if (activeSearchAbortController) {
      activeSearchAbortController.abort();
      activeSearchAbortController = null;
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

  function toBuildingUrlParam(selection) {
    const osmType = String(selection?.osmType || '').trim();
    const osmId = Number(selection?.osmId);
    if (!['way', 'relation'].includes(osmType) || !Number.isInteger(osmId) || osmId <= 0) return null;
    return { osmType, osmId };
  }

  async function replaceUrlState(patch) {
    if (typeof window === 'undefined') return;
    const current = new URL(window.location.href);
    const next = patchUrlState(current, patch);
    if (next.toString() === current.toString()) return;
    urlUpdateInFlight = true;
    try {
      await goto(`${next.pathname}${next.search}${next.hash}`, {
        replaceState: true,
        keepFocus: true,
        noScroll: true
      });
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

    const state = parseUrlState($page.url);
    const signature = `${state.camera?.lat ?? ''},${state.camera?.lng ?? ''},${state.camera?.z ?? ''}|${state.building?.osmType ?? ''}/${state.building?.osmId ?? ''}`;
    if (signature === handledUrlSignature) return;
    handledUrlSignature = signature;

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
    } else if ($buildingModalOpen || $selectedBuilding) {
      if (!buildingApplyInFlight) {
        setSelectedBuilding(null);
      }
    }
  }

  function normalizeArchiInfo(payload) {
    const info = payload || {};
    const rawStyle = info.style ?? info.architecture ?? info['building:style'] ?? info['building:architecture'] ?? null;
    const styleRaw = rawStyle ? String(rawStyle) : null;
    const style = styleRaw || '-';
    return {
      name: info.name ?? info['name:ru'] ?? info['name:en'] ?? '-',
      style,
      styleRaw: styleRaw || null,
      levels: info.levels ?? info['building:levels'] ?? '-',
      year_built: info.year_built ?? info['building:year'] ?? info.start_date ?? '-',
      architect: info.architect ?? info['building:architect'] ?? '-',
      address: info.address ?? info['addr:full'] ?? info['addr:street'] ?? '-',
      description: info.description ?? null,
      archimap_description: info.archimap_description ?? info.description ?? null,
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
              name: '-',
              style: '-',
              styleRaw: null,
              levels: '-',
              year_built: '-',
              architect: '-',
              address: '-',
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
    saveBuildingStatus = '';
    debugSelectionLog('panel-open', {
      selectionKey: `${normalized.osmType}/${normalized.osmId}`
    });
    openBuildingModal();
    buildingDetails = null;
    void loadBuildingDetails(normalized);
  }

  async function onBuildingClick(event) {
    const detail = event?.detail;
    if (!detail?.osmType || !detail?.osmId) return;
    selectBuilding(detail);
  }

  function coerceNullableText(value) {
    const text = String(value ?? '').trim();
    return text || null;
  }

  function toDisplayArchiInfoFromPayload(payload) {
    const rawStyle = coerceNullableText(payload?.style);
    return {
      name: coerceNullableText(payload?.name) || '-',
      styleRaw: rawStyle,
      style: rawStyle || '-',
      levels: coerceNullableText(payload?.levels) || '-',
      year_built: coerceNullableText(payload?.yearBuilt) || '-',
      architect: coerceNullableText(payload?.architect) || '-',
      address: coerceNullableText(payload?.address) || '-',
      archimap_description: coerceNullableText(payload?.archimapDescription),
      description: coerceNullableText(payload?.archimapDescription),
      _sourceTags: buildingDetails?.properties?.archiInfo?._sourceTags || {}
    };
  }

  async function onSaveBuildingEdit(event) {
    const detail = event?.detail || {};
    if (!detail?.osmType || !detail?.osmId) return;
    if (!$session.authenticated) {
      saveBuildingStatus = translateNow('mapPage.authRequired');
      return;
    }
    saveBuildingPending = true;
    saveBuildingStatus = translateNow('mapPage.saving');
    const payload = {
      osmType: detail.osmType,
      osmId: Number(detail.osmId),
      name: coerceNullableText(detail.name),
      style: coerceNullableText(normalizeArchitectureStyleKey(detail.style)),
      levels: coerceNullableText(detail.levels),
      yearBuilt: coerceNullableText(detail.yearBuilt),
      architect: coerceNullableText(detail.architect),
      address: coerceNullableText(detail.address),
      archimapDescription: coerceNullableText(detail.archimapDescription)
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
            archiInfo: toDisplayArchiInfoFromPayload(payload)
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
    const styleSearchKey = resolveArchitectureStyleSearchKey(text);
    const styleSearchKeys = resolveArchitectureStyleSearchKeys(text);
    const searchQuery = String(styleSearchKey || text).slice(0, 120);
    if (text.length < 2) {
      resetSearchState(translateNow('search.minChars'));
      return;
    }

    const current = get(searchState);
    if (append && !current.hasMore) return;

    const center = get(mapCenter);
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
      setSearchLoading({ append: false });
      try {
        const keysToQuery = styleSearchKeys.slice(0, 5);
        const chunks = await Promise.all(keysToQuery.map(async (key) => {
          const params = new URLSearchParams({
            q: String(key).slice(0, 120),
            limit: '30'
          });
          if (Number.isFinite(Number(center?.lng)) && Number.isFinite(Number(center?.lat))) {
            params.set('lon', String(center.lng));
            params.set('lat', String(center.lat));
          }
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
          items: filtered.slice(0, 30),
          hasMore: false,
          nextCursor: null,
          append: false
        });
      } catch (error) {
        if (String(error?.name || '').toLowerCase() === 'aborterror') return;
        if (token !== activeSearchRequestToken) return;
        setSearchError(error?.message || translateNow('mapPage.searchFailed'), { append: false });
      }
      return;
    }

    setSearchLoading({ append });
    const params = new URLSearchParams({
      q: searchQuery,
      limit: '30'
    });
    if (Number.isFinite(Number(center?.lng)) && Number.isFinite(Number(center?.lat))) {
      params.set('lon', String(center.lng));
      params.set('lat', String(center.lat));
    }
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
        hasMore: Boolean(data?.hasMore),
        nextCursor: data?.nextCursor,
        append
      });
    } catch (error) {
      if (String(error?.name || '').toLowerCase() === 'aborterror') return;
      if (token !== activeSearchRequestToken) return;
      setSearchError(error?.message || translateNow('mapPage.searchFailed'), { append });
    } finally {
      if (activeSearchAbortController?.signal === signal) {
        activeSearchAbortController = null;
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
  }

  $: if (isSelectionDebugEnabled()) {
    updateSelectionDebugHook($selectedBuilding);
  }

  $: {
    $page;
    $mapReady;
    $buildingModalOpen;
    $selectedBuilding;
    $mapCenter;
    $mapZoom;
    applyUrlStateToUi();
  }

  $: if ($mapReady && !$buildingModalOpen && !$selectedBuilding) {
    replaceUrlState({ building: null });
  }

  $: if ($mapReady && $buildingModalOpen && $selectedBuilding && !buildingApplyInFlight) {
    const building = toBuildingUrlParam($selectedBuilding);
    replaceUrlState({ building });
  }

  $: if ($mapReady && $mapCenter && Number.isFinite(Number($mapZoom)) && !cameraApplyInFlight) {
    replaceUrlState({
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
