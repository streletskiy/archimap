import { buildBboxHash, isViewportInsideBbox } from './filter-bbox.js';
import type {
  BboxSnapshot,
  FilterCoverageContext,
  FilterMapLike,
  FilterMatchPayload,
  FilterRequestResolution,
  FilterRequestSpec,
  FilterRule
} from './filter-types.js';

type FilterMatchBatchResponse = {
  items?: Array<FilterMatchPayload & { id?: string }>;
  meta?: {
    elapsedMs?: number;
    cacheHit?: boolean;
  };
};

type FilterCacheLike = {
  getCachedFilterMatches: (cacheKey: string) => FilterMatchPayload | null;
  putCachedFilterMatches: (cacheKey: string, payload: FilterMatchPayload) => void;
  findCachedFilterMatches: (
    match: (payload: FilterMatchPayload, cacheKey: string) => boolean
  ) => FilterMatchPayload | null;
};

type FilterFetcherLike = {
  fetchFilterMatchesPrimary: (args: {
    bbox: unknown;
    zoomBucket: number;
    rules: FilterRule[];
    rulesHash: string;
    maxResults?: number;
    renderMode?: 'contours' | 'markers';
    signal?: AbortSignal | null;
  }) => Promise<FilterMatchPayload>;
  fetchFilterMatchesFallback: (args: {
    rules: FilterRule[];
    signal?: AbortSignal | null;
  }) => Promise<FilterMatchPayload>;
  fetchFilterMatchesBatchPrimary: (args: {
    bbox: unknown;
    zoomBucket: number;
    requestSpecs: FilterRequestSpec[];
    maxResults?: number;
    renderMode?: 'contours' | 'markers';
    signal?: AbortSignal | null;
  }) => Promise<FilterMatchBatchResponse>;
};

type FilterMatchPayloadMeta = FilterMatchPayload['meta'];

function normalizeRenderMode(renderMode: unknown) {
  return String(renderMode || 'contours') === 'markers' ? 'markers' : 'contours';
}

function normalizeMatchLimit(value: unknown, fallback: number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return Math.max(1, Math.trunc(fallback));
  return Math.max(1, Math.trunc(parsed));
}

function normalizeMatchPayload(
  payload: FilterMatchPayload | null | undefined,
  defaults: {
    rulesHash: string;
    bboxHash: string;
    coverageHash?: string;
    coverageWindow?: FilterMatchPayloadMeta['coverageWindow'];
    zoomBucket?: number;
    renderMode?: FilterMatchPayloadMeta['renderMode'];
    fallback?: boolean;
    cacheHit?: boolean;
    truncated?: boolean;
    elapsedMs?: number;
  }
): FilterMatchPayload {
  const payloadMeta = payload?.meta;
  return {
    matchedKeys: Array.isArray(payload?.matchedKeys) ? [...payload.matchedKeys] : [],
    matchedFeatureIds: Array.isArray(payload?.matchedFeatureIds) ? [...payload.matchedFeatureIds] : [],
    matchedLocations: Array.isArray(payload?.matchedLocations) ? [...payload.matchedLocations] : [],
    ...(Array.isArray(payload?.highlightColorGroups) ? { highlightColorGroups: payload.highlightColorGroups } : {}),
    ...(payload?.matchedCount != null ? { matchedCount: payload.matchedCount } : {}),
    meta: {
      rulesHash: String(payloadMeta?.rulesHash || defaults.rulesHash || 'fnv1a-0'),
      bboxHash: String(payloadMeta?.bboxHash || defaults.bboxHash || ''),
      truncated: Boolean(payloadMeta?.truncated ?? defaults.truncated ?? false),
      elapsedMs: Number(payloadMeta?.elapsedMs ?? defaults.elapsedMs ?? 0),
      cacheHit: Boolean(payloadMeta?.cacheHit ?? defaults.cacheHit ?? false),
      fallback: Boolean(payloadMeta?.fallback ?? defaults.fallback ?? false),
      renderMode: normalizeRenderMode(payloadMeta?.renderMode ?? defaults.renderMode),
      coverageHash: payloadMeta?.coverageHash ?? defaults.coverageHash,
      coverageWindow: payloadMeta?.coverageWindow ?? defaults.coverageWindow ?? null,
      zoomBucket: Number(payloadMeta?.zoomBucket ?? defaults.zoomBucket ?? 0)
    }
  };
}

type FilterMatchCacheStrategyOptions = {
  filterCache: FilterCacheLike;
  filterFetcher: FilterFetcherLike;
  buildFilterRequestCacheKey: (spec: FilterRequestSpec, coverageHash: string, zoomBucket: number, renderMode?: 'contours' | 'markers') => string;
  buildPrefetchCoverageWindow: (coverageWindow: BboxSnapshot | null | undefined) => BboxSnapshot | null;
  resolveMap: () => FilterMapLike | null | undefined;
  getLatestFilterToken: () => number;
  recordFilterRequestDebugEvent: (eventName: string) => void;
  recordFilterTelemetry: (eventName: string, payload?: Record<string, unknown>) => void;
  prefetchEnabled?: boolean;
  prefetchMinIntervalMs?: number;
};

function isAbortError(error) {
  return String(error?.name || '').toLowerCase() === 'aborterror';
}

export function createFilterMatchCacheStrategy({
  filterCache,
  filterFetcher,
  buildFilterRequestCacheKey,
  buildPrefetchCoverageWindow,
  resolveMap,
  getLatestFilterToken,
  recordFilterRequestDebugEvent,
  recordFilterTelemetry,
  prefetchEnabled = true,
  prefetchMinIntervalMs = 900
}: FilterMatchCacheStrategyOptions = {} as FilterMatchCacheStrategyOptions) {
  let prefetchFilterAbortController: AbortController | null = null;
  let filterPrefetchTimer: ReturnType<typeof setTimeout> | null = null;
  let filterLastPrefetchAt = 0;

  function cancelPrefetch() {
    if (prefetchFilterAbortController) {
      prefetchFilterAbortController.abort();
      prefetchFilterAbortController = null;
      recordFilterRequestDebugEvent?.('prefetch-abort');
      recordFilterTelemetry?.('prefetch_abort');
    }
    if (filterPrefetchTimer) {
      clearTimeout(filterPrefetchTimer);
      filterPrefetchTimer = null;
    }
  }

  function findReusableResolvedPayload({
    viewportBbox,
    rulesHash,
    zoomBucket,
    renderMode
  }: {
    viewportBbox: BboxSnapshot | null | undefined;
    rulesHash: string;
    zoomBucket: number;
    renderMode?: 'contours' | 'markers';
  }) {
    const normalizedRenderMode = normalizeRenderMode(renderMode);
    return filterCache.findCachedFilterMatches((payload) => {
      const meta = payload?.meta as FilterMatchPayloadMeta | undefined;
      const coverageWindow = meta?.coverageWindow;
      if (!coverageWindow) return false;
      if (String(meta?.rulesHash || '') !== String(rulesHash || '')) return false;
      if (Number(meta?.zoomBucket || 0) !== Number(zoomBucket || 0)) return false;
      if (normalizeRenderMode(meta?.renderMode) !== normalizedRenderMode) return false;
      return isViewportInsideBbox(viewportBbox, coverageWindow);
    });
  }

  async function fetchMatchesForRequestSpec(
    spec: FilterRequestSpec,
    context: FilterCoverageContext,
    signal: AbortSignal,
    { allowCache = true }: { allowCache?: boolean } = {}
  ): Promise<Omit<FilterRequestResolution, 'spec'>> {
    const renderMode = normalizeRenderMode(context.renderMode);
    const requestCacheKey = buildFilterRequestCacheKey(spec, context.coverageHash, context.zoomBucket, renderMode);
    const maxResults = normalizeMatchLimit(context.matchLimit, 12_000);
    if (allowCache) {
      const cached = filterCache.getCachedFilterMatches(requestCacheKey);
      if (cached) {
        return {
          payload: normalizeMatchPayload(cached, {
            rulesHash: cached?.meta?.rulesHash || spec.rulesHash,
            bboxHash: cached?.meta?.bboxHash || context.bboxHash,
            coverageHash: cached?.meta?.coverageHash || context.coverageHash,
            coverageWindow: cached?.meta?.coverageWindow ?? context.coverageWindow,
            zoomBucket: cached?.meta?.zoomBucket ?? context.zoomBucket,
            renderMode,
            fallback: Boolean(cached?.meta?.fallback),
            cacheHit: true
          }),
          cacheHit: true,
          usedFallback: Boolean(cached?.meta?.fallback)
        };
      }
    }

    let payload: FilterMatchPayload;
    let usedFallback = false;
    try {
      payload = await filterFetcher.fetchFilterMatchesPrimary({
        bbox: context.coverageWindow,
        zoomBucket: context.zoomBucket,
        rules: spec.rules,
        rulesHash: spec.rulesHash,
        maxResults,
        renderMode,
        signal
      });
    } catch (error) {
      if (isAbortError(error)) throw error;
      usedFallback = true;
      payload = await filterFetcher.fetchFilterMatchesFallback({
        rules: spec.rules,
        signal
      });
    }

    const normalizedPayload = normalizeMatchPayload(payload, {
      rulesHash: spec.rulesHash,
      bboxHash: context.bboxHash,
      coverageHash: context.coverageHash,
      coverageWindow: context.coverageWindow,
      zoomBucket: context.zoomBucket,
      renderMode,
      fallback: usedFallback,
      cacheHit: Boolean(payload?.meta?.cacheHit)
    });
    filterCache.putCachedFilterMatches(requestCacheKey, normalizedPayload);
    return {
      payload: normalizedPayload,
      cacheHit: false,
      usedFallback
    };
  }

  function getCachedRequestSpecResult(
    spec: FilterRequestSpec,
    context: FilterCoverageContext
  ): FilterRequestResolution | null {
    const renderMode = normalizeRenderMode(context.renderMode);
    const requestCacheKey = buildFilterRequestCacheKey(spec, context.coverageHash, context.zoomBucket, renderMode);
    const cached = filterCache.getCachedFilterMatches(requestCacheKey);
    if (!cached) return null;
    return {
      spec,
      payload: normalizeMatchPayload(cached, {
        rulesHash: cached?.meta?.rulesHash || spec.rulesHash,
        bboxHash: cached?.meta?.bboxHash || context.bboxHash,
        coverageHash: cached?.meta?.coverageHash || context.coverageHash,
        coverageWindow: cached?.meta?.coverageWindow ?? context.coverageWindow,
        zoomBucket: cached?.meta?.zoomBucket ?? context.zoomBucket,
        renderMode,
        fallback: Boolean(cached?.meta?.fallback),
        cacheHit: true
      }),
      cacheHit: true,
      usedFallback: Boolean(cached?.meta?.fallback)
    };
  }

  async function fetchMatchesBatchForRequestSpecs(
    specs: FilterRequestSpec[],
    context: FilterCoverageContext,
    signal: AbortSignal
  ): Promise<FilterRequestResolution[]> {
    const renderMode = normalizeRenderMode(context.renderMode);
    const maxResults = normalizeMatchLimit(context.matchLimit, 12_000);
    const batchPayload = await filterFetcher.fetchFilterMatchesBatchPrimary({
      bbox: context.coverageWindow,
      zoomBucket: context.zoomBucket,
      requestSpecs: specs,
      maxResults,
      renderMode,
      signal
    });
    const itemsById = new Map(
      (Array.isArray(batchPayload?.items) ? batchPayload.items : [])
        .map((item) => [String(item?.id || ''), item])
    );

    return specs.map((spec): FilterRequestResolution => {
        const payload = itemsById.get(String(spec.id || '')) || {
          matchedKeys: [],
          matchedFeatureIds: [],
          matchedCount: 0,
          meta: {
            rulesHash: spec.rulesHash,
            bboxHash: context.bboxHash,
            truncated: false,
            elapsedMs: Number(batchPayload?.meta?.elapsedMs || 0),
            cacheHit: Boolean(batchPayload?.meta?.cacheHit),
            renderMode
          }
        };
      const normalizedPayload = normalizeMatchPayload(payload, {
        rulesHash: payload?.meta?.rulesHash || spec.rulesHash,
        bboxHash: payload?.meta?.bboxHash || context.bboxHash,
        coverageHash: payload?.meta?.coverageHash || context.coverageHash,
        coverageWindow: payload?.meta?.coverageWindow ?? context.coverageWindow,
        zoomBucket: payload?.meta?.zoomBucket ?? context.zoomBucket,
        renderMode,
        fallback: Boolean(payload?.meta?.fallback),
        cacheHit: Boolean(payload?.meta?.cacheHit),
        truncated: Boolean(payload?.meta?.truncated),
        elapsedMs: Number(batchPayload?.meta?.elapsedMs || 0)
      });
      filterCache.putCachedFilterMatches(
        buildFilterRequestCacheKey(spec, context.coverageHash, context.zoomBucket, renderMode),
        normalizedPayload
      );
      return {
        spec,
        payload: normalizedPayload,
        cacheHit: Boolean(normalizedPayload?.meta?.cacheHit),
        usedFallback: Boolean(normalizedPayload?.meta?.fallback)
      };
    });
  }

  function schedulePrefetch(context: FilterCoverageContext, token: number) {
    if (!prefetchEnabled || !context?.coverageWindow || !context?.rulesHash) return;
    if (!Array.isArray(context?.requestSpecs) || context.requestSpecs.length !== 1) return;
    const spec = context.requestSpecs[0];
    if (!Array.isArray(spec?.rules) || spec.rules.length === 0) return;
    const now = Date.now();
    if ((now - filterLastPrefetchAt) < prefetchMinIntervalMs) return;
    const prefetchBbox = buildPrefetchCoverageWindow(context.coverageWindow);
    if (!prefetchBbox) return;
    const prefetchHash = buildBboxHash(prefetchBbox, 4);
    const renderMode = normalizeRenderMode(context.renderMode);
    const maxResults = normalizeMatchLimit(context.matchLimit, 12_000);
    const prefetchCacheKey = buildFilterRequestCacheKey(spec, prefetchHash, context.zoomBucket, renderMode);
    if (filterCache.getCachedFilterMatches(prefetchCacheKey)) return;

    cancelPrefetch();
    filterPrefetchTimer = setTimeout(async () => {
      filterPrefetchTimer = null;
      if (token !== Number(getLatestFilterToken?.() ?? token) || !resolveMap?.()) return;

      prefetchFilterAbortController = new AbortController();
      const signal = prefetchFilterAbortController.signal;
      filterLastPrefetchAt = Date.now();
      recordFilterRequestDebugEvent?.('prefetch-start');
      recordFilterTelemetry?.('prefetch_start', {
        prefetchHash
      });

      try {
        const payload = await filterFetcher.fetchFilterMatchesPrimary({
          bbox: prefetchBbox,
          zoomBucket: context.zoomBucket,
          rules: spec.rules,
          rulesHash: spec.rulesHash,
          maxResults,
          renderMode,
          signal
        });
        if (token !== Number(getLatestFilterToken?.() ?? token)) return;
        filterCache.putCachedFilterMatches(prefetchCacheKey, normalizeMatchPayload(payload, {
          rulesHash: spec.rulesHash,
          bboxHash: prefetchHash,
          coverageHash: prefetchHash,
          coverageWindow: prefetchBbox,
          zoomBucket: context.zoomBucket,
          renderMode,
          cacheHit: Boolean(payload?.meta?.cacheHit),
          fallback: Boolean(payload?.meta?.fallback),
          truncated: Boolean(payload?.meta?.truncated),
          elapsedMs: Number(payload?.meta?.elapsedMs || 0)
        }));
        recordFilterRequestDebugEvent?.('prefetch-finish');
        recordFilterTelemetry?.('prefetch_finish', {
          prefetchHash,
          count: Math.max(
            Array.isArray(payload?.matchedFeatureIds) ? payload.matchedFeatureIds.length : 0,
            Array.isArray(payload?.matchedKeys) ? payload.matchedKeys.length : 0
          )
        });
      } catch (error) {
        if (isAbortError(error)) {
          recordFilterRequestDebugEvent?.('prefetch-abort');
          recordFilterTelemetry?.('prefetch_abort', { prefetchHash });
        }
      } finally {
        if (prefetchFilterAbortController?.signal === signal) {
          prefetchFilterAbortController = null;
        }
      }
    }, 60);
  }

  function destroy() {
    cancelPrefetch();
    filterLastPrefetchAt = 0;
  }

  return {
    cancelPrefetch,
    destroy,
    fetchMatchesBatchForRequestSpecs,
    fetchMatchesForRequestSpec,
    findReusableResolvedPayload,
    getCachedRequestSpecResult,
    schedulePrefetch
  };
}
