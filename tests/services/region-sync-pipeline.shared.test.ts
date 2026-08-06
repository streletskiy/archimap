const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const test = require('node:test');

async function loadPipelineModule() {
  const modulePath = path.join(process.cwd(), 'src', 'lib', 'shared', 'region-sync-pipeline.ts');
  return import(pathToFileURL(modulePath).href);
}

test('managed region sync pipeline keeps apply before export', async () => {
  const {
    REGION_SYNC_PHASE_ORDER,
    REGION_SYNC_PIPELINE_STAGES,
    normalizeRegionSyncPhase,
    normalizeRegionSyncStage
  } = await loadPipelineModule();

  assert.deepEqual(REGION_SYNC_PIPELINE_STAGES, [
    'download',
    'extract',
    'apply',
    'export',
    'build',
    'publish',
    'followup'
  ]);
  assert.deepEqual(REGION_SYNC_PHASE_ORDER, [
    'download',
    'extract',
    'apply',
    'export',
    'build',
    'followup'
  ]);
  assert.equal(normalizeRegionSyncStage('tile_join'), 'build');
  assert.equal(normalizeRegionSyncStage('unknown-stage'), '');
  assert.equal(normalizeRegionSyncPhase('publish'), 'build');
  assert.equal(normalizeRegionSyncPhase('apply'), 'apply');
});
