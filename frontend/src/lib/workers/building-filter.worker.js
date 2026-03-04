import {
  buildFeatureStateDiffPlan,
  computeRulesHash,
  isHeavyRule,
  normalizeFilterRules,
  toFeatureIdSetFromMatches
} from '$lib/components/map/filter-pipeline-utils';

self.onmessage = (event) => {
  const payload = event?.data || {};
  const type = String(payload?.type || '');
  const requestId = String(payload?.requestId || '');

  if (type === 'prepare-rules') {
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
      rulesHash: computeRulesHash(rules),
      heavy: rules.some((rule) => isHeavyRule(rule))
    });
    return;
  }

  if (type === 'build-apply-plan') {
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
