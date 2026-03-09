import {
  buildFeatureStateEntryDiffPlan,
  buildFeatureStateDiffPlan,
  computeRulesHash,
  isHeavyRule,
  normalizeFilterLayers,
  normalizeFilterRules,
  toFeatureIdSetFromMatches
} from '$lib/components/map/filter-pipeline-utils';

function isTrustedMessageOrigin(event) {
  try {
    const selfOrigin = String(self.location?.origin || '');
    if (!selfOrigin) return false;

    const messageOrigin = String(event?.origin || '');
    if (messageOrigin) {
      return messageOrigin === selfOrigin;
    }

    const targetOrigin = String(event?.currentTarget?.location?.origin || '');
    return Boolean(targetOrigin) && targetOrigin === selfOrigin;
  } catch {
    return false;
  }
}

self.onmessage = (event) => {
  if (!isTrustedMessageOrigin(event)) return;

  const payload = event?.data || {};
  const type = String(payload?.type || '');
  const requestId = String(payload?.requestId || '');

  if (type === 'prepare-rules') {
    if (Array.isArray(payload.layers)) {
      const normalizedLayers = normalizeFilterLayers(payload.layers);
      if (normalizedLayers.invalidReason) {
        self.postMessage({
          type: 'prepare-rules-result',
          requestId,
          ok: false,
          invalidReason: normalizedLayers.invalidReason
        });
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
      });
      return;
    }

    const normalized = normalizeFilterRules(payload.rules);
    if (normalized.invalidReason) {
      self.postMessage({
        type: 'prepare-rules-result',
        requestId,
        ok: false,
        invalidReason: normalized.invalidReason
      });
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
          mode: 'and',
          rules
        }]
        : [],
      rulesHash: computeRulesHash(rules),
      heavy: rules.some((rule) => isHeavyRule(rule))
    });
    return;
  }

  if (type === 'build-apply-plan') {
    if (Array.isArray(payload.prevEntries) || Array.isArray(payload.nextEntries)) {
      const plan = buildFeatureStateEntryDiffPlan(payload.prevEntries || [], payload.nextEntries || []);
      self.postMessage({
        type: 'build-apply-plan-result',
        requestId,
        ok: true,
        ...plan
      });
      return;
    }

    const nextSet = toFeatureIdSetFromMatches(payload.matches || {});
    const nextFeatureIds = [...nextSet];
    const plan = buildFeatureStateDiffPlan(payload.prevFeatureIds || [], nextFeatureIds);
    self.postMessage({
      type: 'build-apply-plan-result',
      requestId,
      ok: true,
      ...plan
    });
  }
};
