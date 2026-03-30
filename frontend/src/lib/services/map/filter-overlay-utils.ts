import { FILTER_FALLBACK_MARKER_MAX_ZOOM } from './filter-fallback-marker-utils.js';

function normalizeZoom(value: unknown) {
  const zoom = Number(value);
  return Number.isFinite(zoom) ? zoom : null;
}

function normalizeStatusCode(value: unknown) {
  return String(value || 'idle');
}

function normalizePhase(value: unknown) {
  return String(value || 'idle');
}

function isOverlaySuppressedByZoom(zoom: unknown) {
  const normalizedZoom = normalizeZoom(zoom);
  return normalizedZoom != null && normalizedZoom >= FILTER_FALLBACK_MARKER_MAX_ZOOM;
}

export function shouldShowFilterRefiningMessage(statusCode: unknown, zoom: unknown) {
  if (isOverlaySuppressedByZoom(zoom)) return false;
  return normalizeStatusCode(statusCode) === 'refining';
}

export function shouldShowFilterApplyOverlay(filterState: {
  statusCode?: unknown;
  phase?: unknown;
} | null | undefined, zoom: unknown) {
  if (isOverlaySuppressedByZoom(zoom)) return false;
  const code = normalizeStatusCode(filterState?.statusCode);
  const phase = normalizePhase(filterState?.phase);
  return code === 'refining' || phase === 'optimistic';
}

export function getFilterApplyOverlayState(
  filterState: {
    statusCode?: unknown;
    phase?: unknown;
  } | null | undefined,
  filterRuntime: {
    updatedAt?: unknown;
  } | null | undefined,
  nowMs = Date.now(),
  zoom: unknown = null
) {
  const visible = shouldShowFilterApplyOverlay(filterState, zoom);
  if (!visible) {
    return {
      visible: false,
      progress: 0
    };
  }

  const code = normalizeStatusCode(filterState?.statusCode);
  const phase = normalizePhase(filterState?.phase);
  const startedAt = Number(filterRuntime?.updatedAt || 0);
  const elapsedMs = startedAt > 0 ? Math.max(0, Number(nowMs || Date.now()) - startedAt) : 0;
  let progress;
  if (phase === 'optimistic') {
    progress = 20 + Math.min(elapsedMs / 45, 64 - 20);
  } else if (code === 'refining') {
    progress = 50 + Math.min(elapsedMs / 70, 86 - 50);
  } else {
    progress = 64;
  }

  return {
    visible: true,
    progress: Math.round(Math.max(20, Math.min(86, progress)))
  };
}
