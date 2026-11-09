const path = require('node:path');
const { createWorkspace, removeWorkspace } = require('./common');
const { buildRegionTileSignature, canReuseRegionArchive, canPatchRegionArchive, publishRegionTiles, readRegionTileState } = require('./tile-state');
const { buildTilePatchPlan, DEFAULT_MAX_DIRTY_TILES } = require('./tile-patch-plan');
const { exportRegionMembersToGeojsonNdjson } = require('./region-db');
const { buildPmtilesFromGeojson } = require('./pmtiles-builder');
const { usesPlanetilerLocalIo } = require('./planetiler');

function planRegionTilePatch(region, dirtyBounds) {
  const options = {
    minZoom: Number(region.pmtilesMinZoom || 13),
    maxZoom: Number(region.pmtilesMaxZoom || 16)
  };
  const batchSize = 256;
  if (dirtyBounds.length <= batchSize) return buildTilePatchPlan({ ...options, dirtyBounds });

  const tileIds = new Set<number>();
  const windows = new Map();
  for (let offset = 0; offset < dirtyBounds.length; offset += batchSize) {
    const plan = buildTilePatchPlan({ ...options, dirtyBounds: dirtyBounds.slice(offset, offset + batchSize) });
    if (plan.mode !== 'incremental') return plan;
    for (const tileId of plan.dirtyTileIds) tileIds.add(tileId);
    if (tileIds.size > DEFAULT_MAX_DIRTY_TILES) return { mode: 'full', reason: 'dirty tile limit exceeded' };
    for (const window of plan.tileWindows) windows.set(JSON.stringify(window), window);
  }
  return {
    mode: 'incremental',
    dirtyTileIds: [...tileIds].sort((a, b) => a - b),
    tileWindows: [...windows.values()]
  };
}

// Shared by normal synchronization and explicit full rebuilds. The source data
// is never changed here; only a successfully published revision is acknowledged.
async function buildRegionTiles({ region, runtimeOptions, workspace, archivePath, forceFull = false,
  signal, onStage = () => {}, dependencies = {}, env = process.env }: LooseRecord) {
  const readState = dependencies.readState || readRegionTileState;
  const publish = dependencies.publish || publishRegionTiles;
  const exportFeatures = dependencies.exportFeatures || exportRegionMembersToGeojsonNdjson;
  const build = dependencies.build || buildPmtilesFromGeojson;
  const patch = dependencies.patch || ((options) => require('./pmtiles-patch').patchPmtilesArchive(options));
  const signature = buildRegionTileSignature(region);
  let state = await readState(runtimeOptions.databaseUrl, region.id);
  signal?.throwIfAborted();
  const identity = { state, signature, archivePath };
  if (!forceFull && canReuseRegionArchive(identity)) {
    onStage('publish', 100, 'unchanged rendering data; reusing published pmtiles archive');
    return { archivePath, bounds: region.bounds || null, exportedFeatureCount: 0,
      buildResult: { engine: 'planetiler', mode: 'unchanged', shardCount: 1, reusedShardCount: 1 } };
  }
  const builtArchivePath = path.join(workspace, 'region.pmtiles');
  const inputBase = usesPlanetilerLocalIo(env) ? env.REGION_SYNC_TILE_INPUT_DIR?.trim() : '';
  const exportAndBuild = async (tileWindows, outputPath) => {
    signal?.throwIfAborted();
    // Keep the large export off the shared filesystem. Publication still uses
    // the regional workspace beside the previous archive on that filesystem.
    const exportDir = inputBase ? createWorkspace(region.id, { baseDir: inputBase }) : workspace;
    const geojsonPath = path.join(exportDir, 'region-build.ndjson');
    try {
      onStage('export', null, tileWindows ? 'exporting complete features around changed tiles' : 'exporting region members from PostgreSQL');
      const exported = await exportFeatures({ ...runtimeOptions, regionId: region.id, outputPath: geojsonPath, tileWindows });
      if (!tileWindows && exported.importedFeatureCount <= 0) {
        throw new Error('Region has no features, PMTiles rebuild aborted; keeping previous archive');
      }
      signal?.throwIfAborted();
      let buildResult = null;
      if (exported.importedFeatureCount > 0) {
        onStage('build', null, `features=${exported.importedFeatureCount}`);
        buildResult = await build({ region, geojsonPath, outputPath, env, sharedTileInput: Boolean(inputBase),
          onShardProgress: info => onStage(info.stage || 'build', info.progress ?? null, info.detail || null) });
        signal?.throwIfAborted();
      }
      return { exported, buildResult };
    } finally {
      if (inputBase) removeWorkspace(exportDir, { baseDir: inputBase });
    }
  };
  let fullReason = forceFull ? 'forced' : state.full_rebuild_required ? 'incomplete dirty history' : 'missing compatible base or dirty bounds';
  if (!forceFull && canPatchRegionArchive(identity)) {
    const plan = planRegionTilePatch(region, state.dirty_bounds);
    if (plan.mode === 'incremental') {
      try {
        const patchPath = path.join(workspace, 'changed.pmtiles');
        const { exported } = await exportAndBuild(plan.tileWindows, patchPath);
        onStage('build', null, `replacing ${plan.dirtyTileIds.length} changed tiles`);
        const counts = await patch({ basePath: archivePath,
          patchPath: exported.importedFeatureCount > 0 ? patchPath : null,
          outputPath: builtArchivePath, dirtyTileIds: plan.dirtyTileIds, signal });
        signal?.throwIfAborted();
        onStage('publish', null, 'publishing incremental pmtiles archive');
        await publish({ databaseUrl: runtimeOptions.databaseUrl, regionId: region.id,
          revision: state.data_revision, signature, archivePath, builtArchivePath, expectedBase: state, signal });
        return { archivePath, bounds: exported.regionBounds, exportedFeatureCount: exported.importedFeatureCount,
          buildResult: { engine: 'planetiler', mode: 'incremental', shardCount: 1,
            dirtyTileCount: plan.dirtyTileIds.length, ...counts } };
      } catch (error) {
        signal?.throwIfAborted();
        // Failed or unsupported patches leave the original archive and dirty
        // history intact. A fresh full export is the safe recovery path.
        console.warn(`[region-sync] incremental tiles unavailable; rebuilding full archive: ${String(error?.message || error)}`);
        state = await readState(runtimeOptions.databaseUrl, region.id);
        fullReason = 'incremental build failed';
      }
    } else {
      fullReason = plan.reason;
    }
  }
  onStage('build', null, `full rebuild: ${fullReason}`);
  const { exported, buildResult } = await exportAndBuild(null, builtArchivePath);
  onStage('publish', null, 'publishing pmtiles archive');
  await publish({ databaseUrl: runtimeOptions.databaseUrl, regionId: region.id,
    revision: state.data_revision, signature, archivePath, builtArchivePath, signal });
  return { archivePath, bounds: exported.bounds, exportedFeatureCount: exported.importedFeatureCount,
    buildResult: { ...buildResult, fullReason } };
}

module.exports = { buildRegionTiles };
