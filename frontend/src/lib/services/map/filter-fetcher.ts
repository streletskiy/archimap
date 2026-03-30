import { apiJson } from '../http.js';
import { matchesFilterRules } from '../../components/map/filter-pipeline-utils.js';
import { encodeOsmFeatureId, parseOsmKey, resolveFeatureIdentity } from './filter-utils.js';
import type {
  FilterBuildingSourceConfig,
  FilterMapLike,
  FilterMatchPayload,
  FilterRequestSpec,
  FilterRule,
  LayerIdsSnapshot
} from './filter-types.js';

type FilterMatchBatchItem = FilterMatchPayload & {
  id?: string;
};

type FilterMatchBatchResponse = {
  items?: FilterMatchBatchItem[];
  meta?: {
    elapsedMs?: number;
    cacheHit?: boolean;
  };
};

type FilterFetcherOptions = {
  resolveMap: () => FilterMapLike | null | undefined;
  resolveLayerIds: () => LayerIdsSnapshot;
  resolveBuildingSourceConfigs: () => FilterBuildingSourceConfig[];
  getCurrentRulesHash: () => string;
  getLastViewportHash: () => string;
  matchDefaultLimit: number;
  dataCacheTtlMs: number;
  dataCacheMaxItems: number;
  dataRequestChunkSize: number;
};

type FilterDataItem = Record<string, unknown> & {
  osmKey?: string;
  centerLon?: number;
  centerLat?: number;
};

export function createFilterFetcher({
  resolveMap,
  resolveLayerIds,
  resolveBuildingSourceConfigs,
  getCurrentRulesHash,
  getLastViewportHash,
  matchDefaultLimit,
  dataCacheTtlMs,
  dataCacheMaxItems,
  dataRequestChunkSize
}: FilterFetcherOptions = {} as FilterFetcherOptions) {
  let filterDataByOsmKeyCache = new Map<string, { cachedAt: number; item: FilterDataItem }>();

  function getVisibleBuildingOsmKeys() {
    const currentMap = resolveMap();
    if (!currentMap) return [];
    const layerIds = resolveLayerIds();
    const buildingLayerIds = [
      ...layerIds.buildingFillLayerIds,
      ...layerIds.buildingLineLayerIds,
      ...layerIds.buildingPartFillLayerIds,
      ...layerIds.buildingPartLineLayerIds
    ];
    if (buildingLayerIds.length === 0) return [];
    const features = currentMap.queryRenderedFeatures({ layers: buildingLayerIds });
    const keys = new Set<string>();
    for (const feature of Array.isArray(features) ? features : []) {
      const identity = resolveFeatureIdentity(feature);
      if (!identity?.osmType || !Number.isInteger(identity?.osmId)) continue;
      keys.add(`${identity.osmType}/${identity.osmId}`);
    }
    return [...keys];
  }

  function getLoadedSourceBuildingOsmKeys() {
    const currentMap = resolveMap();
    if (!currentMap) return [];
    const keys = new Set<string>();
    for (const sourceConfig of resolveBuildingSourceConfigs()) {
      if (!sourceConfig?.sourceLayer || !currentMap.getSource(sourceConfig.sourceId)) continue;
      const features = currentMap.querySourceFeatures(sourceConfig.sourceId, {
        sourceLayer: sourceConfig.sourceLayer
      });
      for (const feature of Array.isArray(features) ? features : []) {
        const identity = resolveFeatureIdentity(feature);
        if (!identity?.osmType || !Number.isInteger(identity?.osmId)) continue;
        keys.add(`${identity.osmType}/${identity.osmId}`);
      }
    }
    return [...keys];
  }

  function getFilterCandidateOsmKeys() {
    const renderedKeys = getVisibleBuildingOsmKeys();
    if (renderedKeys.length > 0) return renderedKeys;
    return getLoadedSourceBuildingOsmKeys();
  }

  async function fetchFilterMatchesPrimary({ bbox, zoomBucket, rules, rulesHash, maxResults, renderMode, signal }: {
    bbox: unknown;
    zoomBucket: number;
    rules: FilterRule[];
    rulesHash: string;
    maxResults?: number;
    renderMode?: 'contours' | 'markers';
    signal?: AbortSignal | null;
  }): Promise<FilterMatchPayload> {
    const requestedMaxResults = Number.isFinite(Number(maxResults))
      ? Number(maxResults)
      : matchDefaultLimit;
    return apiJson('/api/buildings/filter-matches', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        bbox,
        zoomBucket,
        renderMode: String(renderMode || 'contours') === 'markers' ? 'markers' : 'contours',
        rules,
        rulesHash,
        maxResults: Math.max(1, Math.trunc(requestedMaxResults))
      }),
      signal
    }) as Promise<FilterMatchPayload>;
  }

  async function fetchFilterMatchesBatchPrimary({ bbox, zoomBucket, requestSpecs, maxResults, renderMode, signal }: {
    bbox: unknown;
    zoomBucket: number;
    requestSpecs: FilterRequestSpec[];
    maxResults?: number;
    renderMode?: 'contours' | 'markers';
    signal?: AbortSignal | null;
  }): Promise<FilterMatchBatchResponse> {
    const requestedMaxResults = Number.isFinite(Number(maxResults))
      ? Number(maxResults)
      : matchDefaultLimit;
    return apiJson('/api/buildings/filter-matches-batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        bbox,
        zoomBucket,
        renderMode: String(renderMode || 'contours') === 'markers' ? 'markers' : 'contours',
        requests: (Array.isArray(requestSpecs) ? requestSpecs : []).map((spec) => ({
          id: String(spec?.id || ''),
          rules: Array.isArray(spec?.rules) ? spec.rules : [],
          rulesHash: String(spec?.rulesHash || ''),
          maxResults: Math.max(1, Math.trunc(requestedMaxResults))
        }))
      }),
      signal
    }) as Promise<FilterMatchBatchResponse>;
  }

  async function fetchFilterDataByOsmKeys(keys: string[], signal?: AbortSignal | null) {
    const normalized = [...new Set((Array.isArray(keys) ? keys : [])
      .map((key) => String(key || '').trim())
      .filter((key) => /^(way|relation)\/\d+$/.test(key))
    )];
    if (normalized.length === 0) return new Map<string, FilterDataItem>();

    const out = new Map<string, FilterDataItem>();
    const missing = [];
    const now = Date.now();
    for (const key of normalized) {
      const cached = filterDataByOsmKeyCache.get(key);
      if (cached && (now - cached.cachedAt) <= dataCacheTtlMs) {
        out.set(key, cached.item);
      } else {
        if (cached) filterDataByOsmKeyCache.delete(key);
        missing.push(key);
      }
    }

    for (let i = 0; i < missing.length; i += dataRequestChunkSize) {
      const chunk = missing.slice(i, i + dataRequestChunkSize);
      const payload = await apiJson('/api/buildings/filter-data', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ keys: chunk }),
        signal
      });
      const items = Array.isArray(payload?.items) ? payload.items : [];
      for (const item of items) {
        const osmKey = String(item?.osmKey || '').trim();
        if (!osmKey) continue;
        filterDataByOsmKeyCache.set(osmKey, {
          cachedAt: Date.now(),
          item
        });
        while (filterDataByOsmKeyCache.size > dataCacheMaxItems) {
          const oldestKey = filterDataByOsmKeyCache.keys().next().value;
          if (!oldestKey) break;
          filterDataByOsmKeyCache.delete(oldestKey);
        }
        out.set(osmKey, item);
      }
    }

    return out;
  }

  async function fetchFilterMatchesFallback({ rules, signal }: {
    rules: FilterRule[];
    signal?: AbortSignal | null;
  }): Promise<FilterMatchPayload> {
    const visibleKeys = getFilterCandidateOsmKeys();
    if (visibleKeys.length === 0) {
      return {
        matchedKeys: [],
        matchedFeatureIds: [],
        meta: {
          rulesHash: getCurrentRulesHash?.() || 'fnv1a-0',
          bboxHash: getLastViewportHash?.() || '',
          truncated: false,
          elapsedMs: 0,
          cacheHit: false
        }
      };
    }

    const byKey = await fetchFilterDataByOsmKeys(visibleKeys, signal);
    const matchedKeys = [];
    const matchedFeatureIds = [];
    const matchedLocations = [];
    for (const key of visibleKeys) {
      const item = byKey.get(key);
      if (!item) continue;
      const ok = matchesFilterRules(item, rules);
      if (!ok) continue;
      matchedKeys.push(key);
      const parsed = parseOsmKey(key);
      if (parsed) {
        const featureId = encodeOsmFeatureId(parsed.osmType, parsed.osmId);
        matchedFeatureIds.push(featureId);
        const lon = Number(item.centerLon);
        const lat = Number(item.centerLat);
        if (Number.isFinite(lon) && Number.isFinite(lat)) {
          matchedLocations.push({
            id: featureId,
            lon,
            lat,
            count: 1,
            osmKey: key
          });
        }
      }
      if (matchedKeys.length >= matchDefaultLimit) break;
    }

    return {
      matchedKeys,
      matchedFeatureIds,
      matchedLocations,
      meta: {
        rulesHash: getCurrentRulesHash?.() || 'fnv1a-0',
        bboxHash: getLastViewportHash?.() || '',
        truncated: matchedKeys.length >= matchDefaultLimit,
        elapsedMs: 0,
        cacheHit: false
      }
    };
  }

  function clear() {
    filterDataByOsmKeyCache = new Map();
  }

  return {
    clear,
    fetchFilterDataByOsmKeys,
    fetchFilterMatchesBatchPrimary,
    fetchFilterMatchesFallback,
    fetchFilterMatchesPrimary
  };
}
