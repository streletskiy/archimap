import {
  EMPTY_LAYER_FILTER,
  hashFilterExpression
} from '../../components/map/filter-highlight-utils.js';
import {
  computeRulesHash,
  normalizeFilterLayers,
  normalizeFilterRules,
  sortFilterLayersByPriority,
  toFeatureIdSetFromMatches
} from '../../components/map/filter-pipeline-utils.js';
import { FILTER_LAYER_BASE_COLOR } from '../../constants/filter-presets.js';
import type {
  FilterPreparedRequestPlan,
  FilterResolvedLayerPayload
} from './filter-types.js';

export { EMPTY_LAYER_FILTER, hashFilterExpression };

export function isLayerInput(input) {
  return Array.isArray(input) && input.some((item) => (
    Array.isArray(item?.rules) ||
    item?.mode != null ||
    item?.color != null ||
    item?.priority != null ||
    item?.id != null
  ));
}

export function normalizeFilterInputLayers(input) {
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

export function prepareFilterRequestPlan(input): { ok: false; invalidReason: string } | ({ ok: true } & FilterPreparedRequestPlan) {
  const normalizedLayers = normalizeFilterInputLayers(input);
  if (normalizedLayers.invalidReason) {
    return {
      ok: false,
      invalidReason: normalizedLayers.invalidReason
    };
  }

  const preparedRequests = buildFilterRequestSpecs(normalizedLayers.layers);
  return {
    ok: true,
    layers: preparedRequests.layers,
    combinedGroup: preparedRequests.combinedGroup,
    requestSpecs: preparedRequests.requestSpecs,
    hasStandaloneLayers: preparedRequests.hasStandaloneLayers,
    rulesHash: computeRulesHash(preparedRequests.layers),
    heavy: preparedRequests.requestSpecs.some((spec) => (
      Array.isArray(spec?.rules) && spec.rules.some((rule) => String(rule?.op || '') === 'contains')
    ))
  };
}

export function buildFilterRequestCacheKey(spec, coverageHash, zoomBucket) {
  return `request:${spec.id}:${spec.rulesHash}:${coverageHash}:${zoomBucket}`;
}

export function buildFilterRequestSpecs(layers) {
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

export function buildResolvedLayerPayload({ prepared, payloadsByRequestId, cacheHit = false }): FilterResolvedLayerPayload {
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
    matchedFeatureIds: [...resolvedEntriesById.keys()].sort((left, right) => left - right),
    matchedCount: resolvedEntriesById.size,
    meta: {
      rulesHash: String(prepared?.rulesHash || 'fnv1a-0'),
      bboxHash: '',
      coverageHash: String(prepared?.coverageHash || ''),
      coverageWindow: prepared?.coverageWindow || null,
      zoomBucket: Number(prepared?.zoomBucket || 0),
      truncated: payloads.some((payload) => Boolean(payload?.meta?.truncated)),
      elapsedMs: payloads.reduce((sum, payload) => sum + Number(payload?.meta?.elapsedMs || 0), 0),
      cacheHit
    }
  };
}
