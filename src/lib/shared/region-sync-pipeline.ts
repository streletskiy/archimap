export const REGION_SYNC_PIPELINE_STAGES = [
  'download',
  'extract',
  'apply',
  'export',
  'build',
  'publish',
  'followup'
] as const;

export const REGION_SYNC_PHASE_ORDER = [
  'download',
  'extract',
  'apply',
  'export',
  'build',
  'followup'
] as const;

const REGION_SYNC_PIPELINE_STAGE_SET = new Set<string>(REGION_SYNC_PIPELINE_STAGES);
const REGION_SYNC_PHASE_SET = new Set<string>(REGION_SYNC_PHASE_ORDER);

export function normalizeRegionSyncStage(stage: unknown) {
  const code = String(stage || '')
    .trim()
    .toLowerCase();
  if (!code) return '';
  if (code === 'tile_join') return 'build';
  if (REGION_SYNC_PIPELINE_STAGE_SET.has(code)) return code;
  return '';
}

export function normalizeRegionSyncPhase(stage: unknown) {
  const code = String(stage || '')
    .trim()
    .toLowerCase();
  if (!code) return '';
  if (code === 'publish' || code === 'tile_join') return 'build';
  if (REGION_SYNC_PHASE_SET.has(code)) return code;
  return '';
}
