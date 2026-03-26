import {
  computeRulesHash,
  isHeavyRule,
  normalizeFilterLayers,
  normalizeFilterRules
} from '$lib/components/map/filter-pipeline-utils';
import {
  buildResolvedLayerPayload,
  prepareFilterRequestPlan
} from '$lib/services/map/filter-request-planner';
import type {
  FilterWorkerBuildRequestPlanRequest,
  FilterWorkerBuildRequestPlanResponse,
  FilterWorkerBuildResolvedPayloadRequest,
  FilterWorkerBuildResolvedPayloadResponse,
  FilterWorkerPrepareRequest,
  FilterWorkerPrepareResponse
} from '$lib/services/map/filter-types';

function postPrepareRulesResult(response: FilterWorkerPrepareResponse) {
  self.postMessage(response);
}

function postBuildRequestPlanResult(response: FilterWorkerBuildRequestPlanResponse) {
  self.postMessage(response);
}

function postBuildResolvedPayloadResult(response: FilterWorkerBuildResolvedPayloadResponse) {
  self.postMessage(response);
}

function handlePrepareRulesRequest(payload: FilterWorkerPrepareRequest, requestId: string) {
  if (Array.isArray(payload.layers)) {
    const normalizedLayers = normalizeFilterLayers(payload.layers);
    if (normalizedLayers.invalidReason) {
      postPrepareRulesResult({
        type: 'prepare-rules-result',
        requestId,
        ok: false,
        invalidReason: normalizedLayers.invalidReason
      });
      return;
    }
    const layers = normalizedLayers.layers;
    postPrepareRulesResult({
      type: 'prepare-rules-result',
      requestId,
      ok: true,
      layers,
      rules: layers.flatMap((layer) => layer.rules),
      rulesHash: computeRulesHash(layers),
      heavy: layers.some((layer) => layer.rules.some((rule) => isHeavyRule(rule))),
      layerResults: layers.map((layer) => ({
        id: layer.id,
        ok: true,
        rules: layer.rules,
        heavy: layer.rules.some((rule) => isHeavyRule(rule))
      }))
    });
    return;
  }

  const normalized = normalizeFilterRules(payload.rules);
  if (normalized.invalidReason) {
    postPrepareRulesResult({
      type: 'prepare-rules-result',
      requestId,
      ok: false,
      invalidReason: normalized.invalidReason
    });
    return;
  }

  const rules = normalized.rules;
  postPrepareRulesResult({
    type: 'prepare-rules-result',
    requestId,
    ok: true,
    rules,
    layers: rules.length > 0
      ? [{
          id: 'compat-filter-layer',
          color: '#f59e0b',
          priority: 0,
          mode: 'and' as const,
          rules
        }]
      : [],
    rulesHash: computeRulesHash(rules),
    heavy: rules.some((rule) => isHeavyRule(rule))
  });
}

function handleBuildRequestPlanRequest(
  payload: FilterWorkerBuildRequestPlanRequest,
  requestId: string
) {
  const prepared = prepareFilterRequestPlan(payload.layers ?? payload.rules);
  if (prepared.ok === false) {
    postBuildRequestPlanResult({
      type: 'build-request-plan-result',
      requestId,
      ok: false,
      invalidReason: prepared.invalidReason
    });
    return;
  }

  postBuildRequestPlanResult({
    type: 'build-request-plan-result',
    requestId,
    ok: true,
    layers: prepared.layers,
    requestSpecs: prepared.requestSpecs,
    combinedGroup: prepared.combinedGroup,
    hasStandaloneLayers: prepared.hasStandaloneLayers,
    rulesHash: prepared.rulesHash,
    heavy: prepared.heavy
  });
}

function handleBuildResolvedPayloadRequest(
  payload: FilterWorkerBuildResolvedPayloadRequest,
  requestId: string
) {
  if (!payload?.prepared || !Array.isArray(payload.payloads)) {
    postBuildResolvedPayloadResult({
      type: 'build-resolved-payload-result',
      requestId,
      ok: false,
      error: 'Invalid resolved payload request'
    });
    return;
  }

  const payloadsByRequestId = new Map(
    payload.payloads
      .map((item) => [String(item?.requestId || '').trim(), item?.payload] as const)
      .filter(([payloadRequestId]) => Boolean(payloadRequestId))
  );

  const resolved = buildResolvedLayerPayload({
    prepared: payload.prepared,
    payloadsByRequestId,
    cacheHit: Boolean(payload.cacheHit)
  });

  postBuildResolvedPayloadResult({
    type: 'build-resolved-payload-result',
    requestId,
    ok: true,
    ...resolved
  });
}

self.onmessage = (
  event: MessageEvent<
    | FilterWorkerPrepareRequest
    | FilterWorkerBuildRequestPlanRequest
    | FilterWorkerBuildResolvedPayloadRequest
  >
) => {
  // Chromium exposes an empty origin for same-origin messages sent to dedicated workers.
  const trustedOrigin = self.location?.origin ?? '';
  const messageOrigin =
    event.origin ||
    // For some browsers/environments, origin may be empty for same-origin dedicated workers.
    ((event.currentTarget as { location?: { origin?: string } } | null)?.location?.origin ?? '');
  if (messageOrigin !== trustedOrigin) return;

  const payload = event.data;
  const requestId = String(payload.requestId || '');

  if (payload.type === 'prepare-rules') {
    handlePrepareRulesRequest(payload, requestId);
    return;
  }

  if (payload.type === 'build-request-plan') {
    handleBuildRequestPlanRequest(payload, requestId);
    return;
  }

  if (payload.type === 'build-resolved-payload') {
    handleBuildResolvedPayloadRequest(payload, requestId);
  }
};
