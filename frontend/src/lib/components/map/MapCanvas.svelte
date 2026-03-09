<script>
  import { beforeNavigate } from '$app/navigation';
  import { createEventDispatcher, onDestroy, onMount } from 'svelte';
  import { get } from 'svelte/store';
  import { CUSTOM_MAP_ATTRIBUTION } from '$lib/constants/map';
  import { getRuntimeConfig } from '$lib/services/config';
  import { apiJson } from '$lib/services/http';
  import MapFeedbackOverlay from '$lib/components/map/MapFeedbackOverlay.svelte';
  import { createMapDebugController } from '$lib/services/map/map-debug';
  import { MapFilterService } from '$lib/services/map/map-filter.service';
  import {
    applyBuildingThemePaint as applyBuildingThemePaintToLayers,
    applyLabelLayerVisibility as applyMapLabelLayerVisibility,
    bindMapInteractionHandlers,
    bringSearchResultsLayersToFront,
    CARTO_BUILDING_LAYER_IDS,
    ensureRegionBuildingSourceAndLayers,
    ensureSearchResultsSourceAndLayers,
    getCurrentBuildingSourceConfigs as getBuildingSourceConfigsFromRegions,
    getRegionLayerIds,
    removeRegionBuildingSourceAndLayers
  } from '$lib/services/map/map-layer-utils';
  import {
    expandBboxWithMargin,
    getAdaptiveCoverageMarginRatio
  } from '$lib/services/map/map-math-utils';
  import {
    fitMapToSearchResults as fitMapToSearchItems,
    SEARCH_RESULTS_CLUSTER_LAYER_ID,
    SEARCH_RESULTS_LAYER_ID,
    SEARCH_RESULTS_SOURCE_ID,
    updateSearchMarkers as updateSearchMarkerSource
  } from '$lib/services/map/map-search-utils';
  import {
    getBuildingThemePaint,
    getCurrentTheme,
    getMapStyleForTheme,
    LIGHT_MAP_STYLE_URL,
    STYLE_OVERLAY_FADE_MS
  } from '$lib/services/map/map-theme-utils';
  import { loadMapRuntime } from '$lib/services/map-runtime';
  import {
    getActiveRegionPmtiles,
    pointInBounds
  } from '$lib/services/region-pmtiles';
  import { t, translateNow } from '$lib/i18n/index';
  import {
    lastMapCamera,
    mapFocusRequest,
    mapLabelsVisible,
    normalizeOptionalMapZoom,
    resolveInitialMapCamera,
    selectedBuilding,
    setMapCenter,
    setMapReady,
    setMapViewport,
    setMapZoom
  } from '$lib/stores/map';
  import { buildingFilterRules, setBuildingFilterRuntimeStatus } from '$lib/stores/filters';
  import { searchMapState, searchState } from '$lib/stores/search';
  import { encodeOsmFeatureId, getFeatureIdentity, getSelectionFilter, parseOsmKey } from './selection-utils';
  import {
    buildBboxHash,
    buildBboxSnapshot,
    isViewportInsideBbox
  } from './filter-pipeline-utils';
  import { EMPTY_LAYER_FILTER, hashFilterExpression } from './filter-highlight-utils';

  const dispatch = createEventDispatcher();
  const FILTER_HIGHLIGHT_MODE = 'feature-state';
  const FILTER_REQUEST_DEBOUNCE_MS = 180;
  const FILTER_HEAVY_RULE_DEBOUNCE_MS = 500;
  const FILTER_RULE_CHANGE_DEBOUNCE_MS = 90;
  const CARTO_SHOW_DELAY_MS = 160;
  const COVERAGE_CACHE_LIMIT = 800;
  const FILTER_RULE_OPS = new Set(['contains', 'equals', 'not_equals', 'starts_with', 'exists', 'not_exists']);
  const FILTER_MATCH_CACHE_TTL_MS = 8_000;
  const FILTER_MATCH_CACHE_MAX_ITEMS = 90;
  const FILTER_MATCH_DEGRADE_LIMIT = 20_000;
  const FILTER_MATCH_DEFAULT_LIMIT = 12_000;
  const FILTER_DATA_CACHE_TTL_MS = 45_000;
  const FILTER_DATA_CACHE_MAX_ITEMS = 25_000;
  const FILTER_DATA_REQUEST_CHUNK_SIZE = 5_000;
  const FILTER_FEATURE_STATE_CHUNK_SIZE = 540;
  const FILTER_DENSE_DIFF_THRESHOLD = 1_200;
  const FILTER_APPLY_FRAME_BUDGET_MS = 4.5;
  const FILTER_APPLY_DENSE_FRAME_BUDGET_MS = 8.5;
  const FILTER_APPLY_DENSE_MAX_OPS_PER_FRAME = 2_800;
  const FILTER_COVERAGE_MARGIN_MIN = 0.2;
  const FILTER_COVERAGE_MARGIN_MAX = 0.35;
  const FILTER_PREFETCH_ENABLED = true;
  const FILTER_PREFETCH_MIN_INTERVAL_MS = 900;
  const FILTER_TELEMETRY_ENABLED = Boolean(import.meta.env.DEV || import.meta.env.MODE === 'test');

  let container;
  let map = null;
  let maplibregl = null;
  let protocol = null;
  let activeRegionPmtiles = [];
  let themeObserver = null;
  let mapMoveDebounceTimer = null;
  let coverageDebounceTimer = null;
  let cartoShowTimer = null;
  let activeFilterAbortController = null;
  let prefetchFilterAbortController = null;
  let coverageEvalToken = 0;
  let coverageVisibleState = 'visible';
  let filterMatchesCache = new Map();
  let filterWorkerService = null;
  let latestFilterToken = 0;
  let lastSelectedKey = null;
  let lastSearchFitSeq = 0;
  let lastMapFocusRequestId = null;
  let currentMapStyleUrl = LIGHT_MAP_STYLE_URL;
  let runtimeConfig = null;
  let styleTransitionOverlaySrc = null;
  let styleTransitionOverlayVisible = false;
  let styleTransitionTimer = null;
  let lastHandledBuildingClickSig = null;
  let filterRulesDebounceTimer = null;
  let filterAuthoritativeTimer = null;
  let filterPrefetchTimer = null;
  let filterErrorMessage = '';
  let filterStatusMessage = '';
  let filterStatusCode = 'idle';
  let filterPhase = 'idle';
  let filterLastElapsedMs = 0;
  let filterLastCount = 0;
  let filterLastCacheHit = false;
  let currentFilterRulesHash = 'fnv1a-0';
  let lastViewportHash = '';
  let lastAuthoritativeRequestKey = '';
  let activeFilterCoverageWindow = null;
  let activeFilterCoverageKey = '';
  let filterLastPrefetchAt = 0;
  let filterLastMoveEndAt = 0;
  let filterLastMapCenter = null;
  let filterLastMoveVector = { dx: 0, dy: 0 };
  let filterSetFeatureStateCallsLast = 0;
  let filterLastApplyDiffMs = 0;
  let filterDenseBurstEnabled = true;
  let filterDebugActive = false;
  let filterDebugExprHash = hashFilterExpression(EMPTY_LAYER_FILTER);
  let filteredFeatureStateFeatureIds = new Set();
  let filterDataByOsmKeyCache = new Map();
  let filterStatusOverlayText = '';
  let cameraStoreSyncEnabled = false;

  const mapDebug = createMapDebugController({
    getMap: () => map,
    getLayerIds: () => [
      ...getCurrentBuildingsFillLayerIds(),
      ...getCurrentBuildingsLineLayerIds(),
      ...getCurrentFilterHighlightFillLayerIds(),
      ...getCurrentFilterHighlightLineLayerIds(),
      ...getCurrentSelectedFillLayerIds(),
      ...getCurrentSelectedLineLayerIds()
    ],
    isFilterDebugEnabled,
    telemetryEnabled: FILTER_TELEMETRY_ENABLED
  });

  beforeNavigate((navigation) => {
    if (typeof window === 'undefined') return;
    const nextPathname = String(navigation?.to?.url?.pathname || '').trim();
    if (!nextPathname) {
      cameraStoreSyncEnabled = false;
      return;
    }
    if (nextPathname !== window.location.pathname) {
      cameraStoreSyncEnabled = false;
    }
  });

  function getFilterStatusOverlayText(statusCode) {
    const code = String(statusCode || 'idle');
    if (code === 'refining') return $t('mapPage.filterStatus.refining') || $t('header.filterStatus.refining');
    if (code === 'too_many_matches') return $t('mapPage.filterStatus.tooMany') || $t('header.filterStatus.tooMany');
    if (code === 'truncated') return $t('mapPage.filterStatus.truncated') || $t('header.filterStatus.truncated');
    if (code === 'invalid') return $t('mapPage.filterStatus.invalid') || $t('header.filterStatus.invalid');
    return '';
  }

  $: filterStatusOverlayText = getFilterStatusOverlayText(filterStatusCode);

  function isSelectionDebugEnabled() {
    const fromRuntimeConfig = Boolean(runtimeConfig?.mapSelection?.debug);
    return Boolean(fromRuntimeConfig || import.meta.env.DEV);
  }

  function debugSelectionLog(eventName, payload = {}) {
    if (!isSelectionDebugEnabled()) return;
    console.debug('[map-selection]', eventName, {
      ts: new Date().toISOString(),
      ...payload
    });
  }

  function isFilterDebugEnabled() {
    return Boolean(import.meta.env.DEV || import.meta.env.MODE === 'test');
  }

  function debugFilterLog(eventName, payload = {}) {
    mapDebug.log(eventName, payload);
  }

  function updateFilterDebugHook({
    active = false,
    expr = EMPTY_LAYER_FILTER,
    mode = FILTER_HIGHLIGHT_MODE,
    phase = filterPhase,
    lastElapsedMs = filterLastElapsedMs,
    lastCount = filterLastCount,
    cacheHit = filterLastCacheHit,
    setFeatureStateCalls = filterSetFeatureStateCallsLast
  } = {}) {
    const nextDebugState = mapDebug.updateHook({
      active,
      expr,
      mode,
      phase,
      lastElapsedMs,
      lastCount,
      cacheHit,
      setFeatureStateCalls
    });
    filterDebugActive = nextDebugState.active;
    filterDebugExprHash = nextDebugState.exprHash;
  }

  function setFilterPhase(phase) {
    filterPhase = phase;
    updateFilterRuntimeStatus({
      phase,
      statusCode: phase === 'idle' ? 'idle' : undefined
    });
    updateFilterDebugHook({
      active: filteredFeatureStateFeatureIds.size > 0,
      expr: ['literal', currentFilterRulesHash],
      mode: FILTER_HIGHLIGHT_MODE,
      phase,
      lastElapsedMs: filterLastElapsedMs,
      lastCount: filterLastCount,
      cacheHit: filterLastCacheHit
    });
  }

  function requestFilterWorker(type, payload = {}) {
    if (!filterWorkerService) {
      filterWorkerService = new MapFilterService();
    }
    return filterWorkerService.request(type, payload);
  }

  function recordDebugSetFilter(layerId) {
    mapDebug.recordSetFilter(layerId);
  }

  function recordFilterRequestDebugEvent(eventName) {
    mapDebug.recordFilterRequestEvent(eventName);
  }

  function recordFilterTelemetry(eventName, payload = {}) {
    mapDebug.recordFilterTelemetry(eventName, payload);
  }

  function updateFilterRuntimeStatus(status = {}) {
    const nextStatusCode = status.statusCode != null
      ? String(status.statusCode)
      : String(filterStatusCode || 'idle');
    const nextMessage = status.message != null
      ? String(status.message)
      : String(filterStatusMessage || '');
    filterStatusCode = nextStatusCode;
    filterStatusMessage = nextMessage;
    setBuildingFilterRuntimeStatus({
      phase: filterPhase,
      statusCode: nextStatusCode,
      message: nextMessage,
      count: Number(status.count ?? filterLastCount ?? 0) || 0,
      elapsedMs: Number(status.elapsedMs ?? filterLastElapsedMs ?? 0) || 0,
      cacheHit: Boolean(status.cacheHit ?? filterLastCacheHit),
      setFeatureStateCalls: Number(status.setFeatureStateCalls ?? filterSetFeatureStateCallsLast ?? 0) || 0,
      updatedAt: Date.now()
    });
  }

  function nextAnimationFrame() {
    if (typeof window === 'undefined' || typeof window.requestAnimationFrame !== 'function') {
      return new Promise((resolve) => setTimeout(resolve, 0));
    }
    return new Promise((resolve) => window.requestAnimationFrame(() => resolve()));
  }

  function resolveFilterDenseBurstEnabled() {
    if (typeof window === 'undefined') return true;
    try {
      const raw = String(new URL(window.location.href).searchParams.get('filterDenseBurst') || '').trim().toLowerCase();
      if (raw === '0' || raw === 'false' || raw === 'off') return false;
    } catch {
      // ignore
    }
    return true;
  }

  function getConfiguredRegionPmtiles(config = runtimeConfig) {
    return Array.isArray(config?.buildingRegionsPmtiles) ? config.buildingRegionsPmtiles : [];
  }

  function getViewportActiveRegionPmtiles(config = runtimeConfig) {
    if (!map) return [];
    return getActiveRegionPmtiles(getConfiguredRegionPmtiles(config), map.getBounds());
  }

  function getCurrentBuildingSourceConfigs() {
    return getBuildingSourceConfigsFromRegions(activeRegionPmtiles);
  }

  function getCurrentBuildingsFillLayerIds() {
    return getRegionLayerIds(activeRegionPmtiles, 'fill');
  }

  function getCurrentBuildingsLineLayerIds() {
    return getRegionLayerIds(activeRegionPmtiles, 'line');
  }

  function getCurrentFilterHighlightFillLayerIds() {
    return getRegionLayerIds(activeRegionPmtiles, 'filter-highlight-fill');
  }

  function getCurrentFilterHighlightLineLayerIds() {
    return getRegionLayerIds(activeRegionPmtiles, 'filter-highlight-line');
  }

  function getCurrentSelectedFillLayerIds() {
    return getRegionLayerIds(activeRegionPmtiles, 'selected-fill');
  }

  function getCurrentSelectedLineLayerIds() {
    return getRegionLayerIds(activeRegionPmtiles, 'selected-line');
  }

  function setLocalBuildingFeatureStateById(id, state) {
    if (!map) return false;
    if (!Number.isInteger(id) || id <= 0) return false;
    let applied = false;
    for (const sourceConfig of getCurrentBuildingSourceConfigs()) {
      if (!sourceConfig?.sourceLayer) continue;
      try {
        map.setFeatureState(
          {
            source: sourceConfig.sourceId,
            sourceLayer: sourceConfig.sourceLayer,
            id
          },
          state
        );
        applied = true;
      } catch {
        // Source/style might be reloading.
      }
    }
    return applied;
  }

  function cancelPrefetchRequest() {
    if (prefetchFilterAbortController) {
      prefetchFilterAbortController.abort();
      prefetchFilterAbortController = null;
      recordFilterRequestDebugEvent('prefetch-abort');
      recordFilterTelemetry('prefetch_abort');
    }
    if (filterPrefetchTimer) {
      clearTimeout(filterPrefetchTimer);
      filterPrefetchTimer = null;
    }
  }

  function getCoverageWindowForViewport(viewportBbox) {
    const marginRatio = getAdaptiveCoverageMarginRatio({
      lastCount: filterLastCount,
      defaultLimit: FILTER_MATCH_DEFAULT_LIMIT,
      min: FILTER_COVERAGE_MARGIN_MIN,
      max: FILTER_COVERAGE_MARGIN_MAX
    });
    const windowBbox = expandBboxWithMargin(viewportBbox, marginRatio);
    if (!windowBbox) return null;
    return {
      ...windowBbox,
      marginRatio
    };
  }

  async function applyFeatureStatePlanInChunks(plan, token, meta = {}) {
    const workingSet = new Set(filteredFeatureStateFeatureIds);
    const toDisable = Array.isArray(plan?.toDisable) ? plan.toDisable : [];
    const toEnable = Array.isArray(plan?.toEnable) ? plan.toEnable : [];
    const chunkSize = Math.max(120, Number(meta.chunkSize || FILTER_FEATURE_STATE_CHUNK_SIZE) || FILTER_FEATURE_STATE_CHUNK_SIZE);
    const totalOps = toDisable.length + toEnable.length;
    const denseMode = filterDenseBurstEnabled && totalOps >= FILTER_DENSE_DIFF_THRESHOLD;
    let disableIndex = 0;
    let enableIndex = 0;
    let setCalls = 0;
    const applyStartedAt = performance.now();
    recordFilterTelemetry('apply_plan_start', {
      token,
      toDisable: toDisable.length,
      toEnable: toEnable.length,
      delayFromMoveEndMs: filterLastMoveEndAt > 0 ? Math.max(0, Date.now() - filterLastMoveEndAt) : null
    });

    while (disableIndex < toDisable.length || enableIndex < toEnable.length) {
      if (token !== latestFilterToken) {
        filteredFeatureStateFeatureIds = workingSet;
        recordFilterTelemetry('apply_plan_cancelled', {
          token,
          setCalls,
          partialSize: workingSet.size
        });
        return { cancelled: true, setCalls, elapsedMs: Math.round(performance.now() - applyStartedAt) };
      }
      const frameStartedAt = performance.now();
      const frameBudgetMs = denseMode ? FILTER_APPLY_DENSE_FRAME_BUDGET_MS : FILTER_APPLY_FRAME_BUDGET_MS;
      const maxOpsPerFrame = denseMode
        ? FILTER_APPLY_DENSE_MAX_OPS_PER_FRAME
        : chunkSize;
      let frameOps = 0;
      while (
        frameOps < maxOpsPerFrame &&
        disableIndex < toDisable.length &&
        (performance.now() - frameStartedAt) <= frameBudgetMs
      ) {
        const id = toDisable[disableIndex++];
        if (setLocalBuildingFeatureStateById(id, { isFiltered: false })) {
          workingSet.delete(id);
          setCalls += 1;
        }
        frameOps += 1;
      }
      while (
        frameOps < maxOpsPerFrame &&
        enableIndex < toEnable.length &&
        (performance.now() - frameStartedAt) <= frameBudgetMs
      ) {
        const id = toEnable[enableIndex++];
        if (setLocalBuildingFeatureStateById(id, { isFiltered: true })) {
          workingSet.add(id);
          setCalls += 1;
        }
        frameOps += 1;
      }
      if (disableIndex < toDisable.length || enableIndex < toEnable.length) {
        await nextAnimationFrame();
      }
    }

    filteredFeatureStateFeatureIds = new Set(Array.isArray(plan?.nextFeatureIds) ? plan.nextFeatureIds : [...workingSet]);
    filterSetFeatureStateCallsLast = setCalls;
    const elapsedMs = Math.round(performance.now() - applyStartedAt);
    filterLastApplyDiffMs = elapsedMs;
    recordFilterTelemetry('apply_plan_finish', {
      token,
      toDisable: toDisable.length,
      toEnable: toEnable.length,
      setCalls,
      elapsedMs,
      denseMode,
      delayFromMoveEndMs: filterLastMoveEndAt > 0 ? Math.max(0, Date.now() - filterLastMoveEndAt) : null
    });
    return { cancelled: false, setCalls, elapsedMs };
  }

  function pruneFilterMatchesCache() {
    while (filterMatchesCache.size > FILTER_MATCH_CACHE_MAX_ITEMS) {
      const oldest = filterMatchesCache.keys().next().value;
      if (!oldest) break;
      filterMatchesCache.delete(oldest);
    }
  }

  function getCachedFilterMatches(cacheKey) {
    const cached = filterMatchesCache.get(cacheKey);
    if (!cached) return null;
    if ((Date.now() - Number(cached.cachedAt || 0)) > FILTER_MATCH_CACHE_TTL_MS) {
      filterMatchesCache.delete(cacheKey);
      return null;
    }
    return cached.payload;
  }

  function putCachedFilterMatches(cacheKey, payload) {
    filterMatchesCache.set(cacheKey, {
      cachedAt: Date.now(),
      payload
    });
    pruneFilterMatchesCache();
  }

  async function applyFilteredFeatureStateMatches(matches, token, meta = {}) {
    const prevFeatureIds = [...filteredFeatureStateFeatureIds];
    let plan;
    try {
      const workerResponse = await requestFilterWorker('build-apply-plan', {
        prevFeatureIds,
        matches
      });
      plan = {
        toEnable: Array.isArray(workerResponse?.toEnable) ? workerResponse.toEnable : [],
        toDisable: Array.isArray(workerResponse?.toDisable) ? workerResponse.toDisable : [],
        nextFeatureIds: Array.isArray(workerResponse?.nextFeatureIds) ? workerResponse.nextFeatureIds : [],
        total: Number(workerResponse?.total || 0)
      };
    } catch {
      const nextFeatureIds = new Set(Array.isArray(matches?.matchedFeatureIds) ? matches.matchedFeatureIds : []);
      for (const key of Array.isArray(matches?.matchedKeys) ? matches.matchedKeys : []) {
        const parsed = parseOsmKey(key);
        if (!parsed) continue;
        nextFeatureIds.add(encodeOsmFeatureId(parsed.osmType, parsed.osmId));
      }
      const toDisable = [];
      const toEnable = [];
      for (const id of prevFeatureIds) {
        if (!nextFeatureIds.has(id)) toDisable.push(id);
      }
      for (const id of nextFeatureIds) {
        if (!filteredFeatureStateFeatureIds.has(id)) toEnable.push(id);
      }
      plan = {
        toEnable,
        toDisable,
        nextFeatureIds: [...nextFeatureIds],
        total: nextFeatureIds.size
      };
    }
    if (token !== latestFilterToken) return;

    const applyResult = await applyFeatureStatePlanInChunks(plan, token, meta);
    if (applyResult?.cancelled) return;
    filterLastCount = plan.total;
    filterSetFeatureStateCallsLast = Number(applyResult?.setCalls || 0);
    debugFilterLog('apply diff enable/disable', {
      enable: plan.toEnable.length,
      disable: plan.toDisable.length,
      total: plan.total,
      setFeatureStateCalls: filterSetFeatureStateCallsLast,
      phase: meta.phase || filterPhase
    });
    updateFilterRuntimeStatus({
      count: plan.total,
      setFeatureStateCalls: filterSetFeatureStateCallsLast
    });
  }

  function clearFilteredFeatureState() {
    let setCalls = 0;
    for (const id of filteredFeatureStateFeatureIds) {
      if (setLocalBuildingFeatureStateById(id, { isFiltered: false })) {
        setCalls += 1;
      }
    }
    filteredFeatureStateFeatureIds = new Set();
    filterLastCount = 0;
    filterSetFeatureStateCallsLast = setCalls;
    recordFilterTelemetry('filter_state_cleared', { setCalls });
    updateFilterRuntimeStatus({
      count: 0,
      setFeatureStateCalls: setCalls
    });
    updateFilterDebugHook({
      active: false,
      expr: EMPTY_LAYER_FILTER,
      mode: FILTER_HIGHLIGHT_MODE,
      phase: filterPhase
    });
  }

  function reapplyFilteredFeatureState() {
    if (filteredFeatureStateFeatureIds.size === 0) return;
    let setCalls = 0;
    for (const id of filteredFeatureStateFeatureIds) {
      if (setLocalBuildingFeatureStateById(id, { isFiltered: true })) {
        setCalls += 1;
      }
    }
    filterSetFeatureStateCallsLast = setCalls;
    updateFilterRuntimeStatus({
      setFeatureStateCalls: setCalls
    });
  }

  function getPrimaryBuildingFeature(event) {
    if (!map) return null;
    const searchFeatures = map.queryRenderedFeatures(event.point, {
      layers: [SEARCH_RESULTS_CLUSTER_LAYER_ID, SEARCH_RESULTS_LAYER_ID]
    });
    if (Array.isArray(searchFeatures) && searchFeatures.length > 0) {
      return null;
    }
    const buildingLayerIds = [
      ...getCurrentBuildingsLineLayerIds(),
      ...getCurrentBuildingsFillLayerIds()
    ];
    if (buildingLayerIds.length === 0) return null;
    const features = map.queryRenderedFeatures(event.point, {
      layers: buildingLayerIds
    });
    return features?.[0] || null;
  }

  function handleMapBuildingClick(event) {
    const feature = getPrimaryBuildingFeature(event);
    if (!feature) return;
    const identity = getFeatureIdentity(feature);
    if (!identity) return;
    const clickSig = `${event?.originalEvent?.timeStamp || ''}:${event?.point?.x || ''}:${event?.point?.y || ''}:${identity.osmType}/${identity.osmId}`;
    if (clickSig === lastHandledBuildingClickSig) return;
    lastHandledBuildingClickSig = clickSig;
    selectBuildingOnMap({
      source: 'map-click',
      feature,
      identity,
      lngLat: event?.lngLat
    });
  }

  function focusSelectedFeature({ feature, identity, lngLat }) {
    if (!map) return;
    const filter = getSelectionFilter(feature, identity);
    const selectionKey = `${identity?.osmType || '?'}/${identity?.osmId || '?'}`;
    for (const layerId of getCurrentSelectedFillLayerIds()) {
      if (!map.getLayer(layerId)) continue;
      map.setFilter(layerId, filter);
      recordDebugSetFilter(layerId);
    }
    for (const layerId of getCurrentSelectedLineLayerIds()) {
      if (!map.getLayer(layerId)) continue;
      map.setFilter(layerId, filter);
      recordDebugSetFilter(layerId);
    }
    debugSelectionLog('highlight-applied', {
      method: 'setFilter',
      selectionKey,
      encodedId: identity?.osmType && Number.isInteger(identity?.osmId)
        ? encodeOsmFeatureId(identity.osmType, identity.osmId)
        : null
    });

    if (!lngLat) return;
    const desktopOffsetX = window.innerWidth >= 1024 ? -Math.round(window.innerWidth * 0.18) : 0;
    debugSelectionLog('zoom-start', {
      selectionKey,
      center: { lon: Number(lngLat.lng), lat: Number(lngLat.lat) }
    });
    map.easeTo({
      center: lngLat,
      offset: [desktopOffsetX, 0],
      duration: 420,
      essential: true
    });
    map.once('moveend', () => {
      debugSelectionLog('zoom-end', {
        selectionKey
      });
    });
  }

  function selectBuildingOnMap({ source, feature, identity, lngLat, lon = null, lat = null }) {
    focusSelectedFeature({ feature, identity, lngLat });
    debugSelectionLog('building-click', {
      source,
      layerId: feature?.layer?.id || null,
      featureId: feature?.id ?? null,
      properties: feature?.properties || null,
      selectionKey: `${identity.osmType}/${identity.osmId}`
    });
    dispatch('buildingClick', {
      ...identity,
      lon: Number.isFinite(Number(lon)) ? Number(lon) : null,
      lat: Number.isFinite(Number(lat)) ? Number(lat) : null,
      feature
    });
  }

  function clearSelectedFeature() {
    if (!map) return;
    for (const layerId of getCurrentSelectedFillLayerIds()) {
      if (!map.getLayer(layerId)) continue;
      map.setFilter(layerId, ['==', ['id'], -1]);
      recordDebugSetFilter(layerId);
    }
    for (const layerId of getCurrentSelectedLineLayerIds()) {
      if (!map.getLayer(layerId)) continue;
      map.setFilter(layerId, ['==', ['id'], -1]);
      recordDebugSetFilter(layerId);
    }
  }

  function applySelectionFromStore(selection) {
    if (!map || !selection?.osmType || !selection?.osmId) return;
    const identity = {
      osmType: selection.osmType,
      osmId: Number(selection.osmId)
    };
    const filter = getSelectionFilter(null, identity);
    for (const layerId of getCurrentSelectedFillLayerIds()) {
      if (!map.getLayer(layerId)) continue;
      map.setFilter(layerId, filter);
      recordDebugSetFilter(layerId);
    }
    for (const layerId of getCurrentSelectedLineLayerIds()) {
      if (!map.getLayer(layerId)) continue;
      map.setFilter(layerId, filter);
      recordDebugSetFilter(layerId);
    }
  }

  function updateSearchMarkers(items) {
    updateSearchMarkerSource(map, items);
  }

  function fitMapToSearchResults(items) {
    fitMapToSearchItems(map, items);
  }

  function onSearchClusterClick(event) {
    const feature = event?.features?.[0];
    if (!feature) return;
    const clusterId = feature.properties?.cluster_id;
    const coordinates = feature.geometry?.coordinates;
    const source = map.getSource(SEARCH_RESULTS_SOURCE_ID);
    if (!source || clusterId == null || !Array.isArray(coordinates)) return;
    source.getClusterExpansionZoom(clusterId, (error, zoom) => {
      if (error) return;
      map.easeTo({
        center: coordinates,
        zoom: Number.isFinite(zoom) ? zoom : Math.max(map.getZoom() + 1, 14),
        duration: 350,
        essential: true
      });
    });
  }

  function onSearchResultClick(event) {
    const feature = event?.features?.[0];
    if (!feature) return;
    const osmType = String(feature?.properties?.osm_type || '').trim();
    const osmId = Number(feature?.properties?.osm_id);
    if (!['way', 'relation'].includes(osmType) || !Number.isInteger(osmId) || osmId <= 0) return;

    const lng = Number(feature?.geometry?.coordinates?.[0]);
    const lat = Number(feature?.geometry?.coordinates?.[1]);
    const lngLat = (Number.isFinite(lng) && Number.isFinite(lat)) ? { lng, lat } : event?.lngLat;
    selectBuildingOnMap({
      source: 'search-result',
      feature: null,
      identity: { osmType, osmId },
      lngLat,
      lon: lng,
      lat
    });
  }

  function syncMapCameraStores() {
    if (!map || !cameraStoreSyncEnabled) return;
    setMapCenter(map.getCenter());
    setMapZoom(map.getZoom());
    setMapViewport(buildBboxSnapshot(map.getBounds?.()));
  }

  function syncMapZoomStore() {
    if (!map || !cameraStoreSyncEnabled) return;
    setMapZoom(map.getZoom());
  }

  function applyBuildingThemePaint(theme) {
    applyBuildingThemePaintToLayers({
      map,
      theme,
      fillLayerIds: getCurrentBuildingsFillLayerIds(),
      lineLayerIds: getCurrentBuildingsLineLayerIds()
    });
  }

  function clearStyleTransitionOverlaySoon() {
    if (styleTransitionTimer) {
      clearTimeout(styleTransitionTimer);
      styleTransitionTimer = null;
    }
    styleTransitionOverlayVisible = false;
    styleTransitionTimer = setTimeout(() => {
      styleTransitionOverlaySrc = null;
      styleTransitionTimer = null;
    }, STYLE_OVERLAY_FADE_MS);
  }

  function captureStyleTransitionOverlay() {
    if (!map) return;
    try {
      const canvas = map.getCanvas();
      if (!canvas || typeof canvas.toDataURL !== 'function') return;
      styleTransitionOverlaySrc = canvas.toDataURL('image/png');
      styleTransitionOverlayVisible = true;
    } catch {
      styleTransitionOverlaySrc = null;
      styleTransitionOverlayVisible = false;
    }
  }

  function onPointerEnter() {
    if (!map) return;
    map.getCanvas().style.cursor = 'pointer';
  }

  function onPointerLeave() {
    if (!map) return;
    map.getCanvas().style.cursor = '';
  }

  function bindStyleInteractionHandlers() {
    bindMapInteractionHandlers({
      map,
      buildingFillLayerIds: getCurrentBuildingsFillLayerIds(),
      buildingLineLayerIds: getCurrentBuildingsLineLayerIds(),
      onBuildingClick: handleMapBuildingClick,
      onSearchClusterClick,
      onSearchResultClick,
      onPointerEnter,
      onPointerLeave
    });
  }

  function applyLabelLayerVisibility(visible) {
    applyMapLabelLayerVisibility(map, visible);
  }

  function setCartoBuildingsVisibility(nextVisibility) {
    if (!map || !map.isStyleLoaded()) return;
    if (coverageVisibleState === nextVisibility) return;
    for (const layerId of CARTO_BUILDING_LAYER_IDS) {
      if (!map.getLayer(layerId)) continue;
      map.setLayoutProperty(layerId, 'visibility', nextVisibility);
    }
    coverageVisibleState = nextVisibility;
  }

  function queueCartoBuildingsVisibility(nextVisibility) {
    if (nextVisibility === 'none') {
      if (cartoShowTimer) {
        clearTimeout(cartoShowTimer);
        cartoShowTimer = null;
      }
      setCartoBuildingsVisibility('none');
      return;
    }
    if (cartoShowTimer) {
      clearTimeout(cartoShowTimer);
    }
    cartoShowTimer = setTimeout(() => {
      cartoShowTimer = null;
      setCartoBuildingsVisibility('visible');
    }, CARTO_SHOW_DELAY_MS);
  }

  function getViewportSamplePoints() {
    if (!map) return [];
    const bounds = map.getBounds();
    if (!bounds) return [];
    const west = bounds.getWest();
    const east = bounds.getEast();
    const south = bounds.getSouth();
    const north = bounds.getNorth();
    const center = map.getCenter();
    const midLon = (west + east) / 2;
    const midLat = (north + south) / 2;
    return [
      [center.lng, center.lat],
      [west, north],
      [east, north],
      [east, south],
      [west, south],
      [midLon, north],
      [midLon, south],
      [west, midLat],
      [east, midLat]
    ];
  }

  async function evaluatePmtilesCoverage() {
    if (!map || !map.isStyleLoaded()) return;
    const token = ++coverageEvalToken;
    const regions = activeRegionPmtiles.length > 0
      ? activeRegionPmtiles
      : getViewportActiveRegionPmtiles(runtimeConfig);
    if (regions.length === 0) {
      queueCartoBuildingsVisibility('visible');
      return;
    }
    const points = getViewportSamplePoints();
    if (points.length === 0) return;
    for (const [lon, lat] of points) {
      if (token !== coverageEvalToken) return;
      const covered = regions.some((region) => pointInBounds(lon, lat, region.bounds));
      if (!covered) {
        queueCartoBuildingsVisibility('visible');
        return;
      }
    }
    queueCartoBuildingsVisibility('none');
  }

  function scheduleCoverageCheck() {
    if (coverageDebounceTimer) {
      clearTimeout(coverageDebounceTimer);
      coverageDebounceTimer = null;
    }
    coverageDebounceTimer = setTimeout(() => {
      coverageDebounceTimer = null;
      evaluatePmtilesCoverage();
    }, 80);
  }

  function ensureMapSourcesAndLayers(config) {
    if (!map) return;
    const theme = getCurrentTheme();
    const buildingPaint = getBuildingThemePaint(theme);
    ensureSearchResultsSourceAndLayers(map, $searchMapState.items);

    const nextActiveRegions = getViewportActiveRegionPmtiles(config);
    const nextIds = new Set(nextActiveRegions.map((region) => region.id));
    for (const currentRegion of activeRegionPmtiles) {
      if (nextIds.has(currentRegion.id)) continue;
      removeRegionBuildingSourceAndLayers(map, currentRegion.id);
    }
    activeRegionPmtiles = nextActiveRegions;
    for (const region of nextActiveRegions) {
      ensureRegionBuildingSourceAndLayers({
        map,
        region,
        buildingPaint,
        origin: window.location.origin
      });
    }
    bringSearchResultsLayersToFront(map);

    bindStyleInteractionHandlers();
    applySelectionFromStore($selectedBuilding);
    updateSearchMarkers($searchMapState.items);
    applyBuildingThemePaint(theme);
    applyLabelLayerVisibility($mapLabelsVisible);
    scheduleCoverageCheck();
    updateFilterDebugHook({
      active: Array.isArray($buildingFilterRules) && $buildingFilterRules.length > 0,
      expr: ['literal', currentFilterRulesHash],
      mode: FILTER_HIGHLIGHT_MODE
    });
    reapplyFilteredFeatureState();
  }

  function syncMapRegionSources() {
    if (!map || !runtimeConfig) return;
    ensureMapSourcesAndLayers(runtimeConfig);
  }

  function scheduleFilterRefresh() {
    if (mapMoveDebounceTimer) {
      clearTimeout(mapMoveDebounceTimer);
      mapMoveDebounceTimer = null;
    }
    if (filterRulesDebounceTimer) {
      clearTimeout(filterRulesDebounceTimer);
      filterRulesDebounceTimer = null;
    }
    mapMoveDebounceTimer = setTimeout(() => {
      mapMoveDebounceTimer = null;
      applyBuildingFilters($buildingFilterRules, { reason: 'viewport' });
    }, FILTER_REQUEST_DEBOUNCE_MS);
  }

  function registerFilterMoveEnd() {
    if (!map) return;
    const center = map.getCenter();
    const nextCenter = {
      lng: Number(center?.lng || 0),
      lat: Number(center?.lat || 0)
    };
    if (filterLastMapCenter) {
      filterLastMoveVector = {
        dx: nextCenter.lng - filterLastMapCenter.lng,
        dy: nextCenter.lat - filterLastMapCenter.lat
      };
    }
    filterLastMapCenter = nextCenter;
    filterLastMoveEndAt = Date.now();
    recordFilterTelemetry('moveend', {
      center: nextCenter,
      zoom: Number(map.getZoom() || 0)
    });
  }

  function scheduleFilterRulesRefresh(rules = $buildingFilterRules) {
    if (filterRulesDebounceTimer) {
      clearTimeout(filterRulesDebounceTimer);
      filterRulesDebounceTimer = null;
    }
    applyBuildingFilters(rules, { reason: 'rules' });
  }

  function restoreCustomLayersAfterStyleChange() {
    if (!map || !runtimeConfig) return;
    const tryRestore = () => {
      if (!map || !runtimeConfig) return;
      if (!map.isStyleLoaded()) return;
      ensureMapSourcesAndLayers(runtimeConfig);
      applyBuildingThemePaint(getCurrentTheme());
      applyBuildingFilters($buildingFilterRules, { reason: 'style' });
      clearStyleTransitionOverlaySoon();
    };
    map.once('styledata', tryRestore);
    map.once('idle', tryRestore);
  }

  function applyThemeToMap(theme) {
    if (!map) return;
    const nextStyle = getMapStyleForTheme(theme);
    if (nextStyle === currentMapStyleUrl) return;
    captureStyleTransitionOverlay();
    currentMapStyleUrl = nextStyle;
    map.setStyle(nextStyle);
    restoreCustomLayersAfterStyleChange();
  }

  function normalizeTagValue(value) {
    if (value == null) return null;
    if (Array.isArray(value)) return value.join(';');
    return String(value);
  }

  function matchesRule(tags, rule) {
    if (!rule || !rule.key) return true;
    const actualRaw = tags?.[rule.key];
    const actual = normalizeTagValue(actualRaw);
    const hasValue = actual != null && String(actual).trim().length > 0;
    if (rule.op === 'exists') return hasValue;
    if (rule.op === 'not_exists') return !hasValue;
    if (actual == null) return false;
    const left = String(actual).toLowerCase();
    const right = String(rule.value || '').toLowerCase();
    if (rule.op === 'equals') return left === right;
    if (rule.op === 'not_equals') return left !== right;
    if (rule.op === 'starts_with') return left.startsWith(right);
    return left.includes(right);
  }

  function getCurrentFilterBbox() {
    if (!map) return null;
    const bounds = map.getBounds?.();
    return buildBboxSnapshot(bounds);
  }

  function canReuseActiveCoverageWindow({ viewportBbox, rulesHash, zoomBucket, reason }) {
    if (reason !== 'viewport') return false;
    if (!activeFilterCoverageWindow) return false;
    if (String(activeFilterCoverageWindow.rulesHash || '') !== String(rulesHash || '')) return false;
    if (Number(activeFilterCoverageWindow.zoomBucket || 0) !== Number(zoomBucket || 0)) return false;
    return isViewportInsideBbox(viewportBbox, activeFilterCoverageWindow);
  }

  function buildPrefetchCoverageWindow(coverageWindow) {
    if (!coverageWindow) return null;
    const width = Number(coverageWindow.east) - Number(coverageWindow.west);
    const height = Number(coverageWindow.north) - Number(coverageWindow.south);
    if (!(width > 0) || !(height > 0)) return null;
    const directionX = filterLastMoveVector.dx > 0 ? 1 : (filterLastMoveVector.dx < 0 ? -1 : 0);
    const directionY = filterLastMoveVector.dy > 0 ? 1 : (filterLastMoveVector.dy < 0 ? -1 : 0);
    const shiftX = width * (directionX === 0 ? 0.7 : 1.02 * directionX);
    const shiftY = height * (directionY === 0 ? 0.7 : 1.02 * directionY);
    return {
      west: Number(coverageWindow.west) + shiftX,
      east: Number(coverageWindow.east) + shiftX,
      south: Number(coverageWindow.south) + shiftY,
      north: Number(coverageWindow.north) + shiftY
    };
  }

  async function prepareRulesForFiltering(rules) {
    try {
      const workerResult = await requestFilterWorker('prepare-rules', {
        rules
      });
      if (workerResult?.ok) {
        return {
          ok: true,
          rules: Array.isArray(workerResult.rules) ? workerResult.rules : [],
          rulesHash: String(workerResult.rulesHash || 'fnv1a-0'),
          heavy: Boolean(workerResult.heavy)
        };
      }
      return {
        ok: false,
        error: String(workerResult?.invalidReason || 'Invalid filter rules')
      };
    } catch {
      const activeRules = Array.isArray(rules) ? rules.filter((r) => r?.key) : [];
      const invalidRule = activeRules.find((rule) => !FILTER_RULE_OPS.has(String(rule?.op || 'contains')));
      if (invalidRule) {
        return {
          ok: false,
          error: `Invalid filter operator: ${String(invalidRule.op || '')}`
        };
      }
      const normalized = activeRules.map((rule) => ({
        key: String(rule.key || '').trim(),
        op: String(rule.op || 'contains').trim(),
        value: String(rule.value || '').trim()
      }));
      return {
        ok: true,
        rules: normalized,
        rulesHash: hashFilterExpression(['literal', normalized]),
        heavy: normalized.some((rule) => rule.op === 'contains')
      };
    }
  }

  function getVisibleBuildingOsmKeys() {
    if (!map) return [];
    const layerIds = [
      ...getCurrentBuildingsFillLayerIds(),
      ...getCurrentBuildingsLineLayerIds()
    ];
    if (layerIds.length === 0) return [];
    const features = map.queryRenderedFeatures({ layers: layerIds });
    const keys = new Set();
    for (const feature of Array.isArray(features) ? features : []) {
      const identity = getFeatureIdentity(feature);
      if (!identity?.osmType || !Number.isInteger(identity?.osmId)) continue;
      keys.add(`${identity.osmType}/${identity.osmId}`);
    }
    return [...keys];
  }

  function getLoadedSourceBuildingOsmKeys() {
    const keys = new Set();
    for (const sourceConfig of getCurrentBuildingSourceConfigs()) {
      if (!map || !sourceConfig?.sourceLayer || !map.getSource(sourceConfig.sourceId)) continue;
      const features = map.querySourceFeatures(sourceConfig.sourceId, {
        sourceLayer: sourceConfig.sourceLayer
      });
      for (const feature of Array.isArray(features) ? features : []) {
        const identity = getFeatureIdentity(feature);
        if (!identity?.osmType || !Number.isInteger(identity?.osmId)) continue;
        keys.add(`${identity.osmType}/${identity.osmId}`);
      }
    }
    return [...keys];
  }

  function getFilterCandidateOsmKeys() {
    const renderedKeys = getVisibleBuildingOsmKeys();
    if (renderedKeys.length > 0) return renderedKeys;
    return getLoadedSourceBuildingOsmKeys();
  }

  async function fetchFilterMatchesPrimary({ bbox, zoomBucket, rules, rulesHash, signal }) {
    return apiJson('/api/buildings/filter-matches', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        bbox,
        zoomBucket,
        rules,
        rulesHash,
        maxResults: FILTER_MATCH_DEFAULT_LIMIT
      }),
      signal
    });
  }

  async function fetchFilterDataByOsmKeys(keys, signal) {
    const normalized = [...new Set((Array.isArray(keys) ? keys : [])
      .map((key) => String(key || '').trim())
      .filter((key) => /^(way|relation)\/\d+$/.test(key))
    )];
    if (normalized.length === 0) return new Map();

    const out = new Map();
    const missing = [];
    const now = Date.now();
    for (const key of normalized) {
      const cached = filterDataByOsmKeyCache.get(key);
      if (cached && (now - cached.cachedAt) <= FILTER_DATA_CACHE_TTL_MS) {
        out.set(key, cached.item);
      } else {
        if (cached) filterDataByOsmKeyCache.delete(key);
        missing.push(key);
      }
    }

    for (let i = 0; i < missing.length; i += FILTER_DATA_REQUEST_CHUNK_SIZE) {
      const chunk = missing.slice(i, i + FILTER_DATA_REQUEST_CHUNK_SIZE);
      const payload = await apiJson('/api/buildings/filter-data', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ keys: chunk }),
        signal
      });
      const items = Array.isArray(payload?.items) ? payload.items : [];
      for (const item of items) {
        const osmKey = String(item?.osmKey || '').trim();
        if (!osmKey) continue;
        filterDataByOsmKeyCache.set(osmKey, {
          cachedAt: Date.now(),
          item
        });
        while (filterDataByOsmKeyCache.size > FILTER_DATA_CACHE_MAX_ITEMS) {
          const oldestKey = filterDataByOsmKeyCache.keys().next().value;
          if (!oldestKey) break;
          filterDataByOsmKeyCache.delete(oldestKey);
        }
        out.set(osmKey, item);
      }
    }
    return out;
  }

  async function fetchFilterMatchesFallback({ rules, signal }) {
    const visibleKeys = getFilterCandidateOsmKeys();
    if (visibleKeys.length === 0) {
      return {
        matchedKeys: [],
        matchedFeatureIds: [],
        meta: {
          rulesHash: currentFilterRulesHash,
          bboxHash: lastViewportHash,
          truncated: false,
          elapsedMs: 0,
          cacheHit: false
        }
      };
    }
    const byKey = await fetchFilterDataByOsmKeys(visibleKeys, signal);
    const matchedKeys = [];
    const matchedFeatureIds = [];
    for (const key of visibleKeys) {
      const item = byKey.get(key);
      if (!item) continue;
      const tags = item?.sourceTags || {};
      const ok = rules.every((rule) => matchesRule(tags, rule));
      if (!ok) continue;
      matchedKeys.push(key);
      const parsed = parseOsmKey(key);
      if (parsed) {
        matchedFeatureIds.push(encodeOsmFeatureId(parsed.osmType, parsed.osmId));
      }
      if (matchedKeys.length >= FILTER_MATCH_DEFAULT_LIMIT) break;
    }
    return {
      matchedKeys,
      matchedFeatureIds,
      meta: {
        rulesHash: currentFilterRulesHash,
        bboxHash: lastViewportHash,
        truncated: matchedKeys.length >= FILTER_MATCH_DEFAULT_LIMIT,
        elapsedMs: 0,
        cacheHit: false
      }
    };
  }

  function scheduleFilterPrefetch(context, token) {
    if (!FILTER_PREFETCH_ENABLED || !context?.coverageWindow || !context?.rulesHash || !context?.rules?.length) return;
    const now = Date.now();
    if ((now - filterLastPrefetchAt) < FILTER_PREFETCH_MIN_INTERVAL_MS) return;
    const prefetchBbox = buildPrefetchCoverageWindow(context.coverageWindow);
    if (!prefetchBbox) return;
    const prefetchHash = buildBboxHash(prefetchBbox, 4);
    const prefetchCacheKey = `${context.rulesHash}:${prefetchHash}:${context.zoomBucket}`;
    if (getCachedFilterMatches(prefetchCacheKey)) return;

    cancelPrefetchRequest();
    filterPrefetchTimer = setTimeout(async () => {
      filterPrefetchTimer = null;
      if (token !== latestFilterToken || !map) return;

      prefetchFilterAbortController = new AbortController();
      const signal = prefetchFilterAbortController.signal;
      filterLastPrefetchAt = Date.now();
      recordFilterRequestDebugEvent('prefetch-start');
      recordFilterTelemetry('prefetch_start', {
        prefetchHash
      });

      try {
        const payload = await fetchFilterMatchesPrimary({
          bbox: prefetchBbox,
          zoomBucket: context.zoomBucket,
          rules: context.rules,
          rulesHash: context.rulesHash,
          signal
        });
        if (token !== latestFilterToken) return;
        putCachedFilterMatches(prefetchCacheKey, payload);
        recordFilterRequestDebugEvent('prefetch-finish');
        recordFilterTelemetry('prefetch_finish', {
          prefetchHash,
          count: Math.max(
            Array.isArray(payload?.matchedFeatureIds) ? payload.matchedFeatureIds.length : 0,
            Array.isArray(payload?.matchedKeys) ? payload.matchedKeys.length : 0
          )
        });
      } catch (error) {
        if (String(error?.name || '').toLowerCase() === 'aborterror') {
          recordFilterRequestDebugEvent('prefetch-abort');
          recordFilterTelemetry('prefetch_abort', { prefetchHash });
        }
      } finally {
        if (prefetchFilterAbortController?.signal === signal) {
          prefetchFilterAbortController = null;
        }
      }
    }, 60);
  }

  function scheduleAuthoritativeRequest(context, token, debounceMs) {
    if (filterAuthoritativeTimer) {
      clearTimeout(filterAuthoritativeTimer);
      filterAuthoritativeTimer = null;
    }
    if (filterPrefetchTimer) {
      clearTimeout(filterPrefetchTimer);
      filterPrefetchTimer = null;
    }
    filterAuthoritativeTimer = setTimeout(async () => {
      filterAuthoritativeTimer = null;
      if (token !== latestFilterToken || !map) return;
      const requestKey = `${context.rulesHash}:${context.coverageHash}:${context.zoomBucket}`;
      if (requestKey === lastAuthoritativeRequestKey && context.reason === 'viewport') {
        return;
      }
      lastAuthoritativeRequestKey = requestKey;
      cancelPrefetchRequest();
      if (activeFilterAbortController) {
        debugFilterLog('filter request abort', { requestKey });
        recordFilterRequestDebugEvent('abort');
        recordFilterTelemetry('request_abort', { requestKey });
        activeFilterAbortController.abort();
      }
      activeFilterAbortController = new AbortController();
      const signal = activeFilterAbortController.signal;
      debugFilterLog('filter request start', {
        requestKey,
        phase: 'authoritative',
        heavy: context.heavy,
        coverageHash: context.coverageHash
      });
      recordFilterRequestDebugEvent('start');
      recordFilterTelemetry('request_start', {
        requestKey,
        delayFromMoveEndMs: filterLastMoveEndAt > 0 ? Math.max(0, Date.now() - filterLastMoveEndAt) : null
      });
      updateFilterRuntimeStatus({
        statusCode: 'refining'
      });

      let payload;
      let usedFallback = false;
      try {
        payload = await fetchFilterMatchesPrimary({
          bbox: context.coverageWindow,
          zoomBucket: context.zoomBucket,
          rules: context.rules,
          rulesHash: context.rulesHash,
          signal
        });
      } catch (error) {
        if (String(error?.name || '').toLowerCase() === 'aborterror') return;
        usedFallback = true;
        payload = await fetchFilterMatchesFallback({
          rules: context.rules,
          signal
        });
      } finally {
        if (activeFilterAbortController?.signal === signal) {
          activeFilterAbortController = null;
        }
      }
      if (token !== latestFilterToken) return;

      const matchedSize = Math.max(
        Array.isArray(payload?.matchedFeatureIds) ? payload.matchedFeatureIds.length : 0,
        Array.isArray(payload?.matchedKeys) ? payload.matchedKeys.length : 0
      );
      if (matchedSize > FILTER_MATCH_DEGRADE_LIMIT) {
        updateFilterRuntimeStatus({
          statusCode: 'too_many_matches',
          count: matchedSize
        });
        setFilterPhase('authoritative');
        recordFilterTelemetry('request_degraded', {
          requestKey,
          count: matchedSize
        });
        return;
      }

      await applyFilteredFeatureStateMatches(payload, token, { phase: 'authoritative' });
      if (token !== latestFilterToken) return;
      putCachedFilterMatches(context.cacheKey, payload);
      activeFilterCoverageWindow = {
        ...context.coverageWindow,
        rulesHash: context.rulesHash,
        zoomBucket: context.zoomBucket
      };
      activeFilterCoverageKey = context.coverageHash;

      filterLastElapsedMs = Number(payload?.meta?.elapsedMs || 0);
      filterLastCacheHit = Boolean(payload?.meta?.cacheHit);
      filterLastCount = matchedSize;
      filterErrorMessage = '';
      setFilterPhase('authoritative');
      debugFilterLog('filter request finish', {
        requestKey,
        count: matchedSize,
        elapsedMs: filterLastElapsedMs,
        cacheHit: filterLastCacheHit,
        truncated: Boolean(payload?.meta?.truncated),
        fallback: usedFallback
      });
      recordFilterRequestDebugEvent('finish');
      recordFilterTelemetry('request_finish', {
        requestKey,
        count: matchedSize,
        elapsedMs: filterLastElapsedMs,
        applyDelayFromMoveEndMs: filterLastMoveEndAt > 0 ? Math.max(0, Date.now() - filterLastMoveEndAt) : null,
        setFeatureStateCalls: filterSetFeatureStateCallsLast,
        toEnable: filteredFeatureStateFeatureIds.size
      });
      updateFilterRuntimeStatus({
        statusCode: payload?.meta?.truncated ? 'truncated' : 'applied',
        count: filterLastCount,
        elapsedMs: filterLastElapsedMs,
        cacheHit: filterLastCacheHit,
        setFeatureStateCalls: filterSetFeatureStateCallsLast
      });
      updateFilterDebugHook({
        active: matchedSize > 0,
        expr: ['literal', context.rulesHash],
        mode: FILTER_HIGHLIGHT_MODE,
        phase: filterPhase,
        lastElapsedMs: filterLastElapsedMs,
        lastCount: filterLastCount,
        cacheHit: filterLastCacheHit
      });
      scheduleFilterPrefetch(context, token);
    }, Math.max(0, Number(debounceMs) || 0));
  }

  function clearFilterHighlight() {
    if (!map) return;
    if (activeFilterAbortController) {
      activeFilterAbortController.abort();
      activeFilterAbortController = null;
    }
    if (prefetchFilterAbortController) {
      prefetchFilterAbortController.abort();
      prefetchFilterAbortController = null;
    }
    cancelPrefetchRequest();
    if (filterAuthoritativeTimer) {
      clearTimeout(filterAuthoritativeTimer);
      filterAuthoritativeTimer = null;
    }
    clearFilteredFeatureState();
    filterStatusMessage = '';
    filterLastElapsedMs = 0;
    filterLastCacheHit = false;
    currentFilterRulesHash = 'fnv1a-0';
    activeFilterCoverageWindow = null;
    activeFilterCoverageKey = '';
    setFilterPhase('idle');
    updateFilterRuntimeStatus({
      statusCode: 'idle',
      message: '',
      count: 0,
      elapsedMs: 0,
      cacheHit: false,
      setFeatureStateCalls: 0
    });
  }

  async function applyBuildingFilters(rules, { reason = 'rules' } = {}) {
    if (!map) return;
    const token = ++latestFilterToken;
    const prepared = await prepareRulesForFiltering(rules);
    if (token !== latestFilterToken) return;

    if (!prepared.ok) {
      filterErrorMessage = prepared.error || translateNow('mapPage.filterStatus.invalid');
      filterStatusMessage = '';
      clearFilteredFeatureState();
      setFilterPhase('idle');
      updateFilterRuntimeStatus({
        statusCode: 'invalid',
        message: filterErrorMessage,
        count: 0
      });
      return;
    }
    const activeRules = prepared.rules;
    debugFilterLog('filter rules changed', { reason, rules: activeRules });
    currentFilterRulesHash = prepared.rulesHash;
    if (activeRules.length === 0) {
      filterErrorMessage = '';
      clearFilterHighlight();
      return;
    }

    const bbox = getCurrentFilterBbox();
    if (!bbox) {
      filterStatusMessage = '';
      updateFilterRuntimeStatus({
        statusCode: 'idle',
        message: ''
      });
      return;
    }
    const bboxHash = buildBboxHash(bbox, 4);
    const zoomBucket = Math.round(map.getZoom() * 2) / 2;
    const coverageWindow = getCoverageWindowForViewport(bbox) || bbox;
    const coverageHash = buildBboxHash(coverageWindow, 4);
    const cacheKey = `${prepared.rulesHash}:${coverageHash}:${zoomBucket}`;
    lastViewportHash = bboxHash;

    filterErrorMessage = '';
    filterLastCacheHit = false;
    setFilterPhase('optimistic');

    if (canReuseActiveCoverageWindow({
      viewportBbox: bbox,
      rulesHash: prepared.rulesHash,
      zoomBucket,
      reason
    })) {
      setFilterPhase('authoritative');
      recordFilterTelemetry('coverage_window_hit', {
        bboxHash,
        coverageHash: activeFilterCoverageKey
      });
      updateFilterRuntimeStatus({
        statusCode: 'applied',
        message: filterStatusMessage
      });
      return;
    }

    const cached = getCachedFilterMatches(cacheKey);
    if (cached) {
      await applyFilteredFeatureStateMatches(cached, token, { phase: 'optimistic' });
      if (token !== latestFilterToken) return;
      filterLastElapsedMs = Number(cached?.meta?.elapsedMs || 0);
      filterLastCacheHit = Boolean(cached?.meta?.cacheHit);
      filterLastCount = Math.max(
        Array.isArray(cached?.matchedFeatureIds) ? cached.matchedFeatureIds.length : 0,
        Array.isArray(cached?.matchedKeys) ? cached.matchedKeys.length : 0
      );
      activeFilterCoverageWindow = {
        ...coverageWindow,
        rulesHash: prepared.rulesHash,
        zoomBucket
      };
      activeFilterCoverageKey = coverageHash;
      updateFilterRuntimeStatus({
        statusCode: 'applied',
        count: filterLastCount,
        elapsedMs: filterLastElapsedMs,
        cacheHit: filterLastCacheHit,
        setFeatureStateCalls: filterSetFeatureStateCallsLast
      });
      updateFilterDebugHook({
        active: filterLastCount > 0,
        expr: ['literal', prepared.rulesHash],
        mode: FILTER_HIGHLIGHT_MODE,
        phase: filterPhase,
        lastElapsedMs: filterLastElapsedMs,
        lastCount: filterLastCount,
        cacheHit: filterLastCacheHit
      });
    }

    updateFilterRuntimeStatus({
      statusCode: 'refining'
    });
    const debounceMs = prepared.heavy
      ? FILTER_HEAVY_RULE_DEBOUNCE_MS
      : (reason === 'rules' ? FILTER_RULE_CHANGE_DEBOUNCE_MS : FILTER_REQUEST_DEBOUNCE_MS);

    scheduleAuthoritativeRequest({
      reason,
      heavy: prepared.heavy,
      rules: activeRules,
      rulesHash: prepared.rulesHash,
      coverageWindow,
      coverageHash,
      bboxHash,
      zoomBucket,
      cacheKey
    }, token, debounceMs);
  }

  $: if (map && !$selectedBuilding) {
    lastSelectedKey = null;
    clearSelectedFeature();
  }

  $: if (map && $selectedBuilding?.osmType && $selectedBuilding?.osmId) {
    const key = `${$selectedBuilding.osmType}/${$selectedBuilding.osmId}`;
    if (key !== lastSelectedKey) {
      lastSelectedKey = key;
      applySelectionFromStore($selectedBuilding);
    }
  }

  $: if (map) {
    const rules = $buildingFilterRules;
    scheduleFilterRulesRefresh(rules);
  }

  $: if (map) {
    updateSearchMarkers($searchMapState.items);
  }

  $: if (map && $searchState.fitSeq !== lastSearchFitSeq) {
    lastSearchFitSeq = $searchState.fitSeq;
    fitMapToSearchResults($searchState.items);
  }

  $: if (map && $mapFocusRequest && $mapFocusRequest.id !== lastMapFocusRequestId) {
    lastMapFocusRequestId = $mapFocusRequest.id;
    const nextZoom = normalizeOptionalMapZoom($mapFocusRequest.zoom) ?? map.getZoom();
    map.easeTo({
      center: [Number($mapFocusRequest.lon), Number($mapFocusRequest.lat)],
      offset: [Number($mapFocusRequest.offsetX || 0), Number($mapFocusRequest.offsetY || 0)],
      zoom: nextZoom,
      duration: Number($mapFocusRequest.duration || 420),
      essential: true
    });
  }

  $: if (map) {
    applyLabelLayerVisibility($mapLabelsVisible);
  }

  onMount(() => {
    let mountAlive = true;
    filterDenseBurstEnabled = resolveFilterDenseBurstEnabled();

    async function initMap() {
      const { maplibregl: maplibreModule, Protocol: ProtocolCtor } = await loadMapRuntime();
      if (!mountAlive) return;
      maplibregl = maplibreModule;

      const config = getRuntimeConfig();
      runtimeConfig = config;
      protocol = new ProtocolCtor();
      maplibregl.addProtocol('pmtiles', protocol.tile);
      currentMapStyleUrl = getMapStyleForTheme(getCurrentTheme());
      coverageVisibleState = 'visible';
      const initialCamera = resolveInitialMapCamera({
        url: window.location.href,
        persistedCamera: get(lastMapCamera),
        fallbackCamera: {
          lng: config.mapDefault.lon,
          lat: config.mapDefault.lat,
          z: config.mapDefault.zoom
        }
      }) || {
        lng: Number(config.mapDefault.lon),
        lat: Number(config.mapDefault.lat),
        z: Number(config.mapDefault.zoom)
      };
      setMapCenter({
        lng: initialCamera.lng,
        lat: initialCamera.lat
      });
      setMapZoom(initialCamera.z);

      map = new maplibregl.Map({
        container,
        style: currentMapStyleUrl,
        center: [initialCamera.lng, initialCamera.lat],
        zoom: Number(initialCamera.z),
        attributionControl: false
      });
      map.addControl(new maplibregl.AttributionControl({
        compact: true,
        customAttribution: CUSTOM_MAP_ATTRIBUTION
      }));
      map.addControl(new maplibregl.NavigationControl(), 'top-right');
      map.on('moveend', () => {
        registerFilterMoveEnd();
        syncMapCameraStores();
        syncMapRegionSources();
      });
      map.on('moveend', scheduleFilterRefresh);
      map.on('moveend', scheduleCoverageCheck);
      map.on('move', scheduleCoverageCheck);
      map.on('zoomend', scheduleFilterRefresh);
      map.on('zoomend', syncMapZoomStore);
      map.on('zoomend', syncMapRegionSources);
      map.on('zoomend', scheduleCoverageCheck);
      map.on('resize', syncMapRegionSources);
      map.on('resize', scheduleCoverageCheck);

      map.on('style.load', () => {
        ensureMapSourcesAndLayers(config);
        scheduleFilterRefresh();
        scheduleCoverageCheck();
      });

      map.on('load', () => {
        cameraStoreSyncEnabled = true;
        registerFilterMoveEnd();
        syncMapCameraStores();
        setMapReady(true);
        scheduleCoverageCheck();
      });

      themeObserver = new MutationObserver(() => {
        applyThemeToMap(getCurrentTheme());
      });
      themeObserver.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ['data-theme']
      });
    }

    initMap().catch(() => {
      // Keep empty fallback state if map runtime cannot initialize.
    });

    return () => {
      mountAlive = false;
    };
  });

  onDestroy(() => {
    cameraStoreSyncEnabled = false;
    setMapReady(false);
    setMapCenter(null);
    setMapZoom(null);
    setMapViewport(null);
    if (themeObserver) {
      themeObserver.disconnect();
      themeObserver = null;
    }
    if (styleTransitionTimer) {
      clearTimeout(styleTransitionTimer);
      styleTransitionTimer = null;
    }
    if (mapMoveDebounceTimer) {
      clearTimeout(mapMoveDebounceTimer);
      mapMoveDebounceTimer = null;
    }
    if (filterRulesDebounceTimer) {
      clearTimeout(filterRulesDebounceTimer);
      filterRulesDebounceTimer = null;
    }
    if (filterAuthoritativeTimer) {
      clearTimeout(filterAuthoritativeTimer);
      filterAuthoritativeTimer = null;
    }
    if (coverageDebounceTimer) {
      clearTimeout(coverageDebounceTimer);
      coverageDebounceTimer = null;
    }
    if (cartoShowTimer) {
      clearTimeout(cartoShowTimer);
      cartoShowTimer = null;
    }
    if (activeFilterAbortController) {
      activeFilterAbortController.abort();
      activeFilterAbortController = null;
    }
    if (map) {
      clearFilteredFeatureState();
    }
    if (map) {
      map.remove();
      map = null;
    }
    runtimeConfig = null;
    if (protocol) {
      protocol?.destroy?.();
      protocol = null;
    }
    filterMatchesCache = new Map();
    filterDataByOsmKeyCache = new Map();
    filteredFeatureStateFeatureIds = new Set();
    setBuildingFilterRuntimeStatus({
      phase: 'idle',
      statusCode: 'idle',
      message: '',
      count: 0,
      elapsedMs: 0,
      cacheHit: false,
      setFeatureStateCalls: 0,
      updatedAt: Date.now()
    });
    if (filterWorkerService) {
      filterWorkerService.destroy();
      filterWorkerService = null;
    }
    updateFilterDebugHook({
      active: false,
      expr: EMPTY_LAYER_FILTER
    });
  });
</script>

<div
  class="map-canvas"
  bind:this={container}
  data-filter-active={filterDebugActive ? 'true' : 'false'}
  data-filter-highlight-mode={FILTER_HIGHLIGHT_MODE}
  data-filter-expr-hash={filterDebugExprHash}
  data-filter-phase={filterPhase}
  data-filter-last-elapsed-ms={String(filterLastElapsedMs)}
  data-filter-last-count={String(filterLastCount)}
  data-filter-cache-hit={filterLastCacheHit ? 'true' : 'false'}
  data-filter-set-feature-state-calls={String(filterSetFeatureStateCallsLast)}
  data-filter-last-apply-diff-ms={String(filterLastApplyDiffMs)}
></div>
<MapFeedbackOverlay
  {filterStatusCode}
  {filterStatusOverlayText}
  {filterErrorMessage}
  {styleTransitionOverlaySrc}
  {styleTransitionOverlayVisible}
/>

<style>
  .map-canvas {
    position: fixed;
    inset: 0;
  }
</style>
