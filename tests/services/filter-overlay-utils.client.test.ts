const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const test = require('node:test');

async function loadFilterOverlayUtils() {
  const modulePath = path.join(process.cwd(), 'frontend', 'src', 'lib', 'services', 'map', 'filter-overlay-utils.ts');
  return import(pathToFileURL(modulePath).href);
}

test('filter overlay stays quiet at contour zooms and remains visible below zoom 13', async () => {
  const {
    getFilterApplyOverlayState,
    shouldShowFilterApplyOverlay,
    shouldShowFilterRefiningMessage
  } = await loadFilterOverlayUtils();

  const busyState = {
    statusCode: 'refining',
    phase: 'optimistic'
  };
  const runtime = {
    updatedAt: Date.now() - 1000
  };

  assert.equal(shouldShowFilterApplyOverlay(busyState, 12.5), true);
  assert.equal(shouldShowFilterApplyOverlay(busyState, 13), false);
  assert.equal(shouldShowFilterRefiningMessage('refining', 12.5), true);
  assert.equal(shouldShowFilterRefiningMessage('refining', 13), false);

  const active = getFilterApplyOverlayState(busyState, runtime, Date.now(), 12.5);
  assert.equal(active.visible, true);
  assert.equal(active.progress > 20, true);

  const quiet = getFilterApplyOverlayState(busyState, runtime, Date.now(), 13);
  assert.equal(quiet.visible, false);
  assert.equal(quiet.progress, 0);
});
