import { apiJson } from '../http.js';
import { matchesFilterRules } from '../../components/map/filter-pipeline-utils.js';
import { encodeOsmFeatureId, parseOsmKey, resolveFeatureIdentity } from './filter-utils.js';

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
}: LooseRecord = {}) {
  let filterDataByOsmKeyCache = new Map();

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
    const keys = new Set();
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
    const keys = new Set();
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

  async function fetchFilterMatchesPrimary({ bbox, zoomBucket, rules, rulesHash, signal }) {
    return apiJson('/api/buildings/filter-matches', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        bbox,
        zoomBucket,
        rules,
        rulesHash,
        maxResults: matchDefaultLimit
      }),
      signal
    });
  }

  async function fetchFilterMatchesBatchPrimary({ bbox, zoomBucket, requestSpecs, signal }) {
    return apiJson('/api/buildings/filter-matches-batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        bbox,
        zoomBucket,
        requests: (Array.isArray(requestSpecs) ? requestSpecs : []).map((spec) => ({
          id: String(spec?.id || ''),
          rules: Array.isArray(spec?.rules) ? spec.rules : [],
          rulesHash: String(spec?.rulesHash || ''),
          maxResults: matchDefaultLimit
        }))
      }),
      signal
    });
  }

  async function fetchFilterDataByOsmKeys(keys, signal) {
    const normalized = [...new Set((Array.isArray(keys) ? keys : [])
      .map((key) => String(key || '').trim())
      .filter((key) => /^(way|relation)\/\d+$/.test(key))
    )];
    if (normalized.length === 0) return new Map();

    const out = new Map();
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

  async function fetchFilterMatchesFallback({ rules, signal }) {
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
    for (const key of visibleKeys) {
      const item = byKey.get(key);
      if (!item) continue;
      const ok = matchesFilterRules(item, rules);
      if (!ok) continue;
      matchedKeys.push(key);
      const parsed = parseOsmKey(key);
      if (parsed) {
        matchedFeatureIds.push(encodeOsmFeatureId(parsed.osmType, parsed.osmId));
      }
      if (matchedKeys.length >= matchDefaultLimit) break;
    }

    return {
      matchedKeys,
      matchedFeatureIds,
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
