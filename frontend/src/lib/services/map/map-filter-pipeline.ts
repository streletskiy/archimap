import { get, writable } from 'svelte/store';
import { createFilterCache } from './filter-cache';
import {
  buildBboxHash,
  buildBboxSnapshot,
  buildPrefetchCoverageWindow as buildPrefetchCoverageWindowSnapshot,
  getCoverageWindowForViewport as getCoverageWindowForViewportSnapshot,
  isViewportInsideBbox
} from './filter-bbox';
import { createFilterFetcher } from './filter-fetcher';
import { FILTER_FALLBACK_MARKER_MAX_ZOOM } from './filter-fallback-marker-utils';
import { createFilterMatchCacheStrategy } from './filter-match-cache-strategy';
import {
  buildResolvedLayerPayload,
  EMPTY_LAYER_FILTER,
  hashFilterExpression,
  isLayerInput,
  buildFilterRequestCacheKey,
  prepareFilterRequestPlan
} from './filter-request-planner';
import { createFilterDiffApplyStrategy } from './filter-diff-apply-strategy';
import { normalizeLayerIdsSnapshot } from './filter-utils';
import { createFilterWorkerDispatcher } from './filter-worker-dispatcher';
import { resetSearchState, searchState } from '$lib/stores/search';
import type {
  BboxSnapshot,
  FilterBuildingSourceConfig,
  FilterCoverageContext,
  FilterDebugHookInput,
  FilterMapDebug,
  FilterMapLike,
  FilterPipelineState,
  FilterResolvedLayerPayload,
  FilterRequestResolution,
  FilterRequestSpec,
  FilterRuntimeStatus,
  LayerIdsSnapshot
} from './filter-types.js';

export const FILTER_HIGHLIGHT_MODE = 'paint-property';
const IMPORT_META_ENV: {
  DEV?: boolean;
  MODE?: string;
} = import.meta.env ?? {};
export const FILTER_TELEMETRY_ENABLED = Boolean(IMPORT_META_ENV.DEV || IMPORT_META_ENV.MODE === 'test');

const FILTER_REQUEST_DEBOUNCE_MS = 180;
const FILTER_HEAVY_RULE_DEBOUNCE_MS = 500;
const FILTER_RULE_CHANGE_DEBOUNCE_MS = 90;
const FILTER_MATCH_CACHE_TTL_MS = 8_000;
const FILTER_MATCH_CACHE_MAX_ITEMS = 90;
const FILTER_MATCH_DEGRADE_LIMIT = FILTER_HIGHLIGHT_MODE === 'paint-property' ? 30_000 : 20_000;
const FILTER_MATCH_DEFAULT_LIMIT = 12_000;
const FILTER_MARKER_MATCH_LIMIT_HIGH = 8_000;
const FILTER_MARKER_MATCH_LIMIT_MID = 12_000;
const FILTER_MARKER_MATCH_LIMIT_LOW = 16_000;
const FILTER_MARKER_MATCH_LIMIT_MIN = 20_000;
const FILTER_DATA_CACHE_TTL_MS = 45_000;
const FILTER_DATA_CACHE_MAX_ITEMS = 25_000;
const FILTER_DATA_REQUEST_CHUNK_SIZE = 5_000;
const FILTER_COVERAGE_MARGIN_MIN = 0.2;
const FILTER_COVERAGE_MARGIN_MAX = 0.35;
const FILTER_PREFETCH_ENABLED = true;
const FILTER_PREFETCH_MIN_INTERVAL_MS = 900;

function createInitialState(mapDebug: FilterMapDebug | null | undefined) {
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

export function getMarkerMatchLimit(zoomBucket: number) {
  const zoom = Number(zoomBucket);
  if (!Number.isFinite(zoom)) return FILTER_MARKER_MATCH_LIMIT_MID;
  if (zoom >= 12.5) return FILTER_MARKER_MATCH_LIMIT_HIGH;
  if (zoom >= 11.5) return FILTER_MARKER_MATCH_LIMIT_MID;
  if (zoom >= 10.5) return FILTER_MARKER_MATCH_LIMIT_LOW;
  return FILTER_MARKER_MATCH_LIMIT_MIN;
}

export function getFilterStatusCodeForRenderMode(renderMode: 'contours' | 'markers', truncated: boolean) {
  if (String(renderMode || 'contours') === 'markers') return 'applied';
  return truncated ? 'truncated' : 'applied';
}

export function createFilterPipeline({
  map,
  mapDebug,
  getLayerIds,
  getBuildingSourceConfigs,
  onStatusChange,
  translateInvalidMessage
}: {
  map?: FilterMapLike | (() => FilterMapLike | null | undefined) | null | undefined;
  mapDebug?: FilterMapDebug | null | undefined;
  getLayerIds?: () => Partial<LayerIdsSnapshot> | LayerIdsSnapshot | null | undefined;
  getBuildingSourceConfigs?: () => FilterBuildingSourceConfig[] | null | undefined;
  onStatusChange?: (status: FilterRuntimeStatus & { updatedAt: number }) => void;
  translateInvalidMessage?: (message?: string) => string;
} = {}) {
  const resolveMap: () => FilterMapLike | null | undefined = typeof map === 'function' ? map : () => map;
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
  let activeFilterCoverageWindow: (FilterCoverageContext['coverageWindow'] & {
    rulesHash?: string;
    zoomBucket?: number;
  }) | null = null;
  let activeFilterCoverageKey = '';
  let activeFilterRenderMode: 'contours' | 'markers' = 'contours';
  let filterLastMoveEndAt = 0;
  let filterLastMapCenter = null;
  let filterLastMoveVector = { dx: 0, dy: 0 };

  function patchState(patch: Partial<FilterPipelineState> = {}) {
    currentState = {
      ...currentState,
      ...patch
    };
    state.set(currentState);
    return currentState;
  }

  function debugFilterLog(eventName: string, payload: Record<string, unknown> = {}) {
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
  }: FilterDebugHookInput = {}) {
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

  function updateFilterRuntimeStatus(status: FilterRuntimeStatus = {}) {
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

  function recordFilterTelemetry(eventName: string, payload: Record<string, unknown> = {}) {
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

  function getCoverageWindowForViewport(viewportBbox: BboxSnapshot | null | undefined) {
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

  function canReuseActiveCoverageWindow({
    viewportBbox,
    rulesHash,
    zoomBucket,
    renderMode,
    reason
  }: {
    viewportBbox: BboxSnapshot | null | undefined;
    rulesHash: string;
    zoomBucket: number;
    renderMode: 'contours' | 'markers';
    reason?: string | null | undefined;
  }) {
    if (reason !== 'viewport') return false;
    if (!activeFilterCoverageWindow) return false;
    if (String(activeFilterCoverageWindow.rulesHash || '') !== String(rulesHash || '')) return false;
    if (Number(activeFilterCoverageWindow.zoomBucket || 0) !== Number(zoomBucket || 0)) return false;
    if (String(activeFilterRenderMode || '') !== String(renderMode || '')) return false;
    return isViewportInsideBbox(viewportBbox, activeFilterCoverageWindow);
  }

  async function prepareRulesForFiltering(input) {
    try {
      const requestPayload = isLayerInput(input)
        ? { layers: input }
        : { rules: input };
      const workerResult = await filterWorkerDispatcher.request('build-request-plan', requestPayload);
      if (workerResult?.ok) {
        return {
          ok: true,
          layers: Array.isArray(workerResult.layers) ? workerResult.layers : [],
          requestSpecs: Array.isArray(workerResult.requestSpecs) ? workerResult.requestSpecs : [],
          combinedGroup: workerResult.combinedGroup || null,
          hasStandaloneLayers: Boolean(workerResult.hasStandaloneLayers),
          rulesHash: String(workerResult.rulesHash || 'fnv1a-0'),
          heavy: Boolean(workerResult.heavy)
        };
      }
      return {
        ok: false,
        error: String(workerResult?.invalidReason || workerResult?.error || 'Invalid filter rules')
      };
    } catch {
      const prepared = prepareFilterRequestPlan(input);
      if (prepared.ok === false) {
        return {
          ok: false,
          error: prepared.invalidReason
        };
      }
      return {
        ok: true,
        layers: prepared.layers,
        requestSpecs: prepared.requestSpecs,
        combinedGroup: prepared.combinedGroup,
        hasStandaloneLayers: prepared.hasStandaloneLayers,
        rulesHash: prepared.rulesHash,
        heavy: prepared.heavy
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
      const renderMode = String(context?.renderMode || 'contours') === 'markers' ? 'markers' : 'contours';
      const requestKey = `${context.rulesHash}:${context.coverageHash}:${context.zoomBucket}:${renderMode}`;
      const matchLimit = Number.isFinite(Number(context?.matchLimit))
        ? Number(context.matchLimit)
        : (renderMode === 'markers' ? getMarkerMatchLimit(context.zoomBucket) : FILTER_MATCH_DEFAULT_LIMIT);
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
      let requestResults: FilterRequestResolution[];
      try {
        const cachedResults: FilterRequestResolution[] = [];
        const missingSpecs: FilterRequestSpec[] = [];
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
            ? await (() => filterMatchCacheStrategy.fetchMatchesBatchForRequestSpecs(missingSpecs, {
              ...context,
              matchLimit
            }, signal))()
                .catch(async (error) => {
                  if (String(error?.name || '').toLowerCase() === 'aborterror') throw error;
                  return Promise.all(missingSpecs.map(async (spec) => {
                    const result = await filterMatchCacheStrategy.fetchMatchesForRequestSpec(spec, {
                      ...context,
                      matchLimit
                    }, signal);
                    return {
                      spec,
                      ...result
                    };
                  }));
                })
            : await Promise.all(missingSpecs.map(async (spec) => {
                const result = await filterMatchCacheStrategy.fetchMatchesForRequestSpec(spec, {
                  ...context,
                  matchLimit
                }, signal);
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

      const usedFallback = requestResults.some((result) => result.usedFallback);
      const cacheHit = requestResults.length > 0 && requestResults.every((result) => result.cacheHit);
      const requestPayloads = requestResults.map((result) => ({
        requestId: result.spec.id,
        payload: result.payload
      }));
      let resolvedPayload: FilterResolvedLayerPayload | null = null;
      try {
        const workerResult = await filterWorkerDispatcher.request('build-resolved-payload', {
          prepared: context,
          payloads: requestPayloads,
          cacheHit
        });
        if (workerResult?.ok) {
          resolvedPayload = {
            highlightColorGroups: Array.isArray(workerResult.highlightColorGroups)
              ? workerResult.highlightColorGroups
              : [],
            matchedFeatureIds: Array.isArray(workerResult.matchedFeatureIds)
              ? workerResult.matchedFeatureIds
              : [],
            matchedCount: Number(workerResult.matchedCount || 0),
            meta: {
              ...(workerResult.meta || {}),
              bboxHash: context.bboxHash,
              coverageHash: context.coverageHash,
              coverageWindow: context.coverageWindow,
              rulesHash: context.rulesHash,
              zoomBucket: context.zoomBucket,
              renderMode,
              truncated: Boolean(workerResult.meta?.truncated),
              elapsedMs: Number(workerResult.meta?.elapsedMs || 0),
              cacheHit: Boolean(workerResult.meta?.cacheHit)
            }
          };
        }
      } catch {
        resolvedPayload = null;
      }
      if (!resolvedPayload) {
        const payloadsByRequestId = new Map<string, FilterRequestResolution['payload']>(
          requestResults.map((result) => [result.spec.id, result.payload])
        );
        resolvedPayload = buildResolvedLayerPayload({
          prepared: context,
          payloadsByRequestId,
          cacheHit
        });
        resolvedPayload.meta = {
          ...(resolvedPayload.meta || {}),
          bboxHash: context.bboxHash,
          coverageHash: context.coverageHash,
          coverageWindow: context.coverageWindow,
          rulesHash: context.rulesHash,
          zoomBucket: context.zoomBucket,
          renderMode,
          truncated: Boolean(resolvedPayload.meta?.truncated),
          elapsedMs: Number(resolvedPayload.meta?.elapsedMs || 0),
          cacheHit: Boolean(resolvedPayload.meta?.cacheHit)
        };
      }
      const matchedSize = Number(resolvedPayload?.matchedCount || 0);
      if (matchedSize > FILTER_MATCH_DEGRADE_LIMIT && renderMode !== 'markers') {
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
            renderMode,
            matchedCount: Number(resolvedPayload?.matchedCount || 0),
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
      activeFilterRenderMode = renderMode;
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
        statusCode: getFilterStatusCodeForRenderMode(renderMode, Boolean(resolvedPayload?.meta?.truncated)),
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
    activeFilterRenderMode = 'contours';
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
    if (!resolveMap()) {
      return;
    }
    if (Array.isArray(input) && input.length === 0) {
      patchState({
        errorMessage: ''
      });
      clearFilterHighlight();
      return;
    }
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
    const currentSearch = get(searchState);
    if (
      Boolean(currentSearch?.mapActive)
      || Boolean(currentSearch?.loading)
      || Boolean(currentSearch?.loadingMore)
      || (Array.isArray(currentSearch?.items) && currentSearch.items.length > 0)
    ) {
      resetSearchState();
    }
    const currentMap = resolveMap();
    const currentZoom = Number(currentMap?.getZoom?.());
    const renderMode = Number.isFinite(currentZoom) && currentZoom < FILTER_FALLBACK_MARKER_MAX_ZOOM
      ? 'markers'
      : 'contours';
    const bboxHash = buildBboxHash(bbox, 4);
    const zoomBucket = Math.round(Number(currentMap?.getZoom?.() || 0) * 2) / 2;
    const coverageWindow = getCoverageWindowForViewport(bbox) || bbox;
    const coverageHash = buildBboxHash(coverageWindow, 4);
    const matchLimit = renderMode === 'markers' ? getMarkerMatchLimit(zoomBucket) : FILTER_MATCH_DEFAULT_LIMIT;
    const cacheKey = `${prepared.rulesHash}:${coverageHash}:${zoomBucket}:${renderMode}`;
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
      renderMode,
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
          renderMode,
          matchedCount: Number(cachedPayload?.matchedCount || 0),
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
      activeFilterRenderMode = renderMode;
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
      zoomBucket,
      renderMode
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
          renderMode,
          matchedCount: Number(reusedPayload?.matchedCount || 0),
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
      activeFilterRenderMode = renderMode;
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
      renderMode,
      matchLimit,
      cacheKey
    }, token, debounceMs);
  }

  function scheduleFilterRefresh(input: unknown) {
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

  function scheduleFilterRulesRefresh(input: unknown) {
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
    activeFilterRenderMode = 'contours';
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
