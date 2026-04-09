import { FILTER_FALLBACK_MARKER_MAX_ZOOM } from './filter-fallback-marker-utils.js';

export type InitialFilterReplayAction = 'none' | 'refresh' | 'reapply';

export function hasInitialFilterReplayTargetReady({
  zoom = null,
  hasHighlightLayers = false
}: {
  zoom?: number | null | undefined;
  hasHighlightLayers?: boolean | null | undefined;
} = {}) {
  const normalizedZoom = Number(zoom);
  if (Number.isFinite(normalizedZoom) && normalizedZoom < FILTER_FALLBACK_MARKER_MAX_ZOOM) {
    return true;
  }
  return Boolean(hasHighlightLayers);
}

export function resolveInitialFilterReplayAction({
  hasFilters = false,
  phase = 'idle',
  paintCalls = 0
}: {
  hasFilters?: boolean;
  phase?: string | null | undefined;
  paintCalls?: number | null | undefined;
} = {}): InitialFilterReplayAction {
  if (!hasFilters) return 'none';

  const normalizedPhase = String(phase || 'idle');
  const normalizedPaintCalls = Number(paintCalls || 0);

  // If the first pass is still optimistic and never touched paint, re-running
  // the request is safer than replaying an empty highlight state.
  if (normalizedPhase === 'idle' || (normalizedPaintCalls <= 0 && normalizedPhase !== 'authoritative')) {
    return 'refresh';
  }

  return 'reapply';
}
