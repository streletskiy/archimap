import { writable } from 'svelte/store';
import { computeRulesHash } from '$lib/components/map/filter-pipeline-utils';
import { createFilterCache } from './filter-cache';
import {
  buildBboxHash,
  buildBboxSnapshot,
  buildPrefetchCoverageWindow as buildPrefetchCoverageWindowSnapshot,
  getCoverageWindowForViewport as getCoverageWindowForViewportSnapshot,
  isViewportInsideBbox
} from './filter-bbox';
import { createFilterFetcher } from './filter-fetcher';
import { createFilterMatchCacheStrategy } from './filter-match-cache-strategy';
import {
  buildFilterRequestSpecs,
  buildResolvedLayerPayload,
  EMPTY_LAYER_FILTER,
  hashFilterExpression,
  isLayerInput,
  normalizeFilterInputLayers,
  buildFilterRequestCacheKey
} from './filter-request-planner';
import { createFilterDiffApplyStrategy } from './filter-diff-apply-strategy';
import { normalizeLayerIdsSnapshot } from './filter-utils';
import { createFilterWorkerDispatcher } from './filter-worker-dispatcher';

export const FILTER_HIGHLIGHT_MODE = 'paint-property';
export const FILTER_TELEMETRY_ENABLED = Boolean(import.meta.env.DEV || import.meta.env.MODE === 'test');

const FILTER_REQUEST_DEBOUNCE_MS = 180;
const FILTER_HEAVY_RULE_DEBOUNCE_MS = 500;
const FILTER_RULE_CHANGE_DEBOUNCE_MS = 90;
const FILTER_MATCH_CACHE_TTL_MS = 8_000;
const FILTER_MATCH_CACHE_MAX_ITEMS = 90;
const FILTER_MATCH_DEGRADE_LIMIT = FILTER_HIGHLIGHT_MODE === 'paint-property' ? 30_000 : 20_000;
const FILTER_MATCH_DEFAULT_LIMIT = 12_000;
const FILTER_DATA_CACHE_TTL_MS = 45_000;
const FILTER_DATA_CACHE_MAX_ITEMS = 25_000;
const FILTER_DATA_REQUEST_CHUNK_SIZE = 5_000;
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
    setPaintPropertyCallsLast: 0,
    lastPaintApplyMs: 0,
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
}: LooseRecord = {}) {
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
  const filterCache = createFilterCache({
    ttlMs: FILTER_MATCH_CACHE_TTL_MS,
    maxItems: FILTER_MATCH_CACHE_MAX_ITEMS
  });
  let latestFilterToken = 0;
  let filterAuthoritativeTimer = null;
  let currentFilterRulesHash = 'fnv1a-0';
  let lastViewportHash = '';
  let lastAuthoritativeRequestKey = '';
  let activeFilterCoverageWindow = null;
  let activeFilterCoverageKey = '';
  let filterLastMoveEndAt = 0;
  let filterLastMapCenter = null;
  let filterLastMoveVector = { dx: 0, dy: 0 };

  function patchState(patch: LooseRecord = {}) {
    currentState = {
      ...currentState,
      ...patch
    };
    state.set(currentState);
    return currentState;
  }

  function debugFilterLog(eventName, payload: LooseRecord = {}) {
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
    setPaintPropertyCalls = currentState.setPaintPropertyCallsLast
  }: LooseRecord = {}) {
    const nextDebugState = mapDebug?.updateHook?.({
      active,
      expr,
      mode,
      phase,
      lastElapsedMs,
      lastCount,
      cacheHit,
      setPaintPropertyCalls
    }) || {
      active: Boolean(active),
      exprHash: hashFilterExpression(expr)
    };
    patchState({
      debugActive: Boolean(nextDebugState.active),
      debugExprHash: String(nextDebugState.exprHash || hashFilterExpression(expr))
    });
  }

  function updateFilterRuntimeStatus(status: LooseRecord = {}) {
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
      setPaintPropertyCallsLast: Number(status.setPaintPropertyCalls ?? currentState.setPaintPropertyCallsLast ?? 0) || 0
    });
    handleStatusChange({
      phase: nextState.phase,
      statusCode: nextState.statusCode,
      message: nextState.statusMessage,
      count: nextState.lastCount,
      elapsedMs: nextState.lastElapsedMs,
      cacheHit: nextState.lastCacheHit,
      setPaintPropertyCalls: nextState.setPaintPropertyCallsLast,
      updatedAt: Date.now()
    });
  }

  function setFilterPhase(phase) {
    updateFilterRuntimeStatus({
      phase,
      statusCode: phase === 'idle' ? 'idle' : undefined
    });
    updateFilterDebugHook({
      active: filterDiffApplyStrategy.getFilteredFeatureCount() > 0,
      expr: ['literal', currentFilterRulesHash],
      mode: FILTER_HIGHLIGHT_MODE,
      phase,
      lastElapsedMs: currentState.lastElapsedMs,
      lastCount: currentState.lastCount,
      cacheHit: currentState.lastCacheHit
    });
  }

  function recordFilterRequestDebugEvent(eventName) {
    mapDebug?.recordFilterRequestEvent?.(eventName);
  }

  function recordFilterTelemetry(eventName, payload: LooseRecord = {}) {
    mapDebug?.recordFilterTelemetry?.(eventName, payload);
  }

  // Keep the pipeline as an orchestrator; planning/cache/worker/apply steps live in dedicated strategies.
  const filterDiffApplyStrategy = createFilterDiffApplyStrategy({
    resolveMap,
    resolveLayerIds,
    getLatestFilterToken: () => latestFilterToken,
    patchState,
    debugFilterLog,
    recordFilterTelemetry,
    updateFilterRuntimeStatus,
    updateFilterDebugHook,
    getCurrentPhase: () => currentState.phase,
    highlightMode: FILTER_HIGHLIGHT_MODE
  });
  const filterWorkerDispatcher = createFilterWorkerDispatcher();
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
  const filterMatchCacheStrategy = createFilterMatchCacheStrategy({
    filterCache,
    filterFetcher,
    buildFilterRequestCacheKey,
    buildPrefetchCoverageWindow: (coverageWindow) => buildPrefetchCoverageWindowSnapshot(coverageWindow, filterLastMoveVector),
    resolveMap,
    getLatestFilterToken: () => latestFilterToken,
    recordFilterRequestDebugEvent,
    recordFilterTelemetry,
    prefetchEnabled: FILTER_PREFETCH_ENABLED,
    prefetchMinIntervalMs: FILTER_PREFETCH_MIN_INTERVAL_MS
  });

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

  function canReuseActiveCoverageWindow({ viewportBbox, rulesHash, zoomBucket, reason }: LooseRecord) {
    if (reason !== 'viewport') return false;
    if (!activeFilterCoverageWindow) return false;
    if (String(activeFilterCoverageWindow.rulesHash || '') !== String(rulesHash || '')) return false;
    if (Number(activeFilterCoverageWindow.zoomBucket || 0) !== Number(zoomBucket || 0)) return false;
    return isViewportInsideBbox(viewportBbox, activeFilterCoverageWindow);
  }

  async function prepareRulesForFiltering(input) {
    try {
      const requestPayload = isLayerInput(input)
        ? { layers: input }
        : { rules: input };
      const workerResult = await filterWorkerDispatcher.request('prepare-rules', requestPayload);
      if (workerResult?.ok) {
        const normalizedLayers = Array.isArray(workerResult.layers) && workerResult.layers.length > 0
          ? workerResult.layers
          : normalizeFilterInputLayers(input).layers;
        const preparedRequests = buildFilterRequestSpecs(normalizedLayers);
        return {
          ok: true,
          layers: preparedRequests.layers,
          requestSpecs: preparedRequests.requestSpecs,
          combinedGroup: preparedRequests.combinedGroup,
          rulesHash: String(workerResult.rulesHash || computeRulesHash(preparedRequests.layers)),
          heavy: Boolean(workerResult.heavy)
        };
      }
      return {
        ok: false,
        error: String(workerResult?.invalidReason || 'Invalid filter rules')
      };
    } catch {
      const normalizedLayers = normalizeFilterInputLayers(input);
      if (normalizedLayers.invalidReason) {
        return {
          ok: false,
          error: normalizedLayers.invalidReason
        };
      }
      const preparedRequests = buildFilterRequestSpecs(normalizedLayers.layers);
      return {
        ok: true,
        layers: preparedRequests.layers,
        requestSpecs: preparedRequests.requestSpecs,
        combinedGroup: preparedRequests.combinedGroup,
        rulesHash: computeRulesHash(preparedRequests.layers),
        heavy: preparedRequests.requestSpecs.some((spec) => spec.rules.some((rule) => rule.op === 'contains'))
      };
    }
  }

  function scheduleAuthoritativeRequest(context, token, debounceMs) {
    if (filterAuthoritativeTimer) {
      clearTimeout(filterAuthoritativeTimer);
      filterAuthoritativeTimer = null;
    }
    filterMatchCacheStrategy.cancelPrefetch();
    filterAuthoritativeTimer = setTimeout(async () => {
      filterAuthoritativeTimer = null;
      if (token !== latestFilterToken || !resolveMap()) return;
      const requestKey = `${context.rulesHash}:${context.coverageHash}:${context.zoomBucket}`;
      if (requestKey === lastAuthoritativeRequestKey && context.reason === 'viewport') {
        return;
      }
      lastAuthoritativeRequestKey = requestKey;
      filterMatchCacheStrategy.cancelPrefetch();
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
      let requestResults: LooseRecord[];
      try {
        const cachedResults = [];
        const missingSpecs = [];
        for (const spec of context.requestSpecs) {
          const cachedResult = filterMatchCacheStrategy.getCachedRequestSpecResult(spec, context);
          if (cachedResult) {
            cachedResults.push(cachedResult);
          } else {
            missingSpecs.push(spec);
          }
        }

        requestResults = [...cachedResults];
        if (missingSpecs.length > 0) {
          const fetchedResults = missingSpecs.length > 1
            ? await (() => filterMatchCacheStrategy.fetchMatchesBatchForRequestSpecs(missingSpecs, context, signal))()
                .catch(async (error) => {
                  if (String(error?.name || '').toLowerCase() === 'aborterror') throw error;
                  return Promise.all(missingSpecs.map(async (spec) => {
                    const result = await filterMatchCacheStrategy.fetchMatchesForRequestSpec(spec, context, signal);
                    return {
                      spec,
                      ...result
                    };
                  }));
                })
            : await Promise.all(missingSpecs.map(async (spec) => {
                const result = await filterMatchCacheStrategy.fetchMatchesForRequestSpec(spec, context, signal);
                return {
                  spec,
                  ...result
                };
              }));
          requestResults.push(...fetchedResults);
        }
      } catch (error) {
        if (String(error?.name || '').toLowerCase() === 'aborterror') return;
        return;
      } finally {
        if (activeFilterAbortController?.signal === signal) {
          activeFilterAbortController = null;
        }
      }
      if (token !== latestFilterToken) return;

      const payloadsByRequestId = new Map(requestResults.map((result) => [result.spec.id, result.payload]));
      const usedFallback = requestResults.some((result) => result.usedFallback);
      const resolvedPayload = buildResolvedLayerPayload({
        prepared: context,
        payloadsByRequestId,
        cacheHit: requestResults.length > 0 && requestResults.every((result) => result.cacheHit)
      });
      resolvedPayload.meta = {
        ...(resolvedPayload.meta || {}),
        bboxHash: context.bboxHash,
        coverageHash: context.coverageHash,
        coverageWindow: context.coverageWindow,
        rulesHash: context.rulesHash,
        zoomBucket: context.zoomBucket,
        truncated: Boolean(resolvedPayload.meta?.truncated),
        elapsedMs: Number(resolvedPayload.meta?.elapsedMs || 0),
        cacheHit: Boolean(resolvedPayload.meta?.cacheHit)
      };
      const matchedSize = Number(resolvedPayload?.matchedCount || 0);
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

      await filterDiffApplyStrategy.applyFilteredFeaturePaintGroups(
        resolvedPayload.highlightColorGroups || [],
        token,
        {
          phase: 'authoritative',
          matchedFeatureIds: Array.isArray(resolvedPayload?.matchedFeatureIds)
            ? resolvedPayload.matchedFeatureIds
            : []
        }
      );
      if (token !== latestFilterToken) return;
      filterCache.putCachedFilterMatches(context.cacheKey, resolvedPayload);
      activeFilterCoverageWindow = {
        ...context.coverageWindow,
        rulesHash: context.rulesHash,
        zoomBucket: context.zoomBucket
      };
      activeFilterCoverageKey = context.coverageHash;

      patchState({
        errorMessage: '',
        lastElapsedMs: Number(resolvedPayload?.meta?.elapsedMs || 0),
        lastCacheHit: Boolean(resolvedPayload?.meta?.cacheHit),
        lastCount: matchedSize
      });
      setFilterPhase('authoritative');
      debugFilterLog('filter request finish', {
        requestKey,
        count: matchedSize,
        elapsedMs: currentState.lastElapsedMs,
        cacheHit: currentState.lastCacheHit,
        truncated: Boolean(resolvedPayload?.meta?.truncated),
        fallback: usedFallback
      });
      recordFilterRequestDebugEvent('finish');
      recordFilterTelemetry('request_finish', {
        requestKey,
        count: matchedSize,
        elapsedMs: currentState.lastElapsedMs,
        applyDelayFromMoveEndMs: filterLastMoveEndAt > 0 ? Math.max(0, Date.now() - filterLastMoveEndAt) : null,
        setPaintPropertyCalls: currentState.setPaintPropertyCallsLast,
        highlightedCount: filterDiffApplyStrategy.getFilteredFeatureCount()
      });
      updateFilterRuntimeStatus({
        statusCode: resolvedPayload?.meta?.truncated ? 'truncated' : 'applied',
        count: currentState.lastCount,
        elapsedMs: currentState.lastElapsedMs,
        cacheHit: currentState.lastCacheHit,
        setPaintPropertyCalls: currentState.setPaintPropertyCallsLast
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
      filterMatchCacheStrategy.schedulePrefetch(context, token);
    }, Math.max(0, Number(debounceMs) || 0));
  }

  function clearFilterHighlight() {
    if (activeFilterAbortController) {
      activeFilterAbortController.abort();
      activeFilterAbortController = null;
    }
    filterMatchCacheStrategy.cancelPrefetch();
    if (filterAuthoritativeTimer) {
      clearTimeout(filterAuthoritativeTimer);
      filterAuthoritativeTimer = null;
    }
    filterDiffApplyStrategy.clearFilteredHighlight();
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
      setPaintPropertyCalls: 0
    });
  }

  async function applyBuildingFilters(input, { reason = 'rules' } = {}) {
    if (!resolveMap()) return;
    const token = ++latestFilterToken;
    const prepared = await prepareRulesForFiltering(input);
    if (token !== latestFilterToken) return;

    if (!prepared.ok) {
      patchState({
        errorMessage: prepared.error || resolveInvalidMessage(),
        statusMessage: ''
      });
      filterDiffApplyStrategy.clearFilteredHighlight();
      setFilterPhase('idle');
      updateFilterRuntimeStatus({
        statusCode: 'invalid',
        message: currentState.errorMessage,
        count: 0
      });
      return;
    }
    const activeLayers = Array.isArray(prepared.layers) ? prepared.layers : [];
    debugFilterLog('filter rules changed', { reason, layers: activeLayers });
    currentFilterRulesHash = prepared.rulesHash;
    if (activeLayers.length === 0 || prepared.requestSpecs.length === 0) {
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
      const cachedPayload = {
        ...cached,
        meta: {
          ...(cached?.meta || {}),
          cacheHit: true
        }
      };
      await filterDiffApplyStrategy.applyFilteredFeaturePaintGroups(
        Array.isArray(cachedPayload?.highlightColorGroups) ? cachedPayload.highlightColorGroups : [],
        token,
        {
          phase: 'optimistic',
          matchedFeatureIds: Array.isArray(cachedPayload?.matchedFeatureIds)
            ? cachedPayload.matchedFeatureIds
            : []
        }
      );
      if (token !== latestFilterToken) return;
      patchState({
        lastElapsedMs: Number(cachedPayload?.meta?.elapsedMs || 0),
        lastCacheHit: Boolean(cachedPayload?.meta?.cacheHit),
        lastCount: Number(cachedPayload?.matchedCount || 0)
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
        setPaintPropertyCalls: currentState.setPaintPropertyCallsLast
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
      setFilterPhase('authoritative');
      recordFilterTelemetry('coverage_exact_cache_hit', {
        bboxHash,
        coverageHash
      });
      return;
    }

    const reusableResolvedPayload = filterMatchCacheStrategy.findReusableResolvedPayload({
      viewportBbox: bbox,
      rulesHash: prepared.rulesHash,
      zoomBucket
    });
    if (reusableResolvedPayload) {
      const reusedPayload = {
        ...reusableResolvedPayload,
        meta: {
          ...(reusableResolvedPayload?.meta || {}),
          cacheHit: true
        }
      };
      await filterDiffApplyStrategy.applyFilteredFeaturePaintGroups(
        Array.isArray(reusedPayload?.highlightColorGroups) ? reusedPayload.highlightColorGroups : [],
        token,
        {
          phase: 'optimistic',
          matchedFeatureIds: Array.isArray(reusedPayload?.matchedFeatureIds)
            ? reusedPayload.matchedFeatureIds
            : []
        }
      );
      if (token !== latestFilterToken) return;
      patchState({
        lastElapsedMs: Number(reusedPayload?.meta?.elapsedMs || 0),
        lastCacheHit: true,
        lastCount: Number(reusedPayload?.matchedCount || 0)
      });
      activeFilterCoverageWindow = {
        ...(reusedPayload?.meta?.coverageWindow || coverageWindow),
        rulesHash: prepared.rulesHash,
        zoomBucket
      };
      activeFilterCoverageKey = String(reusedPayload?.meta?.coverageHash || coverageHash);
      setFilterPhase('authoritative');
      updateFilterRuntimeStatus({
        statusCode: 'applied',
        count: currentState.lastCount,
        elapsedMs: currentState.lastElapsedMs,
        cacheHit: true,
        setPaintPropertyCalls: currentState.setPaintPropertyCallsLast
      });
      updateFilterDebugHook({
        active: currentState.lastCount > 0,
        expr: ['literal', prepared.rulesHash],
        mode: FILTER_HIGHLIGHT_MODE,
        phase: currentState.phase,
        lastElapsedMs: currentState.lastElapsedMs,
        lastCount: currentState.lastCount,
        cacheHit: true
      });
      recordFilterTelemetry('coverage_history_hit', {
        bboxHash,
        coverageHash: activeFilterCoverageKey
      });
      return;
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
      layers: activeLayers,
      requestSpecs: prepared.requestSpecs,
      combinedGroup: prepared.combinedGroup,
      rulesHash: prepared.rulesHash,
      coverageWindow,
      coverageHash,
      bboxHash,
      zoomBucket,
      cacheKey
    }, token, debounceMs);
  }

  function scheduleFilterRefresh(input: LooseRecord) {
    if (mapMoveDebounceTimer) {
      clearTimeout(mapMoveDebounceTimer);
      mapMoveDebounceTimer = null;
    }
    mapMoveDebounceTimer = setTimeout(() => {
      mapMoveDebounceTimer = null;
      applyBuildingFilters(input, { reason: 'viewport' });
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

  function scheduleFilterRulesRefresh(input: LooseRecord) {
    applyBuildingFilters(input, { reason: 'rules' });
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
    if (filterAuthoritativeTimer) {
      clearTimeout(filterAuthoritativeTimer);
      filterAuthoritativeTimer = null;
    }
    filterMatchCacheStrategy.destroy();
    if (activeFilterAbortController) {
      activeFilterAbortController.abort();
      activeFilterAbortController = null;
    }
    filterDiffApplyStrategy.clearFilteredHighlight();
    filterCache.clear();
    filterFetcher.clear();
    activeFilterCoverageWindow = null;
    activeFilterCoverageKey = '';
    lastAuthoritativeRequestKey = '';
    currentFilterRulesHash = 'fnv1a-0';
    lastViewportHash = '';
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
      setPaintPropertyCalls: 0,
      updatedAt: Date.now()
    });
    filterWorkerDispatcher.destroy();
    patchState({
      errorMessage: '',
      statusMessage: '',
      statusCode: 'idle',
      phase: 'idle',
      lastElapsedMs: 0,
      lastCount: 0,
      lastCacheHit: false,
      setPaintPropertyCallsLast: 0,
      lastPaintApplyMs: 0
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
    clearFilteredHighlight: () => filterDiffApplyStrategy.clearFilteredHighlight(),
    destroy,
    getCoverageWindowForViewport,
    refreshDebugState,
    registerFilterMoveEnd,
    reapplyFilteredHighlight: () => filterDiffApplyStrategy.reapplyFilteredHighlight(),
    scheduleFilterRefresh,
    scheduleFilterRulesRefresh
  };
}
