import type { Region, RegionUpstreamStatus } from '$shared/types';

const UPSTREAM_CACHE_TTL_MS = 15 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 15 * 1000;

function createUpstreamDomain(context: LooseRecord = {}) {
  const { ensureBootstrapped, getRegionById, fetchImpl, now, toIsoOrNull, regionCatalog, extractResolver, state } =
    context;

  function normalizeIsoTimestamp(value) {
    return toIsoOrNull(value);
  }

  function createRegionUpstreamState(
    overrides: Partial<
      Pick<
        Region,
        | 'latestSourceDataUpdatedAt'
        | 'sourceDataUpdatedAt'
        | 'upstreamCheckedAt'
        | 'upstreamStatus'
        | 'upstreamError'
        | 'updateAvailable'
      >
    > = {}
  ) {
    return {
      latestSourceDataUpdatedAt: null,
      upstreamCheckedAt: null,
      upstreamStatus: 'unknown' as RegionUpstreamStatus,
      upstreamError: null,
      updateAvailable: false,
      ...overrides
    };
  }

  function getCachedValue(cacheMap, key, forceRefresh = false) {
    if (forceRefresh) return null;
    const entry = cacheMap.get(key);
    if (!entry) return null;
    if (Number(entry.expiresAt || 0) <= Date.now()) {
      cacheMap.delete(key);
      return null;
    }
    return entry.promise || null;
  }

  function setCachedPromise(cacheMap, key, ttlMs, promise) {
    cacheMap.set(key, {
      promise,
      expiresAt: Date.now() + ttlMs
    });
    return promise;
  }

  function parseOsmfrStateTimestamp(text) {
    const raw = String(text || '');
    const match = raw.match(/^\s*timestamp=(.+?)\s*$/m);
    if (!match) return null;
    return normalizeIsoTimestamp(match[1].replace(/\\:/g, ':'));
  }

  async function fetchWithTimeout(input, init: LooseRecord = {}) {
    if (typeof fetchImpl !== 'function') {
      throw new Error('fetch is not available');
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      return await fetchImpl(input, {
        ...init,
        redirect: 'follow',
        signal: controller.signal
      });
    } finally {
      clearTimeout(timer);
    }
  }

  async function fetchHeadTimestamp(downloadUrl) {
    const response = await fetchWithTimeout(downloadUrl, {
      method: 'HEAD'
    });
    if (!response?.ok) {
      throw new Error(`HTTP ${Number(response?.status || 0) || 0}`);
    }
    return normalizeIsoTimestamp(response.headers?.get?.('last-modified'));
  }

  async function fetchOsmfrStateTimestamp(stateUrl) {
    const normalizedStateUrl = String(stateUrl || '').trim();
    if (!normalizedStateUrl) return null;
    if (!stateUrl) return null;
    const response = await fetchWithTimeout(normalizedStateUrl);
    if (!response?.ok) {
      throw new Error(`HTTP ${Number(response?.status || 0) || 0}`);
    }
    return parseOsmfrStateTimestamp(await response.text());
  }

  async function fetchLatestSourceMetadata(
    region: Pick<Region, 'extractSource' | 'extractId'>,
    options: LooseRecord = {}
  ) {
    const extractSource = String(region?.extractSource || '').trim();
    const extractId = String(region?.extractId || '').trim();
    if (!extractSource || !extractId) {
      return createRegionUpstreamState();
    }

    const cacheKey = `${extractSource}:${extractId}`;
    const cacheMap = state?.upstreamMetadataByKey;
    if (cacheMap instanceof Map) {
      const cached = getCachedValue(cacheMap, cacheKey, options.forceRefresh === true);
      if (cached) {
        return await cached;
      }
    }

    const task = (async () => {
      const checkedAt = normalizeIsoTimestamp(now()) || new Date().toISOString();
      let candidate = regionCatalog?.findEntry?.(extractSource, extractId) || null;
      if (!candidate && extractResolver && typeof extractResolver.resolveExactExtract === 'function') {
        try {
          const resolved = await extractResolver.resolveExactExtract(extractId, {
            source: extractSource
          });
          candidate = resolved?.candidate || null;
        } catch {
          candidate = null;
        }
      }
      const downloadUrl = String(candidate?.downloadUrl || '').trim();
      if (!downloadUrl) {
        return createRegionUpstreamState({
          upstreamCheckedAt: checkedAt,
          upstreamStatus: 'error',
          upstreamError: 'Curated extract download URL is unavailable'
        });
      }

      try {
        let latestSourceDataUpdatedAt = null;
        if (extractSource === 'osmfr') {
          latestSourceDataUpdatedAt = await fetchOsmfrStateTimestamp(candidate?.stateUrl);
        }
        if (!latestSourceDataUpdatedAt) {
          latestSourceDataUpdatedAt = await fetchHeadTimestamp(downloadUrl);
        }

        return createRegionUpstreamState({
          upstreamCheckedAt: checkedAt,
          latestSourceDataUpdatedAt
        });
      } catch (error) {
        return createRegionUpstreamState({
          upstreamCheckedAt: checkedAt,
          upstreamStatus: 'error',
          upstreamError: `Failed to check upstream source: ${String(error?.message || error || 'Unknown error')}`
        });
      }
    })();

    if (cacheMap instanceof Map) {
      setCachedPromise(cacheMap, cacheKey, UPSTREAM_CACHE_TTL_MS, task);
    }

    return await task;
  }

  function compareSourceTimestamps(left, right) {
    const leftTs = Date.parse(String(left || ''));
    const rightTs = Date.parse(String(right || ''));
    if (!Number.isFinite(leftTs) || !Number.isFinite(rightTs)) return 0;
    if (leftTs > rightTs) return 1;
    if (leftTs < rightTs) return -1;
    return 0;
  }

  function mergeRegionWithUpstreamState(region: Region, upstreamState: LooseRecord = {}): Region {
    const latestSourceDataUpdatedAt = normalizeIsoTimestamp(upstreamState.latestSourceDataUpdatedAt);
    const sourceDataUpdatedAt = normalizeIsoTimestamp(region?.sourceDataUpdatedAt);
    const regionHasSuccessfulSync = Boolean(region?.lastSuccessfulSyncAt);
    let upstreamStatus: RegionUpstreamStatus = 'unknown';
    let updateAvailable = false;

    if (upstreamState?.upstreamStatus === 'error') {
      upstreamStatus = 'error';
    } else if (latestSourceDataUpdatedAt && regionHasSuccessfulSync && sourceDataUpdatedAt) {
      if (compareSourceTimestamps(latestSourceDataUpdatedAt, sourceDataUpdatedAt) > 0) {
        upstreamStatus = 'update_available';
        updateAvailable = true;
      } else {
        upstreamStatus = 'up_to_date';
      }
    }

    return {
      ...region,
      sourceDataUpdatedAt,
      latestSourceDataUpdatedAt,
      upstreamCheckedAt: normalizeIsoTimestamp(upstreamState.upstreamCheckedAt),
      upstreamStatus,
      upstreamError: upstreamState.upstreamError ? String(upstreamState.upstreamError) : null,
      updateAvailable
    };
  }

  async function getRegionUpstreamState(regionOrId, options: LooseRecord = {}) {
    await ensureBootstrapped();
    const region = typeof regionOrId === 'object' && regionOrId ? regionOrId : await getRegionById(regionOrId);
    if (!region) {
      return createRegionUpstreamState();
    }
    if (!region.extractSource || !region.extractId || region.extractResolutionStatus !== 'resolved') {
      return {
        ...region,
        ...createRegionUpstreamState({
          sourceDataUpdatedAt: normalizeIsoTimestamp(region?.sourceDataUpdatedAt)
        })
      };
    }

    return mergeRegionWithUpstreamState(region, await fetchLatestSourceMetadata(region, options));
  }

  async function enrichRegionsWithUpstreamState(regions: Region[] = [], options: LooseRecord = {}) {
    const items = Array.isArray(regions) ? regions : [];
    if (items.length === 0) return [];
    return await Promise.all(items.map((region) => getRegionUpstreamState(region, options)));
  }

  return {
    enrichRegionsWithUpstreamState,
    getRegionUpstreamState
  };
}

module.exports = {
  createUpstreamDomain
};
