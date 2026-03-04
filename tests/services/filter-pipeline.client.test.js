const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const test = require('node:test');

async function loadFilterPipelineUtils() {
  const modulePath = path.join(process.cwd(), 'frontend', 'src', 'lib', 'components', 'map', 'filter-pipeline-utils.js');
  return import(pathToFileURL(modulePath).href);
}

test('computeRulesHash is stable for normalized rules', async () => {
  const { normalizeFilterRules, computeRulesHash } = await loadFilterPipelineUtils();
  const normalizedA = normalizeFilterRules([
    { key: 'name', op: 'contains', value: 'House' },
    { key: 'levels', op: 'equals', value: '5' }
  ]);
  const normalizedB = normalizeFilterRules([
    { key: 'name', op: 'contains', value: 'House' },
    { key: 'levels', op: 'equals', value: '5' }
  ]);
  assert.equal(normalizedA.invalidReason, '');
  assert.equal(normalizedB.invalidReason, '');
  assert.equal(computeRulesHash(normalizedA.rules), computeRulesHash(normalizedB.rules));
});

test('normalizeFilterRules validates operators and trims values', async () => {
  const { normalizeFilterRules } = await loadFilterPipelineUtils();
  const ok = normalizeFilterRules([{ key: ' name ', op: 'starts_with', value: '  Arc ' }]);
  assert.equal(ok.invalidReason, '');
  assert.deepEqual(ok.rules[0], {
    key: 'name',
    op: 'starts_with',
    value: 'Arc',
    valueNormalized: 'arc'
  });

  const bad = normalizeFilterRules([{ key: 'name', op: 'regex', value: '.*' }]);
  assert.match(String(bad.invalidReason || ''), /Invalid filter operator/);
});

test('buildFeatureStateDiffPlan returns only changed ids', async () => {
  const { buildFeatureStateDiffPlan } = await loadFilterPipelineUtils();
  const plan = buildFeatureStateDiffPlan([2, 4, 6], [4, 6, 8, 10]);
  assert.deepEqual(plan.toDisable.sort((a, b) => a - b), [2]);
  assert.deepEqual(plan.toEnable.sort((a, b) => a - b), [8, 10]);
  assert.equal(plan.total, 4);
});
