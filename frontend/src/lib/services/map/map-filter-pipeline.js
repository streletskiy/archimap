import { writable } from 'svelte/store';
import { EMPTY_LAYER_FILTER, hashFilterExpression } from '$lib/components/map/filter-highlight-utils';
import { FILTER_LAYER_BASE_COLOR } from '$lib/constants/filter-presets';
import {
  computeRulesHash,
  normalizeFilterLayers,
  normalizeFilterRules,
  sortFilterLayersByPriority,
  toFeatureIdSetFromMatches
} from '$lib/components/map/filter-pipeline-utils';
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

export const FILTER_HIGHLIGHT_MODE = 'paint-property';
export const FILTER_TELEMETRY_ENABLED = Boolean(import.meta.env.DEV || import.meta.env.MODE === 'test');

const FILTER_REQUEST_DEBOUNCE_MS = 180;
const FILTER_HEAVY_RULE_DEBOUNCE_MS = 500;
const FILTER_RULE_CHANGE_DEBOUNCE_MS = 90;
const FILTER_MATCH_CACHE_TTL_MS = 8_000;
const FILTER_MATCH_CACHE_MAX_ITEMS = 90;
const FILTER_MATCH_DEGRADE_LIMIT = 20_000;
const FILTER_MATCH_DEFAULT_LIMIT = 12_000;
const FILTER_DATA_CACHE_TTL_MS = 45_000;
const FILTER_DATA_CACHE_MAX_ITEMS = 25_000;
const FILTER_DATA_REQUEST_CHUNK_SIZE = 5_000;
const FILTER_COVERAGE_MARGIN_MIN = 0.2;
const FILTER_COVERAGE_MARGIN_MAX = 0.35;
const FILTER_PREFETCH_ENABLED = true;
const FILTER_PREFETCH_MIN_INTERVAL_MS = 900;

function isLayerInput(input) {
  return Array.isArray(input) && input.some((item) => (
    Array.isArray(item?.rules) ||
    item?.mode != null ||
    item?.color != null ||
    item?.priority != null ||
    item?.id != null
  ));
}

function normalizeFilterInputLayers(input) {
  if (isLayerInput(input)) {
    return normalizeFilterLayers(input);
  }
  const normalizedRules = normalizeFilterRules(input);
  if (normalizedRules.invalidReason) {
    return { layers: [], invalidReason: normalizedRules.invalidReason };
  }
  if (normalizedRules.rules.length === 0) {
    return { layers: [], invalidReason: '' };
  }
  return normalizeFilterLayers([{
    id: 'compat-filter-layer',
    color: FILTER_LAYER_BASE_COLOR,
    priority: 0,
    mode: 'and',
    rules: normalizedRules.rules
  }]);
}

function buildFilterRequestCacheKey(spec, coverageHash, zoomBucket) {
  return `request:${spec.id}:${spec.rulesHash}:${coverageHash}:${zoomBucket}`;
}

function buildFilterRequestSpecs(layers) {
  const sortedLayers = sortFilterLayersByPriority(layers);
  const combinedLayers = sortedLayers.filter((layer) => layer.mode === 'and' || layer.mode === 'or');
  const andLayers = combinedLayers.filter((layer) => layer.mode === 'and');
  const orLayers = combinedLayers.filter((layer) => layer.mode === 'or');
  const standaloneLayers = sortedLayers.filter((layer) => layer.mode === 'layer');
  const requestSpecs = [];
  const combinedGroup = combinedLayers.length > 0
    ? {
      id: 'combined-group',
      color: combinedLayers[0].color || FILTER_LAYER_BASE_COLOR,
      priority: Number(combinedLayers[0].priority || 0),
      hasAnd: andLayers.length > 0,
      hasOr: orLayers.length > 0
    }
    : null;

  if (andLayers.length > 0) {
    const rules = andLayers.flatMap((layer) => layer.rules);
    requestSpecs.push({
      id: 'combined-and',
      kind: 'combined-and',
      groupId: 'combined-group',
      rules,
      rulesHash: computeRulesHash(rules),
      color: combinedGroup?.color || FILTER_LAYER_BASE_COLOR,
      priority: combinedGroup?.priority ?? 0
    });
  }

  for (const layer of orLayers) {
    requestSpecs.push({
      id: `combined-or:${layer.id}`,
      kind: 'combined-or',
      groupId: 'combined-group',
      layerId: layer.id,
      rules: layer.rules,
      rulesHash: computeRulesHash(layer.rules),
      color: combinedGroup?.color || FILTER_LAYER_BASE_COLOR,
      priority: combinedGroup?.priority ?? Number(layer.priority || 0)
    });
  }

  for (const layer of standaloneLayers) {
    requestSpecs.push({
      id: `layer:${layer.id}`,
      kind: 'layer',
      groupId: layer.id,
      layerId: layer.id,
      rules: layer.rules,
      rulesHash: computeRulesHash(layer.rules),
      color: layer.color || FILTER_LAYER_BASE_COLOR,
      priority: Number(layer.priority || 0)
    });
  }

  return {
    layers: sortedLayers,
    combinedGroup,
    requestSpecs,
    hasStandaloneLayers: standaloneLayers.length > 0
  };
}

function buildResolvedLayerPayload({ prepared, payloadsByRequestId, cacheHit = false }) {
  const resolvedEntriesById = new Map();
  const requestSpecs = Array.isArray(prepared?.requestSpecs) ? prepared.requestSpecs : [];
  const combinedGroup = prepared?.combinedGroup || null;
  const combinedAndPayload = payloadsByRequestId.get('combined-and');
  const combinedOrPayloads = requestSpecs
    .filter((spec) => spec.kind === 'combined-or')
    .map((spec) => payloadsByRequestId.get(spec.id))
    .filter(Boolean);

  function assignResolvedFeature(id, color, priority) {
    if (!Number.isInteger(id) || id <= 0) return;
    const current = resolvedEntriesById.get(id);
    if (current && current.priority <= priority) return;
    resolvedEntriesById.set(id, {
      color,
      priority
    });
  }

  if (combinedGroup) {
    let combinedSet = null;
    if (combinedAndPayload) {
      combinedSet = toFeatureIdSetFromMatches(combinedAndPayload);
    }
    if (combinedOrPayloads.length > 0) {
      const unionOrSet = new Set();
      for (const payload of combinedOrPayloads) {
        for (const id of toFeatureIdSetFromMatches(payload)) {
          unionOrSet.add(id);
        }
      }
      combinedSet = combinedSet
        ? new Set([...combinedSet].filter((id) => unionOrSet.has(id)))
        : unionOrSet;
    }
    if (combinedSet) {
      for (const id of combinedSet) {
        assignResolvedFeature(id, combinedGroup.color, combinedGroup.priority);
      }
    }
  }

  for (const spec of requestSpecs) {
    if (spec.kind !== 'layer') continue;
    const payload = payloadsByRequestId.get(spec.id);
    if (!payload) continue;
    for (const id of toFeatureIdSetFromMatches(payload)) {
      assignResolvedFeature(id, spec.color, spec.priority);
    }
  }

  const highlightGroupsByColor = new Map();
  for (const [id, entry] of resolvedEntriesById.entries()) {
    const color = String(entry?.color || FILTER_LAYER_BASE_COLOR).trim() || FILTER_LAYER_BASE_COLOR;
    const bucket = highlightGroupsByColor.get(color) || [];
    bucket.push(id);
    highlightGroupsByColor.set(color, bucket);
  }

  const highlightColorGroups = [...highlightGroupsByColor.entries()].map(([color, ids]) => ({
    color,
    ids
  }));

  const payloads = [...payloadsByRequestId.values()];
  return {
    highlightColorGroups,
    matchedCount: resolvedEntriesById.size,
    meta: {
      rulesHash: String(prepared?.rulesHash || 'fnv1a-0'),
      bboxHash: '',
      truncated: payloads.some((payload) => Boolean(payload?.meta?.truncated)),
      elapsedMs: payloads.reduce((sum, payload) => sum + Number(payload?.meta?.elapsedMs || 0), 0),
      cacheHit: cacheHit
    }
  };
}

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
    setPaintPropertyCalls = currentState.setPaintPropertyCallsLast
  } = {}) {
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
      active: filterFeatureStateManager.getFilteredFeatureCount() > 0,
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

  function findReusableResolvedPayload({ viewportBbox, rulesHash, zoomBucket }) {
    return filterCache.findCachedFilterMatches((payload) => {
      const meta = payload?.meta || {};
      const coverageWindow = meta.coverageWindow;
      if (!coverageWindow) return false;
      if (String(meta.rulesHash || '') !== String(rulesHash || '')) return false;
      if (Number(meta.zoomBucket || 0) !== Number(zoomBucket || 0)) return false;
      return isViewportInsideBbox(viewportBbox, coverageWindow);
    });
  }

  async function prepareRulesForFiltering(input) {
    try {
      const requestPayload = isLayerInput(input)
        ? { layers: input }
        : { rules: input };
      const workerResult = await requestFilterWorker('prepare-rules', requestPayload);
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

  async function fetchMatchesForRequestSpec(spec, context, signal, { allowCache = true } = {}) {
    const requestCacheKey = buildFilterRequestCacheKey(spec, context.coverageHash, context.zoomBucket);
    if (allowCache) {
      const cached = filterCache.getCachedFilterMatches(requestCacheKey);
      if (cached) {
        return {
          payload: {
            ...cached,
            meta: {
              ...(cached?.meta || {}),
              cacheHit: true
            }
          },
          cacheHit: true,
          usedFallback: Boolean(cached?.meta?.fallback)
        };
      }
    }

    let payload;
    let usedFallback = false;
    try {
      payload = await filterFetcher.fetchFilterMatchesPrimary({
        bbox: context.coverageWindow,
        zoomBucket: context.zoomBucket,
        rules: spec.rules,
        rulesHash: spec.rulesHash,
        signal
      });
    } catch (error) {
      if (String(error?.name || '').toLowerCase() === 'aborterror') throw error;
      usedFallback = true;
      payload = await filterFetcher.fetchFilterMatchesFallback({
        rules: spec.rules,
        signal
      });
    }

    const normalizedPayload = {
      ...payload,
      meta: {
        ...(payload?.meta || {}),
        fallback: usedFallback,
        cacheHit: Boolean(payload?.meta?.cacheHit)
      }
    };
    filterCache.putCachedFilterMatches(requestCacheKey, normalizedPayload);
    return {
      payload: normalizedPayload,
      cacheHit: false,
      usedFallback
    };
  }

  function scheduleFilterPrefetch(context, token) {
    if (!FILTER_PREFETCH_ENABLED || !context?.coverageWindow || !context?.rulesHash) return;
    if (!Array.isArray(context?.requestSpecs) || context.requestSpecs.length !== 1) return;
    const spec = context.requestSpecs[0];
    if (!Array.isArray(spec?.rules) || spec.rules.length === 0) return;
    const now = Date.now();
    if ((now - filterLastPrefetchAt) < FILTER_PREFETCH_MIN_INTERVAL_MS) return;
    const prefetchBbox = buildPrefetchCoverageWindow(context.coverageWindow);
    if (!prefetchBbox) return;
    const prefetchHash = buildBboxHash(prefetchBbox, 4);
    const prefetchCacheKey = buildFilterRequestCacheKey(spec, prefetchHash, context.zoomBucket);
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
          rules: spec.rules,
          rulesHash: spec.rulesHash,
          signal
        });
        if (token !== latestFilterToken) return;
        filterCache.putCachedFilterMatches(prefetchCacheKey, {
          ...payload,
          meta: {
            ...(payload?.meta || {}),
            cacheHit: Boolean(payload?.meta?.cacheHit)
          }
        });
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
      let requestResults = [];
      try {
        requestResults = await Promise.all(context.requestSpecs.map(async (spec) => {
          const result = await fetchMatchesForRequestSpec(spec, context, signal);
          return {
            spec,
            ...result
          };
        }));
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
        zoomBucket: context.zoomBucket
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

      await filterFeatureStateManager.applyFilteredFeaturePaintGroups(
        resolvedPayload.highlightColorGroups || [],
        token,
        { phase: 'authoritative' }
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
        highlightedCount: filterFeatureStateManager.getFilteredFeatureCount()
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
    filterFeatureStateManager.clearFilteredHighlight();
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
      filterFeatureStateManager.clearFilteredHighlight();
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
      await filterFeatureStateManager.applyFilteredFeaturePaintGroups(
        Array.isArray(cachedPayload?.highlightColorGroups) ? cachedPayload.highlightColorGroups : [],
        token,
        { phase: 'optimistic' }
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

    const reusableResolvedPayload = findReusableResolvedPayload({
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
      await filterFeatureStateManager.applyFilteredFeaturePaintGroups(
        Array.isArray(reusedPayload?.highlightColorGroups) ? reusedPayload.highlightColorGroups : [],
        token,
        { phase: 'optimistic' }
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

  function scheduleFilterRefresh(input) {
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

  function scheduleFilterRulesRefresh(input) {
    if (filterRulesDebounceTimer) {
      clearTimeout(filterRulesDebounceTimer);
      filterRulesDebounceTimer = null;
    }
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
    filterFeatureStateManager.clearFilteredHighlight();
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
      setPaintPropertyCalls: 0,
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
    clearFilteredHighlight: () => filterFeatureStateManager.clearFilteredHighlight(),
    destroy,
    getCoverageWindowForViewport,
    refreshDebugState,
    registerFilterMoveEnd,
    reapplyFilteredHighlight: () => filterFeatureStateManager.reapplyFilteredHighlight(),
    scheduleFilterRefresh,
    scheduleFilterRulesRefresh
  };
}
