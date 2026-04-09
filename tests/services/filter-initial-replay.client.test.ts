const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const test = require('node:test');

async function loadFilterInitialReplayModule() {
  const modulePath = path.join(process.cwd(), 'frontend', 'src', 'lib', 'services', 'map', 'filter-initial-replay.ts');
  return import(pathToFileURL(modulePath).href);
}

test('resolveInitialFilterReplayAction refreshes once idle when filters exist but no paint has happened yet', async () => {
  const { resolveInitialFilterReplayAction } = await loadFilterInitialReplayModule();
  assert.equal(resolveInitialFilterReplayAction({ hasFilters: true, phase: 'idle', paintCalls: 0 }), 'refresh');
});

test('hasInitialFilterReplayTargetReady skips contour-layer waiting below marker zoom', async () => {
  const { hasInitialFilterReplayTargetReady } = await loadFilterInitialReplayModule();
  assert.equal(hasInitialFilterReplayTargetReady({ zoom: 12.5, hasHighlightLayers: false }), true);
  assert.equal(hasInitialFilterReplayTargetReady({ zoom: 13, hasHighlightLayers: false }), false);
  assert.equal(hasInitialFilterReplayTargetReady({ zoom: 13, hasHighlightLayers: true }), true);
});

test('resolveInitialFilterReplayAction refreshes again while the first optimistic pass still has no paint', async () => {
  const { resolveInitialFilterReplayAction } = await loadFilterInitialReplayModule();
  assert.equal(resolveInitialFilterReplayAction({ hasFilters: true, phase: 'optimistic', paintCalls: 0 }), 'refresh');
});

test('resolveInitialFilterReplayAction reapplies once paint already happened', async () => {
  const { resolveInitialFilterReplayAction } = await loadFilterInitialReplayModule();
  assert.equal(resolveInitialFilterReplayAction({ hasFilters: false, phase: 'idle', paintCalls: 0 }), 'none');
  assert.equal(resolveInitialFilterReplayAction({ hasFilters: true, phase: 'optimistic', paintCalls: 3 }), 'reapply');
  assert.equal(resolveInitialFilterReplayAction({ hasFilters: true, phase: 'authoritative', paintCalls: 0 }), 'reapply');
});
