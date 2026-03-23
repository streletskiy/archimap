import {
  computeRulesHash,
  isHeavyRule,
  normalizeFilterLayers,
  normalizeFilterRules
} from '$lib/components/map/filter-pipeline-utils';
import type {
  FilterWorkerPrepareRequest,
  FilterWorkerPrepareResponse
} from '../services/map/filter-types.js';

self.onmessage = (event: MessageEvent<FilterWorkerPrepareRequest>) => {
  // Chromium exposes an empty origin for same-origin messages sent to dedicated workers.
  const trustedOrigin = self.location?.origin ?? '';
  const messageOrigin =
    event.origin ||
    // For some browsers/environments, origin may be empty for same-origin dedicated workers.
    ((event.currentTarget as { location?: { origin?: string } } | null)?.location?.origin ?? '');
  if (messageOrigin !== trustedOrigin) return;

  const payload = event.data;
  const type = String(payload.type || '');
  const requestId = String(payload.requestId || '');

  if (type === 'prepare-rules') {
    if (Array.isArray(payload.layers)) {
      const normalizedLayers = normalizeFilterLayers(payload.layers);
      if (normalizedLayers.invalidReason) {
        self.postMessage({
          type: 'prepare-rules-result',
          requestId,
          ok: false,
          invalidReason: normalizedLayers.invalidReason
        } satisfies FilterWorkerPrepareResponse);
        return;
      }
      const layers = normalizedLayers.layers;
      self.postMessage({
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
      } satisfies FilterWorkerPrepareResponse);
      return;
    }

    const normalized = normalizeFilterRules(payload.rules);
    if (normalized.invalidReason) {
      self.postMessage({
        type: 'prepare-rules-result',
        requestId,
        ok: false,
        invalidReason: normalized.invalidReason
      } satisfies FilterWorkerPrepareResponse);
      return;
    }
    const rules = normalized.rules;
    self.postMessage({
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
    } satisfies FilterWorkerPrepareResponse);
    return;
  }
};
