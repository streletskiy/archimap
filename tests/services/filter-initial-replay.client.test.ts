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

test('resolveInitialFilterReplayAction reapplies when filters exist and paint is still missing after an initial request', async () => {
  const { resolveInitialFilterReplayAction } = await loadFilterInitialReplayModule();
  assert.equal(resolveInitialFilterReplayAction({ hasFilters: true, phase: 'authoritative', paintCalls: 0 }), 'reapply');
});

test('resolveInitialFilterReplayAction ignores paint-call history for initial replay decisions', async () => {
  const { resolveInitialFilterReplayAction } = await loadFilterInitialReplayModule();
  assert.equal(resolveInitialFilterReplayAction({ hasFilters: false, phase: 'idle', paintCalls: 0 }), 'none');
  assert.equal(resolveInitialFilterReplayAction({ hasFilters: true, phase: 'authoritative', paintCalls: 3 }), 'reapply');
});
