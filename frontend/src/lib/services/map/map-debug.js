import { EMPTY_LAYER_FILTER, hashFilterExpression } from '$lib/components/map/filter-highlight-utils';

const FILTER_REQUEST_COUNTER_DEFAULTS = Object.freeze({
  start: 0,
  abort: 0,
  finish: 0,
  prefetchStart: 0,
  prefetchAbort: 0,
  prefetchFinish: 0
});

function ensureWindowDebugState() {
  if (typeof window === 'undefined') return null;
  window.__MAP_DEBUG__ = window.__MAP_DEBUG__ || {};
  return window.__MAP_DEBUG__;
}

export function createMapDebugController({
  getMap = () => null,
  getLayerIds = () => [],
  isFilterDebugEnabled = () => false,
  telemetryEnabled = false
} = {}) {
  let debugState = {
    active: false,
    exprHash: hashFilterExpression(EMPTY_LAYER_FILTER)
  };

  function log(eventName, payload = {}) {
    if (!isFilterDebugEnabled()) return;
    console.debug('[map-filter]', eventName, {
      ts: new Date().toISOString(),
      ...payload
    });
  }

  function updateHook({
    active = false,
    expr = EMPTY_LAYER_FILTER,
    mode = 'paint-property',
    phase = 'idle',
    lastElapsedMs = 0,
    lastCount = 0,
    cacheHit = false,
    setPaintPropertyCalls = 0
  } = {}) {
    if (typeof document === 'undefined') {
      debugState = {
        active: Boolean(active),
        exprHash: hashFilterExpression(expr)
      };
      return { ...debugState };
    }

    const exprHash = hashFilterExpression(expr);
    debugState = {
      active: Boolean(active),
      exprHash
    };

    document.body.dataset.filterActive = active ? 'true' : 'false';
    document.body.dataset.filterHighlightMode = String(mode);
    document.body.dataset.filterExprHash = exprHash;
    document.body.dataset.filterPhase = String(phase || 'idle');
    document.body.dataset.filterLastElapsedMs = String(Number(lastElapsedMs) || 0);
    document.body.dataset.filterLastCount = String(Number(lastCount) || 0);
    document.body.dataset.filterCacheHit = cacheHit ? 'true' : 'false';
    document.body.dataset.filterSetPaintPropertyCalls = String(Number(setPaintPropertyCalls) || 0);

    const globalDebug = ensureWindowDebugState();
    if (!globalDebug) return { ...debugState };

    globalDebug.filter = {
      active: Boolean(active),
      mode: String(mode),
      exprHash,
      phase: String(phase || 'idle'),
      elapsedMs: Number(lastElapsedMs) || 0,
      count: Number(lastCount) || 0,
      cacheHit: Boolean(cacheHit),
      setPaintPropertyCalls: Number(setPaintPropertyCalls) || 0
    };

    const phaseHistory = Array.isArray(globalDebug.filterPhaseHistory)
      ? globalDebug.filterPhaseHistory
      : [];
    globalDebug.filterPhaseHistory = [...phaseHistory, String(phase || 'idle')].slice(-120);

    const map = getMap();
    if (!map) return { ...debugState };

    const visibilityByLayer = {};
    for (const layerId of getLayerIds()) {
      visibilityByLayer[layerId] = map.getLayer(layerId)
        ? (map.getLayoutProperty(layerId, 'visibility') || 'visible')
        : 'missing';
    }
    globalDebug.layersVisibility = visibilityByLayer;

    return { ...debugState };
  }

  function recordSetFilter(layerId) {
    const globalDebug = ensureWindowDebugState();
    if (!globalDebug) return;
    const current = Array.isArray(globalDebug.setFilterLayers)
      ? globalDebug.setFilterLayers
      : [];
    globalDebug.setFilterLayers = [...current, String(layerId)].slice(-80);
  }

  function recordFilterRequestEvent(eventName) {
    const globalDebug = ensureWindowDebugState();
    if (!globalDebug) return;
    const stats = globalDebug.filterRequests || { ...FILTER_REQUEST_COUNTER_DEFAULTS };
    if (eventName === 'start') stats.start += 1;
    if (eventName === 'abort') stats.abort += 1;
    if (eventName === 'finish') stats.finish += 1;
    if (eventName === 'prefetch-start') stats.prefetchStart += 1;
    if (eventName === 'prefetch-abort') stats.prefetchAbort += 1;
    if (eventName === 'prefetch-finish') stats.prefetchFinish += 1;
    globalDebug.filterRequests = stats;
  }

  function recordFilterTelemetry(eventName, payload = {}) {
    if (!telemetryEnabled) return;
    const globalDebug = ensureWindowDebugState();
    if (!globalDebug) return;
    const telemetry = globalDebug.filterTelemetry || {
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
    globalDebug.filterTelemetry = telemetry;
  }

  function getState() {
    return { ...debugState };
  }

  return {
    log,
    updateHook,
    recordSetFilter,
    recordFilterRequestEvent,
    recordFilterTelemetry,
    getState
  };
}
