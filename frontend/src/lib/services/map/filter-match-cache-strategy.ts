import { buildBboxHash, isViewportInsideBbox } from './filter-bbox.js';

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
}: LooseRecord = {}) {
  let prefetchFilterAbortController = null;
  let filterPrefetchTimer = null;
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

  function findReusableResolvedPayload({ viewportBbox, rulesHash, zoomBucket }: LooseRecord) {
    return filterCache.findCachedFilterMatches((payload) => {
      const meta = payload?.meta || {};
      const coverageWindow = meta.coverageWindow;
      if (!coverageWindow) return false;
      if (String(meta.rulesHash || '') !== String(rulesHash || '')) return false;
      if (Number(meta.zoomBucket || 0) !== Number(zoomBucket || 0)) return false;
      return isViewportInsideBbox(viewportBbox, coverageWindow);
    });
  }

  async function fetchMatchesForRequestSpec(spec, context, signal, { allowCache = true }: LooseRecord = {}) {
    const requestCacheKey = buildFilterRequestCacheKey(spec, context.coverageHash, context.zoomBucket);
    if (allowCache) {
      const cached = filterCache.getCachedFilterMatches(requestCacheKey) as LooseRecord | null;
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

    let payload: LooseRecord;
    let usedFallback = false;
    try {
      payload = await filterFetcher.fetchFilterMatchesPrimary({
        bbox: context.coverageWindow,
        zoomBucket: context.zoomBucket,
        rules: spec.rules,
        rulesHash: spec.rulesHash,
        signal
      }) as LooseRecord;
    } catch (error) {
      if (isAbortError(error)) throw error;
      usedFallback = true;
      payload = await filterFetcher.fetchFilterMatchesFallback({
        rules: spec.rules,
        signal
      }) as LooseRecord;
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

  function getCachedRequestSpecResult(spec, context) {
    const requestCacheKey = buildFilterRequestCacheKey(spec, context.coverageHash, context.zoomBucket);
    const cached = filterCache.getCachedFilterMatches(requestCacheKey) as LooseRecord | null;
    if (!cached) return null;
    return {
      spec,
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

  async function fetchMatchesBatchForRequestSpecs(specs, context, signal) {
    const batchPayload = await filterFetcher.fetchFilterMatchesBatchPrimary({
      bbox: context.coverageWindow,
      zoomBucket: context.zoomBucket,
      requestSpecs: specs,
      signal
    }) as LooseRecord;
    const itemsById = new Map(
      (Array.isArray(batchPayload?.items) ? batchPayload.items : [])
        .map((item) => [String(item?.id || ''), item])
    );

    return specs.map((spec) => {
      const payload = itemsById.get(String(spec.id || '')) || {
        matchedKeys: [],
        matchedFeatureIds: [],
        meta: {
          rulesHash: spec.rulesHash,
          bboxHash: context.bboxHash,
          truncated: false,
          elapsedMs: Number(batchPayload?.meta?.elapsedMs || 0),
          cacheHit: Boolean(batchPayload?.meta?.cacheHit)
        }
      };
      const normalizedPayload = {
        ...payload,
        meta: {
          ...(payload?.meta || {}),
          cacheHit: Boolean(payload?.meta?.cacheHit)
        }
      };
      filterCache.putCachedFilterMatches(
        buildFilterRequestCacheKey(spec, context.coverageHash, context.zoomBucket),
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

  function schedulePrefetch(context, token) {
    if (!prefetchEnabled || !context?.coverageWindow || !context?.rulesHash) return;
    if (!Array.isArray(context?.requestSpecs) || context.requestSpecs.length !== 1) return;
    const spec = context.requestSpecs[0];
    if (!Array.isArray(spec?.rules) || spec.rules.length === 0) return;
    const now = Date.now();
    if ((now - filterLastPrefetchAt) < prefetchMinIntervalMs) return;
    const prefetchBbox = buildPrefetchCoverageWindow(context.coverageWindow);
    if (!prefetchBbox) return;
    const prefetchHash = buildBboxHash(prefetchBbox, 4);
    const prefetchCacheKey = buildFilterRequestCacheKey(spec, prefetchHash, context.zoomBucket);
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
          signal
        }) as LooseRecord;
        if (token !== Number(getLatestFilterToken?.() ?? token)) return;
        filterCache.putCachedFilterMatches(prefetchCacheKey, {
          ...payload,
          meta: {
            ...(payload?.meta || {}),
            cacheHit: Boolean(payload?.meta?.cacheHit)
          }
        });
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
