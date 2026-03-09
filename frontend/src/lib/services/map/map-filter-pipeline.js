import { writable } from 'svelte/store';
import { EMPTY_LAYER_FILTER, hashFilterExpression } from '$lib/components/map/filter-highlight-utils';
import { createFilterCache } from './filter-cache';
import {
  buildBboxHash,
  buildBboxSnapshot,
  buildPrefetchCoverageWindow as buildPrefetchCoverageWindowSnapshot,
  getCoverageWindowForViewport as getCoverageWindowForViewportSnapshot,
  isViewportInsideBbox
} from './filter-bbox';
import { createFilterFeatureStateManager } from './filter-feature-state';
import { createFilterFetcher } from './filter-fetcher';
import { normalizeLayerIdsSnapshot } from './filter-utils';
import { MapFilterService } from './map-filter.service';

export const FILTER_HIGHLIGHT_MODE = 'feature-state';
export const FILTER_TELEMETRY_ENABLED = Boolean(import.meta.env.DEV || import.meta.env.MODE === 'test');

const FILTER_REQUEST_DEBOUNCE_MS = 180;
const FILTER_HEAVY_RULE_DEBOUNCE_MS = 500;
const FILTER_RULE_CHANGE_DEBOUNCE_MS = 90;
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

function createInitialState(mapDebug) {
  const debugState = mapDebug?.getState?.() || {
    active: false,
    exprHash: hashFilterExpression(EMPTY_LAYER_FILTER)
  };
  return {
    errorMessage: '',
    statusMessage: '',
    statusCode: 'idle',
    phase: 'idle',
    lastElapsedMs: 0,
    lastCount: 0,
    lastCacheHit: false,
    setFeatureStateCallsLast: 0,
    lastApplyDiffMs: 0,
    debugActive: Boolean(debugState.active),
    debugExprHash: String(debugState.exprHash || hashFilterExpression(EMPTY_LAYER_FILTER))
  };
}

export function createFilterPipeline({
  map,
  mapDebug,
  getLayerIds,
  getBuildingSourceConfigs,
  onStatusChange,
  translateInvalidMessage
} = {}) {
  const resolveMap = typeof map === 'function' ? map : () => map;
  const resolveLayerIds = typeof getLayerIds === 'function'
    ? () => normalizeLayerIdsSnapshot(getLayerIds())
    : () => normalizeLayerIdsSnapshot();
  const resolveBuildingSourceConfigs = typeof getBuildingSourceConfigs === 'function'
    ? () => {
      const configs = getBuildingSourceConfigs();
      return Array.isArray(configs) ? configs : [];
    }
    : () => [];
  const handleStatusChange = typeof onStatusChange === 'function' ? onStatusChange : () => {};
  const resolveInvalidMessage = typeof translateInvalidMessage === 'function'
    ? translateInvalidMessage
    : () => 'Invalid filter rules';

  let currentState = createInitialState(mapDebug);
  const state = writable(currentState);
  let mapMoveDebounceTimer = null;
  let activeFilterAbortController = null;
  let prefetchFilterAbortController = null;
  const filterCache = createFilterCache({
    ttlMs: FILTER_MATCH_CACHE_TTL_MS,
    maxItems: FILTER_MATCH_CACHE_MAX_ITEMS
  });
  let filterWorkerService = null;
  let latestFilterToken = 0;
  let filterRulesDebounceTimer = null;
  let filterAuthoritativeTimer = null;
  let filterPrefetchTimer = null;
  let currentFilterRulesHash = 'fnv1a-0';
  let lastViewportHash = '';
  let lastAuthoritativeRequestKey = '';
  let activeFilterCoverageWindow = null;
  let activeFilterCoverageKey = '';
  let filterLastPrefetchAt = 0;
  let filterLastMoveEndAt = 0;
  let filterLastMapCenter = null;
  let filterLastMoveVector = { dx: 0, dy: 0 };
  let filterDenseBurstEnabled = resolveFilterDenseBurstEnabled();

  function patchState(patch = {}) {
    currentState = {
      ...currentState,
      ...patch
    };
    state.set(currentState);
    return currentState;
  }

  function debugFilterLog(eventName, payload = {}) {
    mapDebug?.log?.(eventName, payload);
  }

  function updateFilterDebugHook({
    active = false,
    expr = EMPTY_LAYER_FILTER,
    mode = FILTER_HIGHLIGHT_MODE,
    phase = currentState.phase,
    lastElapsedMs = currentState.lastElapsedMs,
    lastCount = currentState.lastCount,
    cacheHit = currentState.lastCacheHit,
    setFeatureStateCalls = currentState.setFeatureStateCallsLast
  } = {}) {
    const nextDebugState = mapDebug?.updateHook?.({
      active,
      expr,
      mode,
      phase,
      lastElapsedMs,
      lastCount,
      cacheHit,
      setFeatureStateCalls
    }) || {
      active: Boolean(active),
      exprHash: hashFilterExpression(expr)
    };
    patchState({
      debugActive: Boolean(nextDebugState.active),
      debugExprHash: String(nextDebugState.exprHash || hashFilterExpression(expr))
    });
  }

  function updateFilterRuntimeStatus(status = {}) {
    const nextPhase = status.phase != null
      ? String(status.phase)
      : String(currentState.phase || 'idle');
    const nextStatusCode = status.statusCode != null
      ? String(status.statusCode)
      : String(currentState.statusCode || 'idle');
    const nextMessage = status.message != null
      ? String(status.message)
      : String(currentState.statusMessage || '');
    const nextState = patchState({
      phase: nextPhase,
      statusCode: nextStatusCode,
      statusMessage: nextMessage,
      lastCount: Number(status.count ?? currentState.lastCount ?? 0) || 0,
      lastElapsedMs: Number(status.elapsedMs ?? currentState.lastElapsedMs ?? 0) || 0,
      lastCacheHit: Boolean(status.cacheHit ?? currentState.lastCacheHit),
      setFeatureStateCallsLast: Number(status.setFeatureStateCalls ?? currentState.setFeatureStateCallsLast ?? 0) || 0
    });
    handleStatusChange({
      phase: nextState.phase,
      statusCode: nextState.statusCode,
      message: nextState.statusMessage,
      count: nextState.lastCount,
      elapsedMs: nextState.lastElapsedMs,
      cacheHit: nextState.lastCacheHit,
      setFeatureStateCalls: nextState.setFeatureStateCallsLast,
      updatedAt: Date.now()
    });
  }

  function setFilterPhase(phase) {
    updateFilterRuntimeStatus({
      phase,
      statusCode: phase === 'idle' ? 'idle' : undefined
    });
    updateFilterDebugHook({
      active: filterFeatureStateManager.getFilteredFeatureStateIdsSize() > 0,
      expr: ['literal', currentFilterRulesHash],
      mode: FILTER_HIGHLIGHT_MODE,
      phase,
      lastElapsedMs: currentState.lastElapsedMs,
      lastCount: currentState.lastCount,
      cacheHit: currentState.lastCacheHit
    });
  }

  function requestFilterWorker(type, payload = {}) {
    if (!filterWorkerService) {
      filterWorkerService = new MapFilterService();
    }
    return filterWorkerService.request(type, payload);
  }

  function recordFilterRequestDebugEvent(eventName) {
    mapDebug?.recordFilterRequestEvent?.(eventName);
  }

  function recordFilterTelemetry(eventName, payload = {}) {
    mapDebug?.recordFilterTelemetry?.(eventName, payload);
  }

  const filterFeatureStateManager = createFilterFeatureStateManager({
    resolveMap,
    resolveBuildingSourceConfigs,
    requestFilterWorker,
    getLatestFilterToken: () => latestFilterToken,
    getFilterDenseBurstEnabled: () => filterDenseBurstEnabled,
    getFilterMoveEndDelayMs: () => (
      filterLastMoveEndAt > 0
        ? Math.max(0, Date.now() - filterLastMoveEndAt)
        : null
    ),
    patchState,
    debugFilterLog,
    recordFilterTelemetry,
    updateFilterRuntimeStatus,
    updateFilterDebugHook,
    getCurrentPhase: () => currentState.phase,
    highlightMode: FILTER_HIGHLIGHT_MODE,
    featureStateChunkSize: FILTER_FEATURE_STATE_CHUNK_SIZE,
    denseDiffThreshold: FILTER_DENSE_DIFF_THRESHOLD,
    applyFrameBudgetMs: FILTER_APPLY_FRAME_BUDGET_MS,
    applyDenseFrameBudgetMs: FILTER_APPLY_DENSE_FRAME_BUDGET_MS,
    applyDenseMaxOpsPerFrame: FILTER_APPLY_DENSE_MAX_OPS_PER_FRAME
  });
  const filterFetcher = createFilterFetcher({
    resolveMap,
    resolveLayerIds,
    resolveBuildingSourceConfigs,
    getCurrentRulesHash: () => currentFilterRulesHash,
    getLastViewportHash: () => lastViewportHash,
    matchDefaultLimit: FILTER_MATCH_DEFAULT_LIMIT,
    dataCacheTtlMs: FILTER_DATA_CACHE_TTL_MS,
    dataCacheMaxItems: FILTER_DATA_CACHE_MAX_ITEMS,
    dataRequestChunkSize: FILTER_DATA_REQUEST_CHUNK_SIZE
  });

  function resolveFilterDenseBurstEnabled() {
    if (typeof window === 'undefined') return true;
    try {
      const raw = String(new URL(window.location.href).searchParams.get('filterDenseBurst') || '').trim().toLowerCase();
      if (raw === '0' || raw === 'false' || raw === 'off') return false;
    } catch {
      // Ignore malformed URL state and keep the default behavior enabled.
    }
    return true;
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
    return getCoverageWindowForViewportSnapshot(viewportBbox, {
      lastCount: currentState.lastCount,
      defaultLimit: FILTER_MATCH_DEFAULT_LIMIT,
      minMargin: FILTER_COVERAGE_MARGIN_MIN,
      maxMargin: FILTER_COVERAGE_MARGIN_MAX
    });
  }

  function getCurrentFilterBbox() {
    const currentMap = resolveMap();
    if (!currentMap) return null;
    return buildBboxSnapshot(currentMap.getBounds?.());
  }

  function canReuseActiveCoverageWindow({ viewportBbox, rulesHash, zoomBucket, reason }) {
    if (reason !== 'viewport') return false;
    if (!activeFilterCoverageWindow) return false;
    if (String(activeFilterCoverageWindow.rulesHash || '') !== String(rulesHash || '')) return false;
    if (Number(activeFilterCoverageWindow.zoomBucket || 0) !== Number(zoomBucket || 0)) return false;
    return isViewportInsideBbox(viewportBbox, activeFilterCoverageWindow);
  }

  function buildPrefetchCoverageWindow(coverageWindow) {
    return buildPrefetchCoverageWindowSnapshot(coverageWindow, filterLastMoveVector);
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
      const activeRules = Array.isArray(rules) ? rules.filter((rule) => rule?.key) : [];
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

  function scheduleFilterPrefetch(context, token) {
    if (!FILTER_PREFETCH_ENABLED || !context?.coverageWindow || !context?.rulesHash || !context?.rules?.length) return;
    const now = Date.now();
    if ((now - filterLastPrefetchAt) < FILTER_PREFETCH_MIN_INTERVAL_MS) return;
    const prefetchBbox = buildPrefetchCoverageWindow(context.coverageWindow);
    if (!prefetchBbox) return;
    const prefetchHash = buildBboxHash(prefetchBbox, 4);
    const prefetchCacheKey = `${context.rulesHash}:${prefetchHash}:${context.zoomBucket}`;
    if (filterCache.getCachedFilterMatches(prefetchCacheKey)) return;

    cancelPrefetchRequest();
    filterPrefetchTimer = setTimeout(async () => {
      filterPrefetchTimer = null;
      if (token !== latestFilterToken || !resolveMap()) return;

      prefetchFilterAbortController = new AbortController();
      const signal = prefetchFilterAbortController.signal;
      filterLastPrefetchAt = Date.now();
      recordFilterRequestDebugEvent('prefetch-start');
      recordFilterTelemetry('prefetch_start', {
        prefetchHash
      });

      try {
        const payload = await filterFetcher.fetchFilterMatchesPrimary({
          bbox: prefetchBbox,
          zoomBucket: context.zoomBucket,
          rules: context.rules,
          rulesHash: context.rulesHash,
          signal
        });
        if (token !== latestFilterToken) return;
        filterCache.putCachedFilterMatches(prefetchCacheKey, payload);
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
      if (token !== latestFilterToken || !resolveMap()) return;
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
        payload = await filterFetcher.fetchFilterMatchesPrimary({
          bbox: context.coverageWindow,
          zoomBucket: context.zoomBucket,
          rules: context.rules,
          rulesHash: context.rulesHash,
          signal
        });
      } catch (error) {
        if (String(error?.name || '').toLowerCase() === 'aborterror') return;
        usedFallback = true;
        payload = await filterFetcher.fetchFilterMatchesFallback({
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

      await filterFeatureStateManager.applyFilteredFeatureStateMatches(payload, token, { phase: 'authoritative' });
      if (token !== latestFilterToken) return;
      filterCache.putCachedFilterMatches(context.cacheKey, payload);
      activeFilterCoverageWindow = {
        ...context.coverageWindow,
        rulesHash: context.rulesHash,
        zoomBucket: context.zoomBucket
      };
      activeFilterCoverageKey = context.coverageHash;

      patchState({
        errorMessage: '',
        lastElapsedMs: Number(payload?.meta?.elapsedMs || 0),
        lastCacheHit: Boolean(payload?.meta?.cacheHit),
        lastCount: matchedSize
      });
      setFilterPhase('authoritative');
      debugFilterLog('filter request finish', {
        requestKey,
        count: matchedSize,
        elapsedMs: currentState.lastElapsedMs,
        cacheHit: currentState.lastCacheHit,
        truncated: Boolean(payload?.meta?.truncated),
        fallback: usedFallback
      });
      recordFilterRequestDebugEvent('finish');
      recordFilterTelemetry('request_finish', {
        requestKey,
        count: matchedSize,
        elapsedMs: currentState.lastElapsedMs,
        applyDelayFromMoveEndMs: filterLastMoveEndAt > 0 ? Math.max(0, Date.now() - filterLastMoveEndAt) : null,
        setFeatureStateCalls: currentState.setFeatureStateCallsLast,
        toEnable: filterFeatureStateManager.getFilteredFeatureStateIdsSize()
      });
      updateFilterRuntimeStatus({
        statusCode: payload?.meta?.truncated ? 'truncated' : 'applied',
        count: currentState.lastCount,
        elapsedMs: currentState.lastElapsedMs,
        cacheHit: currentState.lastCacheHit,
        setFeatureStateCalls: currentState.setFeatureStateCallsLast
      });
      updateFilterDebugHook({
        active: matchedSize > 0,
        expr: ['literal', context.rulesHash],
        mode: FILTER_HIGHLIGHT_MODE,
        phase: currentState.phase,
        lastElapsedMs: currentState.lastElapsedMs,
        lastCount: currentState.lastCount,
        cacheHit: currentState.lastCacheHit
      });
      scheduleFilterPrefetch(context, token);
    }, Math.max(0, Number(debounceMs) || 0));
  }

  function clearFilterHighlight() {
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
    filterFeatureStateManager.clearFilteredFeatureState();
    patchState({
      statusMessage: '',
      lastElapsedMs: 0,
      lastCacheHit: false
    });
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
    if (!resolveMap()) return;
    const token = ++latestFilterToken;
    const prepared = await prepareRulesForFiltering(rules);
    if (token !== latestFilterToken) return;

    if (!prepared.ok) {
      patchState({
        errorMessage: prepared.error || resolveInvalidMessage(),
        statusMessage: ''
      });
      filterFeatureStateManager.clearFilteredFeatureState();
      setFilterPhase('idle');
      updateFilterRuntimeStatus({
        statusCode: 'invalid',
        message: currentState.errorMessage,
        count: 0
      });
      return;
    }
    const activeRules = prepared.rules;
    debugFilterLog('filter rules changed', { reason, rules: activeRules });
    currentFilterRulesHash = prepared.rulesHash;
    if (activeRules.length === 0) {
      patchState({
        errorMessage: ''
      });
      clearFilterHighlight();
      return;
    }

    const bbox = getCurrentFilterBbox();
    if (!bbox) {
      patchState({
        statusMessage: ''
      });
      updateFilterRuntimeStatus({
        statusCode: 'idle',
        message: ''
      });
      return;
    }
    const currentMap = resolveMap();
    const bboxHash = buildBboxHash(bbox, 4);
    const zoomBucket = Math.round(currentMap.getZoom() * 2) / 2;
    const coverageWindow = getCoverageWindowForViewport(bbox) || bbox;
    const coverageHash = buildBboxHash(coverageWindow, 4);
    const cacheKey = `${prepared.rulesHash}:${coverageHash}:${zoomBucket}`;
    lastViewportHash = bboxHash;

    patchState({
      errorMessage: '',
      lastCacheHit: false
    });
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
        message: currentState.statusMessage
      });
      return;
    }

    const cached = filterCache.getCachedFilterMatches(cacheKey);
    if (cached) {
      await filterFeatureStateManager.applyFilteredFeatureStateMatches(cached, token, { phase: 'optimistic' });
      if (token !== latestFilterToken) return;
      patchState({
        lastElapsedMs: Number(cached?.meta?.elapsedMs || 0),
        lastCacheHit: Boolean(cached?.meta?.cacheHit),
        lastCount: Math.max(
          Array.isArray(cached?.matchedFeatureIds) ? cached.matchedFeatureIds.length : 0,
          Array.isArray(cached?.matchedKeys) ? cached.matchedKeys.length : 0
        )
      });
      activeFilterCoverageWindow = {
        ...coverageWindow,
        rulesHash: prepared.rulesHash,
        zoomBucket
      };
      activeFilterCoverageKey = coverageHash;
      updateFilterRuntimeStatus({
        statusCode: 'applied',
        count: currentState.lastCount,
        elapsedMs: currentState.lastElapsedMs,
        cacheHit: currentState.lastCacheHit,
        setFeatureStateCalls: currentState.setFeatureStateCallsLast
      });
      updateFilterDebugHook({
        active: currentState.lastCount > 0,
        expr: ['literal', prepared.rulesHash],
        mode: FILTER_HIGHLIGHT_MODE,
        phase: currentState.phase,
        lastElapsedMs: currentState.lastElapsedMs,
        lastCount: currentState.lastCount,
        cacheHit: currentState.lastCacheHit
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

  function scheduleFilterRefresh(rules) {
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
      applyBuildingFilters(rules, { reason: 'viewport' });
    }, FILTER_REQUEST_DEBOUNCE_MS);
  }

  function registerFilterMoveEnd() {
    const currentMap = resolveMap();
    if (!currentMap) return;
    const center = currentMap.getCenter();
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
      zoom: Number(currentMap.getZoom() || 0)
    });
  }

  function scheduleFilterRulesRefresh(rules) {
    if (filterRulesDebounceTimer) {
      clearTimeout(filterRulesDebounceTimer);
      filterRulesDebounceTimer = null;
    }
    applyBuildingFilters(rules, { reason: 'rules' });
  }

  function refreshDebugState(active) {
    updateFilterDebugHook({
      active,
      expr: ['literal', currentFilterRulesHash],
      mode: FILTER_HIGHLIGHT_MODE
    });
  }

  function destroy() {
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
    cancelPrefetchRequest();
    if (activeFilterAbortController) {
      activeFilterAbortController.abort();
      activeFilterAbortController = null;
    }
    filterFeatureStateManager.clearFilteredFeatureState();
    filterCache.clear();
    filterFetcher.clear();
    activeFilterCoverageWindow = null;
    activeFilterCoverageKey = '';
    lastAuthoritativeRequestKey = '';
    currentFilterRulesHash = 'fnv1a-0';
    lastViewportHash = '';
    filterLastPrefetchAt = 0;
    filterLastMoveEndAt = 0;
    filterLastMapCenter = null;
    filterLastMoveVector = { dx: 0, dy: 0 };
    latestFilterToken += 1;
    handleStatusChange({
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
    patchState({
      errorMessage: '',
      statusMessage: '',
      statusCode: 'idle',
      phase: 'idle',
      lastElapsedMs: 0,
      lastCount: 0,
      lastCacheHit: false,
      setFeatureStateCallsLast: 0,
      lastApplyDiffMs: 0
    });
    updateFilterDebugHook({
      active: false,
      expr: EMPTY_LAYER_FILTER
    });
  }

  return {
    state,
    applyBuildingFilters,
    clearFilterHighlight,
    clearFilteredFeatureState: () => filterFeatureStateManager.clearFilteredFeatureState(),
    destroy,
    getCoverageWindowForViewport,
    refreshDebugState,
    registerFilterMoveEnd,
    reapplyFilteredFeatureState: () => filterFeatureStateManager.reapplyFilteredFeatureState(),
    scheduleFilterRefresh,
    scheduleFilterRulesRefresh
  };
}
