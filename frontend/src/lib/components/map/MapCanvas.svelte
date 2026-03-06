<script>
  import { createEventDispatcher, onDestroy, onMount } from 'svelte';
  import { getRuntimeConfig } from '$lib/services/config';
  import { apiJson } from '$lib/services/http';
  import { loadMapRuntime, resolvePmtilesUrl } from '$lib/services/map-runtime';
  import { t, translateNow } from '$lib/i18n/index';
  import {
    mapFocusRequest,
    mapLabelsVisible,
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
    expandBboxWithMargin,
    getAdaptiveCoverageMarginRatio,
    isViewportInsideBbox
  } from './filter-pipeline-utils';
  import { EMPTY_LAYER_FILTER, hashFilterExpression } from './filter-highlight-utils';

  const dispatch = createEventDispatcher();
  const LIGHT_MAP_STYLE_URL = '/styles/positron-custom.json';
  const DARK_MAP_STYLE_URL = '/styles/dark-matter-custom.json';
  const BUILDINGS_SOURCE_ID = 'local-buildings';
  const BUILDINGS_FILL_LAYER_ID = 'local-buildings-fill';
  const BUILDINGS_LINE_LAYER_ID = 'local-buildings-line';
  const FILTER_HIGHLIGHT_FILL_LAYER_ID = 'buildings-filter-highlight-fill';
  const FILTER_HIGHLIGHT_LINE_LAYER_ID = 'buildings-filter-highlight-outline';
  const FILTER_HIGHLIGHT_MODE = 'feature-state';
  const SELECTED_FILL_LAYER_ID = 'selected-building-fill';
  const SELECTED_LINE_LAYER_ID = 'selected-building-line';
  const SEARCH_RESULTS_SOURCE_ID = 'search-results-points';
  const SEARCH_RESULTS_LAYER_ID = 'search-results-points-layer';
  const SEARCH_RESULTS_CLUSTER_LAYER_ID = 'search-results-clusters-layer';
  const SEARCH_RESULTS_CLUSTER_COUNT_LAYER_ID = 'search-results-clusters-count-layer';
  const CARTO_BUILDING_LAYER_IDS = ['building', 'building-top'];
  const STYLE_OVERLAY_FADE_MS = 260;
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
  const BUILDING_THEME = {
    light: {
      fillColor: '#a3a3a3',
      fillOpacity: 0.32,
      lineColor: '#bcbcbc',
      lineWidth: 0.9
    },
    dark: {
      fillColor: '#64748b',
      fillOpacity: 0.36,
      lineColor: '#94a3b8',
      lineWidth: 1
    }
  };

  let container;
  let map = null;
  let maplibregl = null;
  let protocol = null;
  let pmtilesArchive = null;
  let pmtilesMinZoom = null;
  let pmtilesMaxZoom = null;
  let themeObserver = null;
  let mapMoveDebounceTimer = null;
  let coverageDebounceTimer = null;
  let cartoShowTimer = null;
  let activeFilterAbortController = null;
  let prefetchFilterAbortController = null;
  let coverageEvalToken = 0;
  let coverageVisibleState = 'visible';
  let coverageCache = new Map();
  let filterMatchesCache = new Map();
  let filterWorker = null;
  let filterWorkerReqSeq = 0;
  let filterWorkerPending = new Map();
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
    if (!isFilterDebugEnabled()) return;
    console.debug('[map-filter]', eventName, {
      ts: new Date().toISOString(),
      ...payload
    });
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
    if (typeof document === 'undefined') return;
    const exprHash = hashFilterExpression(expr);
    filterDebugActive = Boolean(active);
    filterDebugExprHash = exprHash;
    document.body.dataset.filterActive = active ? 'true' : 'false';
    document.body.dataset.filterHighlightMode = String(mode);
    document.body.dataset.filterExprHash = exprHash;
    document.body.dataset.filterPhase = String(phase || 'idle');
    document.body.dataset.filterLastElapsedMs = String(Number(lastElapsedMs) || 0);
    document.body.dataset.filterLastCount = String(Number(lastCount) || 0);
    document.body.dataset.filterCacheHit = cacheHit ? 'true' : 'false';
    document.body.dataset.filterSetFeatureStateCalls = String(Number(setFeatureStateCalls) || 0);
    window.__MAP_DEBUG__ = window.__MAP_DEBUG__ || {};
    window.__MAP_DEBUG__.filter = {
      active: Boolean(active),
      mode: String(mode),
      exprHash,
      phase: String(phase || 'idle'),
      elapsedMs: Number(lastElapsedMs) || 0,
      count: Number(lastCount) || 0,
      cacheHit: Boolean(cacheHit),
      setFeatureStateCalls: Number(setFeatureStateCalls) || 0
    };
    const phaseHistory = Array.isArray(window.__MAP_DEBUG__.filterPhaseHistory)
      ? window.__MAP_DEBUG__.filterPhaseHistory
      : [];
    window.__MAP_DEBUG__.filterPhaseHistory = [...phaseHistory, String(phase || 'idle')].slice(-120);
    if (map) {
      const fillLayerVisible = map.getLayer(FILTER_HIGHLIGHT_FILL_LAYER_ID)
        ? (map.getLayoutProperty(FILTER_HIGHLIGHT_FILL_LAYER_ID, 'visibility') || 'visible')
        : 'missing';
      const lineLayerVisible = map.getLayer(FILTER_HIGHLIGHT_LINE_LAYER_ID)
        ? (map.getLayoutProperty(FILTER_HIGHLIGHT_LINE_LAYER_ID, 'visibility') || 'visible')
        : 'missing';
      window.__MAP_DEBUG__.layersVisibility = {
        [BUILDINGS_FILL_LAYER_ID]: map.getLayoutProperty(BUILDINGS_FILL_LAYER_ID, 'visibility') || 'visible',
        [BUILDINGS_LINE_LAYER_ID]: map.getLayoutProperty(BUILDINGS_LINE_LAYER_ID, 'visibility') || 'visible',
        [FILTER_HIGHLIGHT_FILL_LAYER_ID]: fillLayerVisible,
        [FILTER_HIGHLIGHT_LINE_LAYER_ID]: lineLayerVisible,
        [SELECTED_FILL_LAYER_ID]: map.getLayoutProperty(SELECTED_FILL_LAYER_ID, 'visibility') || 'visible',
        [SELECTED_LINE_LAYER_ID]: map.getLayoutProperty(SELECTED_LINE_LAYER_ID, 'visibility') || 'visible'
      };
    }
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

  function ensureFilterWorker() {
    if (filterWorker || typeof Worker === 'undefined') return;
    filterWorker = new Worker(new URL('../../workers/building-filter.worker.js', import.meta.url), { type: 'module' });
    filterWorker.onmessage = (event) => {
      const data = event?.data || {};
      const requestId = String(data?.requestId || '');
      const handlers = filterWorkerPending.get(requestId);
      if (!handlers) return;
      filterWorkerPending.delete(requestId);
      handlers.resolve(data);
    };
    filterWorker.onerror = () => {
      for (const [requestId, handlers] of filterWorkerPending.entries()) {
        filterWorkerPending.delete(requestId);
        handlers.reject(new Error('Filter worker crashed'));
      }
    };
  }

  function requestFilterWorker(type, payload = {}) {
    ensureFilterWorker();
    if (!filterWorker) {
      return Promise.reject(new Error('Filter worker is unavailable'));
    }
    const requestId = `w-${Date.now()}-${++filterWorkerReqSeq}`;
    return new Promise((resolve, reject) => {
      filterWorkerPending.set(requestId, { resolve, reject });
      filterWorker.postMessage({
        type,
        requestId,
        ...payload
      });
    });
  }

  function recordDebugSetFilter(layerId) {
    if (typeof window === 'undefined') return;
    window.__MAP_DEBUG__ = window.__MAP_DEBUG__ || {};
    const current = Array.isArray(window.__MAP_DEBUG__.setFilterLayers)
      ? window.__MAP_DEBUG__.setFilterLayers
      : [];
    const next = [...current, String(layerId)].slice(-80);
    window.__MAP_DEBUG__.setFilterLayers = next;
  }

  function recordFilterRequestDebugEvent(eventName) {
    if (typeof window === 'undefined') return;
    window.__MAP_DEBUG__ = window.__MAP_DEBUG__ || {};
    const stats = window.__MAP_DEBUG__.filterRequests || {
      start: 0,
      abort: 0,
      finish: 0,
      prefetchStart: 0,
      prefetchAbort: 0,
      prefetchFinish: 0
    };
    if (eventName === 'start') stats.start += 1;
    if (eventName === 'abort') stats.abort += 1;
    if (eventName === 'finish') stats.finish += 1;
    if (eventName === 'prefetch-start') stats.prefetchStart += 1;
    if (eventName === 'prefetch-abort') stats.prefetchAbort += 1;
    if (eventName === 'prefetch-finish') stats.prefetchFinish += 1;
    window.__MAP_DEBUG__.filterRequests = stats;
  }

  function recordFilterTelemetry(eventName, payload = {}) {
    if (!FILTER_TELEMETRY_ENABLED || typeof window === 'undefined') return;
    window.__MAP_DEBUG__ = window.__MAP_DEBUG__ || {};
    const telemetry = window.__MAP_DEBUG__.filterTelemetry || {
      counters: {},
      recentEvents: []
    };
    telemetry.counters[eventName] = Number(telemetry.counters[eventName] || 0) + 1;
    telemetry.recentEvents = [
      ...telemetry.recentEvents,
      {
        event: eventName,
        at: Date.now(),
        ...payload
      }
    ].slice(-140);
    window.__MAP_DEBUG__.filterTelemetry = telemetry;
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

  function setLocalBuildingFeatureStateById(id, state) {
    if (!map) return false;
    if (!Number.isInteger(id) || id <= 0) return false;
    const sourceLayer = runtimeConfig?.buildingsPmtiles?.sourceLayer;
    if (!sourceLayer) return false;
    try {
      map.setFeatureState(
        {
          source: BUILDINGS_SOURCE_ID,
          sourceLayer,
          id
        },
        state
      );
      return true;
    } catch {
      // Source/style might be reloading.
      return false;
    }
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
    const features = map.queryRenderedFeatures(event.point, {
      layers: [BUILDINGS_LINE_LAYER_ID, BUILDINGS_FILL_LAYER_ID]
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
    if (map.getLayer(SELECTED_FILL_LAYER_ID)) {
      map.setFilter(SELECTED_FILL_LAYER_ID, filter);
      recordDebugSetFilter(SELECTED_FILL_LAYER_ID);
    }
    if (map.getLayer(SELECTED_LINE_LAYER_ID)) {
      map.setFilter(SELECTED_LINE_LAYER_ID, filter);
      recordDebugSetFilter(SELECTED_LINE_LAYER_ID);
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
    if (map.getLayer(SELECTED_FILL_LAYER_ID)) {
      map.setFilter(SELECTED_FILL_LAYER_ID, ['==', ['id'], -1]);
      recordDebugSetFilter(SELECTED_FILL_LAYER_ID);
    }
    if (map.getLayer(SELECTED_LINE_LAYER_ID)) {
      map.setFilter(SELECTED_LINE_LAYER_ID, ['==', ['id'], -1]);
      recordDebugSetFilter(SELECTED_LINE_LAYER_ID);
    }
  }

  function applySelectionFromStore(selection) {
    if (!map || !selection?.osmType || !selection?.osmId) return;
    const identity = {
      osmType: selection.osmType,
      osmId: Number(selection.osmId)
    };
    const filter = getSelectionFilter(null, identity);
    if (map.getLayer(SELECTED_FILL_LAYER_ID)) {
      map.setFilter(SELECTED_FILL_LAYER_ID, filter);
      recordDebugSetFilter(SELECTED_FILL_LAYER_ID);
    }
    if (map.getLayer(SELECTED_LINE_LAYER_ID)) {
      map.setFilter(SELECTED_LINE_LAYER_ID, filter);
      recordDebugSetFilter(SELECTED_LINE_LAYER_ID);
    }
  }

  function getSearchItemPoint(item) {
    const lon = Number(item?.lon);
    const lat = Number(item?.lat);
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
    if (lon < -180 || lon > 180 || lat < -90 || lat > 90) return null;
    return [lon, lat];
  }

  function buildSearchMarkersGeojson(items) {
    const features = [];
    for (const item of Array.isArray(items) ? items : []) {
      const point = getSearchItemPoint(item);
      if (!point) continue;
      features.push({
        type: 'Feature',
        geometry: {
          type: 'Point',
          coordinates: point
        },
        properties: {
          osm_type: String(item?.osmType || ''),
          osm_id: Number(item?.osmId || 0),
          osm_key: `${String(item?.osmType || '')}/${String(item?.osmId || '')}`
        }
      });
    }
    return {
      type: 'FeatureCollection',
      features
    };
  }

  function updateSearchMarkers(items) {
    if (!map) return;
    const source = map.getSource(SEARCH_RESULTS_SOURCE_ID);
    if (!source) return;
    source.setData(buildSearchMarkersGeojson(items));
  }

  function fitMapToSearchResults(items) {
    if (!map) return;
    const points = (Array.isArray(items) ? items : [])
      .map((item) => getSearchItemPoint(item))
      .filter(Boolean);
    if (points.length === 0) return;

    if (points.length === 1) {
      map.easeTo({
        center: points[0],
        zoom: Math.max(map.getZoom(), 16),
        duration: 450,
        essential: true
      });
      return;
    }

    let minLon = Infinity;
    let minLat = Infinity;
    let maxLon = -Infinity;
    let maxLat = -Infinity;
    for (const [lon, lat] of points) {
      minLon = Math.min(minLon, lon);
      minLat = Math.min(minLat, lat);
      maxLon = Math.max(maxLon, lon);
      maxLat = Math.max(maxLat, lat);
    }

    map.fitBounds([[minLon, minLat], [maxLon, maxLat]], {
      padding: { top: 88, right: 30, bottom: 30, left: 30 },
      duration: 500,
      maxZoom: 16.5,
      essential: true
    });
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

  function getCurrentTheme() {
    return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
  }

  function syncMapCameraStores() {
    if (!map) return;
    setMapCenter(map.getCenter());
    setMapZoom(map.getZoom());
    setMapViewport(buildBboxSnapshot(map.getBounds?.()));
  }

  function getMapStyleForTheme(theme) {
    return theme === 'dark' ? DARK_MAP_STYLE_URL : LIGHT_MAP_STYLE_URL;
  }

  function getBuildingThemePaint(theme) {
    return theme === 'dark' ? BUILDING_THEME.dark : BUILDING_THEME.light;
  }

  function applyBuildingThemePaint(theme) {
    if (!map) return;
    const paint = getBuildingThemePaint(theme);
    if (map.getLayer(BUILDINGS_FILL_LAYER_ID)) {
      map.setPaintProperty(BUILDINGS_FILL_LAYER_ID, 'fill-color', paint.fillColor);
      map.setPaintProperty(BUILDINGS_FILL_LAYER_ID, 'fill-opacity', paint.fillOpacity);
    }
    if (map.getLayer(BUILDINGS_LINE_LAYER_ID)) {
      map.setPaintProperty(BUILDINGS_LINE_LAYER_ID, 'line-color', paint.lineColor);
      map.setPaintProperty(BUILDINGS_LINE_LAYER_ID, 'line-width', paint.lineWidth);
    }
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
    if (!map) return;
    map.off('click', handleMapBuildingClick);
    map.off('click', SEARCH_RESULTS_CLUSTER_LAYER_ID, onSearchClusterClick);
    map.off('click', SEARCH_RESULTS_LAYER_ID, onSearchResultClick);
    map.off('mouseenter', BUILDINGS_FILL_LAYER_ID, onPointerEnter);
    map.off('mouseleave', BUILDINGS_FILL_LAYER_ID, onPointerLeave);
    map.off('mouseenter', BUILDINGS_LINE_LAYER_ID, onPointerEnter);
    map.off('mouseleave', BUILDINGS_LINE_LAYER_ID, onPointerLeave);
    map.off('mouseenter', SEARCH_RESULTS_CLUSTER_LAYER_ID, onPointerEnter);
    map.off('mouseleave', SEARCH_RESULTS_CLUSTER_LAYER_ID, onPointerLeave);
    map.off('mouseenter', SEARCH_RESULTS_LAYER_ID, onPointerEnter);
    map.off('mouseleave', SEARCH_RESULTS_LAYER_ID, onPointerLeave);

    map.on('click', handleMapBuildingClick);
    map.on('click', SEARCH_RESULTS_CLUSTER_LAYER_ID, onSearchClusterClick);
    map.on('click', SEARCH_RESULTS_LAYER_ID, onSearchResultClick);
    map.on('mouseenter', BUILDINGS_FILL_LAYER_ID, onPointerEnter);
    map.on('mouseleave', BUILDINGS_FILL_LAYER_ID, onPointerLeave);
    map.on('mouseenter', BUILDINGS_LINE_LAYER_ID, onPointerEnter);
    map.on('mouseleave', BUILDINGS_LINE_LAYER_ID, onPointerLeave);
    map.on('mouseenter', SEARCH_RESULTS_CLUSTER_LAYER_ID, onPointerEnter);
    map.on('mouseleave', SEARCH_RESULTS_CLUSTER_LAYER_ID, onPointerLeave);
    map.on('mouseenter', SEARCH_RESULTS_LAYER_ID, onPointerEnter);
    map.on('mouseleave', SEARCH_RESULTS_LAYER_ID, onPointerLeave);
  }

  function isBaseLabelLayer(layer) {
    if (!layer || layer.type !== 'symbol') return false;
    const id = String(layer.id || '').toLowerCase();
    // Keep app-owned symbol overlays visible; toggle only base map symbols.
    if (id === SEARCH_RESULTS_CLUSTER_COUNT_LAYER_ID) return false;
    if (id.startsWith('search-results-')) return false;
    return true;
  }

  function applyLabelLayerVisibility(visible) {
    if (!map || !map.isStyleLoaded()) return;
    const layers = map.getStyle()?.layers || [];
    const nextVisibility = visible ? 'visible' : 'none';
    for (const layer of layers) {
      if (!isBaseLabelLayer(layer)) continue;
      if (!map.getLayer(layer.id)) continue;
      map.setLayoutProperty(layer.id, 'visibility', nextVisibility);
    }
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

  function normalizeLon(lon) {
    let next = Number(lon);
    while (next < -180) next += 360;
    while (next > 180) next -= 360;
    return next;
  }

  function lonLatToTile(lon, lat, z) {
    const zoom = Math.max(0, Math.floor(Number(z)));
    const latClamped = Math.max(-85.05112878, Math.min(85.05112878, Number(lat)));
    const lngWrapped = normalizeLon(lon);
    const world = 2 ** zoom;
    const xRaw = Math.floor(((lngWrapped + 180) / 360) * world);
    const latRad = (latClamped * Math.PI) / 180;
    const yRaw = Math.floor(((1 - (Math.log(Math.tan(latRad) + (1 / Math.cos(latRad))) / Math.PI)) / 2) * world);
    return {
      z: zoom,
      x: Math.max(0, Math.min(world - 1, xRaw)),
      y: Math.max(0, Math.min(world - 1, yRaw))
    };
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

  function readCoverageCache(key) {
    if (!coverageCache.has(key)) return null;
    const value = coverageCache.get(key);
    coverageCache.delete(key);
    coverageCache.set(key, value);
    return value;
  }

  function writeCoverageCache(key, value) {
    if (coverageCache.has(key)) {
      coverageCache.delete(key);
    }
    coverageCache.set(key, value);
    if (coverageCache.size <= COVERAGE_CACHE_LIMIT) return;
    const oldest = coverageCache.keys().next().value;
    if (oldest != null) coverageCache.delete(oldest);
  }

  async function hasPmtilesTile(tile) {
    if (!pmtilesArchive) return false;
    const key = `${tile.z}/${tile.x}/${tile.y}`;
    const cached = readCoverageCache(key);
    if (cached != null) return cached;
    try {
      const entry = await pmtilesArchive.getZxy(tile.z, tile.x, tile.y);
      const exists = Boolean(entry?.data || entry);
      writeCoverageCache(key, exists);
      return exists;
    } catch {
      // Treat transport/runtime errors as unknown to avoid false-positive base-layer flicker.
      return null;
    }
  }

  async function hasPmtilesCoverageAtPoint(lon, lat, startZoom) {
    const minZoom = Number.isInteger(pmtilesMinZoom) ? pmtilesMinZoom : 0;
    for (let z = startZoom; z >= minZoom; z -= 1) {
      const tile = lonLatToTile(lon, lat, z);
      const exists = await hasPmtilesTile(tile);
      if (exists === true) return true;
      if (exists == null) return null;
    }
    return false;
  }

  async function evaluatePmtilesCoverage() {
    if (!map || !map.isStyleLoaded() || !pmtilesArchive) return;
    const token = ++coverageEvalToken;
    const rawZoom = Math.floor(map.getZoom());
    const zoom = Number.isInteger(pmtilesMaxZoom)
      ? Math.min(rawZoom, pmtilesMaxZoom)
      : rawZoom;
    const points = getViewportSamplePoints();
    if (points.length === 0) return;
    let hasUnknownCoverage = false;

    for (const [lon, lat] of points) {
      const exists = await hasPmtilesCoverageAtPoint(lon, lat, zoom);
      if (token !== coverageEvalToken) return;
      if (exists == null) {
        hasUnknownCoverage = true;
        continue;
      }
      if (!exists) {
        queueCartoBuildingsVisibility('visible');
        return;
      }
    }
    if (hasUnknownCoverage) return;
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
    const buildingPaint = getBuildingThemePaint(getCurrentTheme());

    const pmtilesUrl = config.buildingsPmtiles.url.startsWith('http')
      ? config.buildingsPmtiles.url
      : `${window.location.origin}${config.buildingsPmtiles.url.startsWith('/') ? '' : '/'}${config.buildingsPmtiles.url}`;

    if (!map.getSource(BUILDINGS_SOURCE_ID)) {
      map.addSource(BUILDINGS_SOURCE_ID, {
        type: 'vector',
        url: `pmtiles://${pmtilesUrl}`
      });
    }

    if (!map.getSource(SEARCH_RESULTS_SOURCE_ID)) {
      map.addSource(SEARCH_RESULTS_SOURCE_ID, {
        type: 'geojson',
        data: buildSearchMarkersGeojson($searchMapState.items),
        cluster: true,
        clusterRadius: 48,
        clusterMaxZoom: 16
      });
    }

    if (!map.getLayer(BUILDINGS_FILL_LAYER_ID)) {
      map.addLayer({
        id: BUILDINGS_FILL_LAYER_ID,
        type: 'fill',
        source: BUILDINGS_SOURCE_ID,
        'source-layer': config.buildingsPmtiles.sourceLayer,
        minzoom: 13,
        paint: {
          'fill-color': buildingPaint.fillColor,
          'fill-opacity': buildingPaint.fillOpacity
        }
      });
    }

    if (!map.getLayer(BUILDINGS_LINE_LAYER_ID)) {
      map.addLayer({
        id: BUILDINGS_LINE_LAYER_ID,
        type: 'line',
        source: BUILDINGS_SOURCE_ID,
        'source-layer': config.buildingsPmtiles.sourceLayer,
        minzoom: 13,
        paint: {
          'line-color': buildingPaint.lineColor,
          'line-width': buildingPaint.lineWidth
        }
      });
    }

    if (!map.getLayer(FILTER_HIGHLIGHT_FILL_LAYER_ID)) {
      map.addLayer({
        id: FILTER_HIGHLIGHT_FILL_LAYER_ID,
        type: 'fill',
        source: BUILDINGS_SOURCE_ID,
        'source-layer': config.buildingsPmtiles.sourceLayer,
        minzoom: 13,
        paint: {
          'fill-color': '#f59e0b',
          'fill-opacity': [
            'case',
            ['boolean', ['feature-state', 'isFiltered'], false],
            0.36,
            0
          ]
        }
      });
    }

    if (!map.getLayer(FILTER_HIGHLIGHT_LINE_LAYER_ID)) {
      map.addLayer({
        id: FILTER_HIGHLIGHT_LINE_LAYER_ID,
        type: 'line',
        source: BUILDINGS_SOURCE_ID,
        'source-layer': config.buildingsPmtiles.sourceLayer,
        minzoom: 13,
        paint: {
          'line-color': '#b45309',
          'line-width': [
            'case',
            ['boolean', ['feature-state', 'isFiltered'], false],
            1.8,
            0
          ],
          'line-opacity': [
            'case',
            ['boolean', ['feature-state', 'isFiltered'], false],
            0.95,
            0
          ]
        }
      });
    }

    if (!map.getLayer(SELECTED_FILL_LAYER_ID)) {
      map.addLayer({
        id: SELECTED_FILL_LAYER_ID,
        type: 'fill',
        source: BUILDINGS_SOURCE_ID,
        'source-layer': config.buildingsPmtiles.sourceLayer,
        minzoom: 13,
        filter: ['==', ['id'], -1],
        paint: {
          'fill-color': '#12b4a6',
          'fill-opacity': 0.72
        }
      });
    }

    if (!map.getLayer(SELECTED_LINE_LAYER_ID)) {
      map.addLayer({
        id: SELECTED_LINE_LAYER_ID,
        type: 'line',
        source: BUILDINGS_SOURCE_ID,
        'source-layer': config.buildingsPmtiles.sourceLayer,
        minzoom: 13,
        filter: ['==', ['id'], -1],
        paint: {
          'line-color': '#0b6d67',
          'line-width': 2.2
        }
      });
    }

    if (!map.getLayer(SEARCH_RESULTS_CLUSTER_LAYER_ID)) {
      map.addLayer({
        id: SEARCH_RESULTS_CLUSTER_LAYER_ID,
        type: 'circle',
        source: SEARCH_RESULTS_SOURCE_ID,
        filter: ['has', 'point_count'],
        paint: {
          'circle-radius': ['step', ['get', 'point_count'], 16, 12, 19, 30, 22, 60, 26],
          'circle-color': '#1d4ed8',
          'circle-stroke-color': '#ffffff',
          'circle-stroke-width': 2,
          'circle-opacity': 0.92
        }
      });
    }

    if (!map.getLayer(SEARCH_RESULTS_CLUSTER_COUNT_LAYER_ID)) {
      map.addLayer({
        id: SEARCH_RESULTS_CLUSTER_COUNT_LAYER_ID,
        type: 'symbol',
        source: SEARCH_RESULTS_SOURCE_ID,
        filter: ['has', 'point_count'],
        layout: {
          'text-field': ['to-string', ['get', 'point_count']],
          'text-font': ['Open Sans Bold'],
          'text-size': 12
        },
        paint: {
          'text-color': '#ffffff'
        }
      });
    }

    if (!map.getLayer(SEARCH_RESULTS_LAYER_ID)) {
      map.addLayer({
        id: SEARCH_RESULTS_LAYER_ID,
        type: 'circle',
        source: SEARCH_RESULTS_SOURCE_ID,
        filter: ['!', ['has', 'point_count']],
        paint: {
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 12, 4, 14, 6, 16, 7],
          'circle-color': '#2563eb',
          'circle-stroke-color': '#ffffff',
          'circle-stroke-width': 2,
          'circle-opacity': 0.9
        }
      });
    }

    bindStyleInteractionHandlers();
    applySelectionFromStore($selectedBuilding);
    updateSearchMarkers($searchMapState.items);
    applyBuildingThemePaint(getCurrentTheme());
    applyLabelLayerVisibility($mapLabelsVisible);
    scheduleCoverageCheck();
    updateFilterDebugHook({
      active: Array.isArray($buildingFilterRules) && $buildingFilterRules.length > 0,
      expr: ['literal', currentFilterRulesHash],
      mode: FILTER_HIGHLIGHT_MODE
    });
    reapplyFilteredFeatureState();
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
    const features = map.queryRenderedFeatures({ layers: [BUILDINGS_FILL_LAYER_ID, BUILDINGS_LINE_LAYER_ID] });
    const keys = new Set();
    for (const feature of Array.isArray(features) ? features : []) {
      const identity = getFeatureIdentity(feature);
      if (!identity?.osmType || !Number.isInteger(identity?.osmId)) continue;
      keys.add(`${identity.osmType}/${identity.osmId}`);
    }
    return [...keys];
  }

  function getLoadedSourceBuildingOsmKeys() {
    if (!map || !runtimeConfig?.buildingsPmtiles?.sourceLayer) return [];
    const features = map.querySourceFeatures(BUILDINGS_SOURCE_ID, {
      sourceLayer: runtimeConfig.buildingsPmtiles.sourceLayer
    });
    const keys = new Set();
    for (const feature of Array.isArray(features) ? features : []) {
      const identity = getFeatureIdentity(feature);
      if (!identity?.osmType || !Number.isInteger(identity?.osmId)) continue;
      keys.add(`${identity.osmType}/${identity.osmId}`);
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
    const nextZoom = Number.isFinite(Number($mapFocusRequest.zoom))
      ? Number($mapFocusRequest.zoom)
      : map.getZoom();
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
      const { maplibregl: maplibreModule, PMTiles: PMTilesCtor, Protocol: ProtocolCtor } = await loadMapRuntime();
      if (!mountAlive) return;
      maplibregl = maplibreModule;

      const config = getRuntimeConfig();
      runtimeConfig = config;
      protocol = new ProtocolCtor();
      maplibregl.addProtocol('pmtiles', protocol.tile);
      currentMapStyleUrl = getMapStyleForTheme(getCurrentTheme());
      coverageCache = new Map();
      coverageVisibleState = 'visible';

      const pmtilesUrl = resolvePmtilesUrl(config.buildingsPmtiles.url, window.location.origin);
      pmtilesArchive = new PMTilesCtor(pmtilesUrl);
      pmtilesArchive.getHeader()
        .then((header) => {
          const headerMinZoom = Number(header?.minZoom);
          const headerMaxZoom = Number(header?.maxZoom);
          pmtilesMinZoom = Number.isInteger(headerMinZoom) ? headerMinZoom : null;
          pmtilesMaxZoom = Number.isInteger(headerMaxZoom) ? headerMaxZoom : null;
          scheduleCoverageCheck();
        })
        .catch(() => {
          pmtilesMinZoom = null;
          pmtilesMaxZoom = null;
        });

      map = new maplibregl.Map({
        container,
        style: currentMapStyleUrl,
        center: [config.mapDefault.lon, config.mapDefault.lat],
        zoom: config.mapDefault.zoom,
        attributionControl: true
      });
      map.addControl(new maplibregl.NavigationControl(), 'top-right');
      map.on('moveend', () => {
        registerFilterMoveEnd();
        syncMapCameraStores();
      });
      map.on('moveend', scheduleFilterRefresh);
      map.on('moveend', scheduleCoverageCheck);
      map.on('move', scheduleCoverageCheck);
      map.on('zoomend', scheduleFilterRefresh);
      map.on('zoomend', () => setMapZoom(map.getZoom()));
      map.on('zoomend', scheduleCoverageCheck);
      map.on('resize', scheduleCoverageCheck);

      map.on('style.load', () => {
        ensureMapSourcesAndLayers(config);
        scheduleFilterRefresh();
        scheduleCoverageCheck();
      });

      map.on('load', () => {
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
    pmtilesArchive = null;
    pmtilesMinZoom = null;
    pmtilesMaxZoom = null;
    coverageCache = new Map();
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
    if (filterWorker) {
      filterWorker.terminate();
      filterWorker = null;
    }
    filterWorkerPending = new Map();
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
{#if filterStatusOverlayText}
  <div class="map-filter-status" data-filter-status-code={filterStatusCode} role="status" aria-live="polite">{filterStatusOverlayText}</div>
{/if}
{#if filterErrorMessage}
  <div class="map-filter-error" role="status" aria-live="polite">{filterErrorMessage}</div>
{/if}
{#if styleTransitionOverlaySrc}
  <img
    class:visible={styleTransitionOverlayVisible}
    class="map-style-transition-overlay"
    src={styleTransitionOverlaySrc}
    alt=""
    aria-hidden="true"
  />
{/if}

<style>
  .map-canvas {
    position: fixed;
    inset: 0;
  }

  .map-style-transition-overlay {
    position: fixed;
    inset: 0;
    z-index: 9;
    width: 100%;
    height: 100%;
    object-fit: cover;
    pointer-events: none;
    opacity: 0;
    transition: opacity 260ms ease;
  }

  .map-style-transition-overlay.visible {
    opacity: 1;
  }

  .map-filter-error {
    position: fixed;
    left: 0.75rem;
    bottom: 3.9rem;
    z-index: 10;
    padding: 8px 10px;
    border-radius: 10px;
    background: rgba(185, 28, 28, 0.9);
    color: #ffffff;
    font-size: 12px;
    line-height: 1.3;
    max-width: min(78vw, 440px);
    pointer-events: none;
  }

</style>
