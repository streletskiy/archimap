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

test('expandBboxWithMargin builds coverage window around viewport', async () => {
  const { expandBboxWithMargin } = await loadFilterPipelineUtils();
  const windowBbox = expandBboxWithMargin({
    west: 10,
    south: 20,
    east: 14,
    north: 26
  }, 0.25);
  assert.deepEqual(windowBbox, {
    west: 9,
    south: 18.5,
    east: 15,
    north: 27.5
  });
});

test('isViewportInsideBbox returns true only when viewport is fully covered', async () => {
  const { isViewportInsideBbox } = await loadFilterPipelineUtils();
  const coverage = {
    west: 0,
    south: 0,
    east: 10,
    north: 10
  };
  assert.equal(isViewportInsideBbox({ west: 1, south: 1, east: 9, north: 9 }, coverage), true);
  assert.equal(isViewportInsideBbox({ west: -0.01, south: 1, east: 9, north: 9 }, coverage), false);
  assert.equal(isViewportInsideBbox({ west: 1, south: 1, east: 10.1, north: 9 }, coverage), false);
});

test('getAdaptiveCoverageMarginRatio adapts by last match count', async () => {
  const { getAdaptiveCoverageMarginRatio } = await loadFilterPipelineUtils();
  assert.equal(getAdaptiveCoverageMarginRatio({ lastCount: 0, defaultLimit: 12000 }), 0.35);
  assert.equal(getAdaptiveCoverageMarginRatio({ lastCount: 12000, defaultLimit: 12000 }), 0.2);
  const mid = getAdaptiveCoverageMarginRatio({ lastCount: 6000, defaultLimit: 12000 });
  assert.equal(mid > 0.2 && mid < 0.35, true);
});

test('coverage window hash changes when viewport exits active window', async () => {
  const { buildBboxHash, expandBboxWithMargin, isViewportInsideBbox } = await loadFilterPipelineUtils();
  const viewportA = { west: 30, south: 40, east: 31, north: 41 };
  const windowA = expandBboxWithMargin(viewportA, 0.3);
  const viewportInside = { west: 30.1, south: 40.1, east: 30.9, north: 40.9 };
  const viewportOutside = { west: 31.2, south: 40.2, east: 32.1, north: 41.1 };
  assert.equal(isViewportInsideBbox(viewportInside, windowA), true);
  assert.equal(isViewportInsideBbox(viewportOutside, windowA), false);
  const windowB = expandBboxWithMargin(viewportOutside, 0.3);
  assert.notEqual(buildBboxHash(windowA, 4), buildBboxHash(windowB, 4));
});
