require('dotenv').config({ quiet: true });

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const SHOULD_EMIT_STAGE_JSON =
  String(process.env.REGION_SYNC_EMIT_STAGE_JSON || '')
    .trim()
    .toLowerCase() === 'true';

function emitStageJson(stage, progress = null, detail = null) {
  if (!SHOULD_EMIT_STAGE_JSON) return;
  const payload: LooseRecord = { stage: String(stage || '').trim() };
  if (!payload.stage) return;
  if (progress != null && Number.isFinite(Number(progress))) {
    payload.progress = Math.max(0, Math.min(100, Math.round(Number(progress))));
  }
  if (detail != null && String(detail).trim()) {
    payload.detail = String(detail).trim().slice(0, 200);
  }
  try {
    process.stdout.write(`SYNC_STAGE_JSON=${JSON.stringify(payload)}\n`);
  } catch {
    // ignore stdout write failures (e.g. closed pipe during cancellation)
  }
}

function handleCancellationSignal(signal) {
  emitStageJson('cancelling', null, `signal=${signal}`);
  // Allow any current spawnSync child to finish its exit so we can shut down
  // cleanly; the Node exit handler below will propagate the cancellation
  // code. On Windows, the parent sync-workers manager uses taskkill /T /F
  // so the whole tree (including tippecanoe / python) is already going down.
  setTimeout(() => {
    try {
      process.exit(130);
    } catch {
      // ignore
    }
  }, 50).unref?.();
}
process.on('SIGTERM', () => handleCancellationSignal('SIGTERM'));
process.on('SIGINT', () => handleCancellationSignal('SIGINT'));

const { getDbProvider, getPostgresConnectionString } = require('./lib/postgres-config');
const { createWorkspace } = require('./region-sync/common');
const { exportRegionExtractToNdjson } = require('./region-sync/python-extractor');
const {
  applyRegionImport,
  assertRegionSupportsManagedSync,
  exportRegionRenderFeaturesToGeojsonNdjson,
  loadRegion,
  publishPmtilesArchive
} = require('./region-sync/db-ingester');
const { buildPmtilesFromGeojson, summarizeImportRows } = require('./region-sync/pmtiles-builder');

const DB_PROVIDER = getDbProvider(process.env);
const DATABASE_URL = getPostgresConnectionString(process.env);
const ARCHIMAP_DB_PATH =
  String(
    process.env.DATABASE_PATH ||
      process.env.ARCHIMAP_DB_PATH ||
      process.env.SQLITE_URL ||
      path.join(__dirname, '..', 'data', 'archimap.db')
  ).trim() || path.join(__dirname, '..', 'data', 'archimap.db');
const OSM_DB_PATH =
  String(process.env.OSM_DB_PATH || path.join(__dirname, '..', 'data', 'osm.db')).trim() ||
  path.join(__dirname, '..', 'data', 'osm.db');
const LOCAL_EDITS_DB_PATH =
  String(process.env.LOCAL_EDITS_DB_PATH || path.join(__dirname, '..', 'data', 'local-edits.db')).trim() ||
  path.join(__dirname, '..', 'data', 'local-edits.db');
const DATA_DIR =
  String(process.env.ARCHIMAP_DATA_DIR || path.join(__dirname, '..', 'data')).trim() ||
  path.join(__dirname, '..', 'data');
const TIPPECANOE_PROGRESS_JSON = String(process.env.TIPPECANOE_PROGRESS_JSON ?? 'true').toLowerCase() === 'true';
const TIPPECANOE_PROGRESS_INTERVAL_SEC = Math.max(
  1,
  Math.min(300, Number(process.env.TIPPECANOE_PROGRESS_INTERVAL_SEC || 5))
);
const REGION_SYNC_SHARD_KM_RAW = process.env.REGION_SYNC_SHARD_KM;
const ROOT_DIR = path.join(__dirname, '..');
const DEFAULT_PARENT_WATCHDOG_INTERVAL_MS = 5_000;

function resolveRegionPmtilesCacheDir(dataDir, region) {
  const regionKey = `${Number(region?.id || 0) || 'unknown'}-${String(region?.slug || 'region').trim() || 'region'}`;
  const safeRegionKey = regionKey.replace(/[^a-z0-9._-]+/gi, '-');
  return path.join(
    String(dataDir || path.join(__dirname, '..', 'data')).trim() || path.join(__dirname, '..', 'data'),
    'regions',
    '.pmtiles-cache',
    safeRegionKey
  );
}

function parseArgs(argv): LooseRecord {
  const out = {
    regionId: null,
    pmtilesOnly: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = String(argv[index] || '').trim();
    if (!arg) continue;
    if (arg === '--pmtiles-only') {
      out.pmtilesOnly = true;
      continue;
    }
    if (arg === '--region-id' && argv[index + 1]) {
      out.regionId = Number(argv[index + 1]);
      index += 1;
      continue;
    }
    if (arg.startsWith('--region-id=')) {
      out.regionId = Number(arg.slice('--region-id='.length));
    }
  }

  return out;
}

function createRuntimeOptions() {
  return {
    dbProvider: DB_PROVIDER,
    databaseUrl: DATABASE_URL,
    archimapDbPath: ARCHIMAP_DB_PATH,
    osmDbPath: OSM_DB_PATH,
    localEditsDbPath: LOCAL_EDITS_DB_PATH,
    dataDir: DATA_DIR
  };
}

function resolveParentWatchdogPid(env: LooseRecord = process.env) {
  const rawParentPid = Number(env.REGION_SYNC_PARENT_PID);
  if (!Number.isInteger(rawParentPid) || rawParentPid <= 0 || rawParentPid === process.pid) {
    return null;
  }
  return rawParentPid;
}

function isProcessAlive(pid, killRef = process.kill.bind(process)) {
  const numericPid = Number(pid);
  if (!Number.isInteger(numericPid) || numericPid <= 0) {
    return false;
  }
  try {
    killRef(numericPid, 0);
    return true;
  } catch (error) {
    const code = String(error?.code || '');
    if (code === 'ESRCH') {
      return false;
    }
    return true;
  }
}

function startParentWatchdog(options: LooseRecord = {}) {
  const parentPid = Number(options.parentPid ?? resolveParentWatchdogPid(options.env || process.env));
  if (!Number.isInteger(parentPid) || parentPid <= 0) {
    return () => {};
  }

  const intervalMs = Math.max(
    1_000,
    Math.trunc(Number(options.intervalMs || DEFAULT_PARENT_WATCHDOG_INTERVAL_MS) || DEFAULT_PARENT_WATCHDOG_INTERVAL_MS)
  );
  const setIntervalRef = typeof options.setIntervalRef === 'function' ? options.setIntervalRef : setInterval;
  const clearIntervalRef = typeof options.clearIntervalRef === 'function' ? options.clearIntervalRef : clearInterval;
  const killRef = typeof options.killRef === 'function' ? options.killRef : process.kill.bind(process);
  const exitRef = typeof options.exitRef === 'function' ? options.exitRef : process.exit.bind(process);
  const stderr = options.stderr || process.stderr;

  const timer = setIntervalRef(() => {
    if (isProcessAlive(parentPid, killRef)) {
      return;
    }
    try {
      stderr.write(`[region-sync] parent process ${parentPid} is gone; stopping orphaned sync worker\n`);
    } catch {
      // ignore stderr failures during forced exit
    }
    try {
      exitRef(131);
    } catch {
      // ignore process exit exceptions in tests
    }
  }, intervalMs);
  if (typeof timer?.unref === 'function') {
    timer.unref();
  }

  return () => {
    clearIntervalRef(timer);
  };
}

function buildExtractorEnv(env: LooseRecord = process.env) {
  return {
    ...env,
    REGION_SYNC_PARENT_PID: String(process.pid)
  };
}

function resolveImporterDbGeometryMode(runtimeOptions: LooseRecord = {}) {
  return String(runtimeOptions.dbProvider || DB_PROVIDER)
    .trim()
    .toLowerCase() === 'postgres'
    ? 'wkb_hex'
    : 'geojson';
}

function getRegionImportReadOptions(runtimeOptions: LooseRecord = {}) {
  return String(runtimeOptions.dbProvider || DB_PROVIDER)
    .trim()
    .toLowerCase() === 'postgres'
    ? { requireGeometryWkbHex: true }
    : { requireGeometryJson: true };
}

function shouldUseLowMemoryPipeline(runtimeOptions: LooseRecord = {}, env: LooseRecord = process.env) {
  const enabled =
    String(env.REGION_SYNC_LOW_MEMORY_PIPELINE || '')
      .trim()
      .toLowerCase() === 'true';
  if (!enabled) return false;

  // SQLite still materializes the full region during remainder expansion when
  // exporting region members back out for PMTiles rebuilds, so apply-first mode
  // would not actually lower peak memory there yet.
  return (
    String(runtimeOptions.dbProvider || DB_PROVIDER)
      .trim()
      .toLowerCase() === 'postgres'
  );
}

function shouldRunRuntimeFollowup(options: LooseRecord = {}) {
  if (options.pmtilesOnly) return false;
  return (
    String(options.env?.REGION_SYNC_SKIP_RUNTIME_FOLLOWUP || '')
      .trim()
      .toLowerCase() !== 'true'
  );
}

function buildRuntimeFollowupEnv(runtimeOptions: LooseRecord = {}, env: LooseRecord = process.env) {
  return {
    ...env,
    DB_PROVIDER: String(runtimeOptions.dbProvider || env.DB_PROVIDER || DB_PROVIDER).trim() || DB_PROVIDER,
    DATABASE_URL: String(runtimeOptions.databaseUrl || env.DATABASE_URL || DATABASE_URL).trim() || DATABASE_URL,
    ARCHIMAP_DB_PATH:
      String(runtimeOptions.archimapDbPath || env.ARCHIMAP_DB_PATH || ARCHIMAP_DB_PATH).trim() || ARCHIMAP_DB_PATH,
    DATABASE_PATH:
      String(runtimeOptions.archimapDbPath || env.DATABASE_PATH || ARCHIMAP_DB_PATH).trim() || ARCHIMAP_DB_PATH,
    OSM_DB_PATH: String(runtimeOptions.osmDbPath || env.OSM_DB_PATH || OSM_DB_PATH).trim() || OSM_DB_PATH,
    LOCAL_EDITS_DB_PATH:
      String(runtimeOptions.localEditsDbPath || env.LOCAL_EDITS_DB_PATH || LOCAL_EDITS_DB_PATH).trim() ||
      LOCAL_EDITS_DB_PATH
  };
}

function runWorkerScript({
  label,
  scriptPath,
  env,
  rootDir = ROOT_DIR,
  spawnSyncRef = spawnSync,
  processExecPath = process.execPath
}: LooseRecord) {
  const result = spawnSyncRef(processExecPath, ['--import', 'tsx', scriptPath], {
    cwd: rootDir,
    env,
    stdio: 'inherit',
    shell: false
  });
  if (result?.error) {
    throw result.error;
  }
  if ((result?.status ?? 1) !== 0) {
    throw new Error(`${label} failed with exit code ${result?.status ?? 1}`);
  }
}

function runRuntimeFollowups({
  region,
  runtimeOptions,
  env = process.env,
  rootDir = ROOT_DIR,
  spawnSyncRef = spawnSync,
  processExecPath = process.execPath
}) {
  const followupEnv = buildRuntimeFollowupEnv(runtimeOptions, env);
  const reason = `region-sync:${Number(region?.id || 0) || 'unknown'}`;

  runWorkerScript({
    label: 'search rebuild worker',
    scriptPath: path.join(rootDir, 'workers', 'rebuild-search-index.worker.ts'),
    env: {
      ...followupEnv,
      SEARCH_REBUILD_REASON: reason
    },
    rootDir,
    spawnSyncRef,
    processExecPath
  });

  runWorkerScript({
    label: 'filter tag keys rebuild worker',
    scriptPath: path.join(rootDir, 'workers', 'rebuild-filter-tag-keys-cache.worker.ts'),
    env: {
      ...followupEnv,
      FILTER_TAG_KEYS_REBUILD_REASON: reason
    },
    rootDir,
    spawnSyncRef,
    processExecPath
  });
}

async function buildPmtilesStep(region, geojsonPath, outputPath, exportSummary: LooseRecord = {}, dataDir = null) {
  return buildPmtilesFromGeojson({
    region,
    geojsonPath,
    outputPath,
    bounds: region?.bounds || exportSummary?.bounds || null,
    featureCount: Number.isFinite(exportSummary?.importedFeatureCount)
      ? Number(exportSummary.importedFeatureCount)
      : null,
    shardKm: REGION_SYNC_SHARD_KM_RAW === undefined ? undefined : Number(REGION_SYNC_SHARD_KM_RAW),
    shardCacheDir: resolveRegionPmtilesCacheDir(
      dataDir || process.env.ARCHIMAP_DATA_DIR || path.join(__dirname, '..', 'data'),
      region
    ),
    progressJson: TIPPECANOE_PROGRESS_JSON,
    progressIntervalSec: TIPPECANOE_PROGRESS_INTERVAL_SEC,
    onShardProgress: (stageInfo) => {
      const stage = String(stageInfo?.stage || 'build').trim() || 'build';
      emitStageJson(stage, stageInfo?.progress ?? null, stageInfo?.detail || null);
    },
    env: process.env
  });
}

function readExportSummary(summaryPath) {
  const normalizedPath = String(summaryPath || '').trim();
  if (!normalizedPath || !fs.existsSync(normalizedPath)) {
    return null;
  }

  try {
    const payload = JSON.parse(fs.readFileSync(normalizedPath, 'utf8'));
    const importedFeatureCount = Number(payload?.importedFeatureCount);
    const bounds =
      payload?.bounds && typeof payload.bounds === 'object'
        ? {
            west: Number(payload.bounds.west),
            south: Number(payload.bounds.south),
            east: Number(payload.bounds.east),
            north: Number(payload.bounds.north)
          }
        : null;

    if (!Number.isInteger(importedFeatureCount) || importedFeatureCount < 0) {
      return null;
    }
    if (bounds && ![bounds.west, bounds.south, bounds.east, bounds.north].every(Number.isFinite)) {
      return null;
    }

    const sourceSnapshotRaw = payload?.sourceSnapshot;
    const sourceSnapshot =
      sourceSnapshotRaw && typeof sourceSnapshotRaw === 'object' && String(sourceSnapshotRaw.sha256 || '').trim()
        ? {
            extractSource: String(sourceSnapshotRaw.extractSource || '').trim() || null,
            extractId: String(sourceSnapshotRaw.extractId || '').trim() || null,
            sha256: String(sourceSnapshotRaw.sha256).trim(),
            sizeBytes: Number.isFinite(Number(sourceSnapshotRaw.sizeBytes))
              ? Number(sourceSnapshotRaw.sizeBytes)
              : null,
            sourceMtime: String(sourceSnapshotRaw.sourceMtime || '').trim() || null,
            localPath: String(sourceSnapshotRaw.localPath || '').trim() || null
          }
        : null;

    return {
      importedFeatureCount,
      bounds,
      sourceSnapshot
    };
  } catch {
    return null;
  }
}

async function readRegionImportSummary(runtimeOptions, summaryPath, importPath) {
  const summary = readExportSummary(summaryPath);
  if (summary) return summary;
  return summarizeImportRows(importPath, getRegionImportReadOptions(runtimeOptions));
}

function buildApplyStageDetail(totalFeatureCount) {
  const normalizedTotalFeatureCount = Number(totalFeatureCount);
  if (!Number.isInteger(normalizedTotalFeatureCount) || normalizedTotalFeatureCount <= 0) {
    return 'applying region import to database';
  }
  return `importing ${normalizedTotalFeatureCount} features into database`;
}

function createApplyStageProgressEmitter() {
  return (progressEvent: LooseRecord = {}) => {
    emitStageJson('apply', progressEvent?.progress ?? null, progressEvent?.detail || null);
  };
}

async function buildRegionPmtilesOnly(region, runtimeOptions) {
  const workspace = createWorkspace(region.id);
  const geojsonPath = path.join(workspace, 'region-build.ndjson');
  const builtPmtilesPath = path.join(workspace, 'region.pmtiles');

  try {
    emitStageJson('export', null, 'reading region members');
    const exported = await exportRegionRenderFeaturesToGeojsonNdjson({
      ...runtimeOptions,
      regionId: region.id,
      outputPath: geojsonPath
    });
    if (exported.importedFeatureCount <= 0) {
      throw new Error('Region has no features, PMTiles rebuild aborted');
    }

    emitStageJson('build', null, `features=${exported.importedFeatureCount}`);
    const buildResult = await buildPmtilesStep(region, geojsonPath, builtPmtilesPath, exported, runtimeOptions.dataDir);
    emitStageJson('publish', null, 'publishing pmtiles archive');
    const finalArchivePath = publishPmtilesArchive({
      dataDir: runtimeOptions.dataDir,
      region,
      builtPmtilesPath
    });

    return {
      importedFeatureCount: exported.importedFeatureCount,
      activeFeatureCount: exported.importedFeatureCount,
      orphanDeletedCount: 0,
      renderCacheRows: 0,
      pmtilesBuildMode: buildResult?.mode || null,
      pmtilesShardCount: Number(buildResult?.shardCount || 0) || null,
      pmtilesShardReusedCount: Number(buildResult?.reusedShardCount || 0),
      pmtilesShardRebuiltCount: Number(buildResult?.rebuiltShardCount || 0),
      pmtilesShardCacheDir: buildResult?.cacheDir || null,
      pmtilesBytes: Number(fs.statSync(finalArchivePath).size || 0),
      pmtilesPath: finalArchivePath,
      bounds: exported.bounds
    };
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
}

async function runRegionSyncLowMemory(region, runtimeOptions) {
  const workspace = createWorkspace(region.id);
  const importPath = path.join(workspace, 'region-import.ndjson');
  const geojsonPath = path.join(workspace, 'region-build.ndjson');
  const summaryPath = path.join(workspace, 'region-export-summary.json');
  const builtPmtilesPath = path.join(workspace, 'region.pmtiles');
  const importerPath = path.join(__dirname, 'sync-osm-buildings.py');

  try {
    emitStageJson('download', null, 'starting OSM extract pipeline');
    // Generate both DB import NDJSON and GeoJSON NDJSON for PMTiles in a single
    // DuckDB pass.  The previous approach skipped geojsonOutputPath here and
    // re-exported from PostgreSQL later, but the building_remainders self-JOIN
    // in PostgreSQL is O(n*m) and takes hours for large regions (e.g. Poland).
    // DuckDB handles the same analytical join orders of magnitude faster.
    exportRegionExtractToNdjson({
      importerPath,
      region,
      dbOutputPath: importPath,
      geojsonOutputPath: geojsonPath,
      summaryOutputPath: summaryPath,
      dbGeometryMode: resolveImporterDbGeometryMode(runtimeOptions),
      env: buildExtractorEnv(process.env)
    });

    const exported = await readRegionImportSummary(runtimeOptions, summaryPath, importPath);
    if (exported.importedFeatureCount <= 0) {
      throw new Error('Sync returned 0 features; keeping previous PMTiles and current data untouched');
    }

    emitStageJson('apply', 0, buildApplyStageDetail(exported.importedFeatureCount));
    const dbResult = await applyRegionImport({
      ...runtimeOptions,
      region,
      ndjsonPath: importPath,
      renderGeojsonPath: geojsonPath,
      totalFeatureCount: exported.importedFeatureCount,
      sourceSnapshot: exported.sourceSnapshot || null,
      onProgress: createApplyStageProgressEmitter()
    });

    emitStageJson('build', null, `features=${exported.importedFeatureCount}`);
    const buildResult = await buildPmtilesStep(region, geojsonPath, builtPmtilesPath, exported, runtimeOptions.dataDir);
    emitStageJson('publish', null, 'publishing pmtiles archive');
    const finalArchivePath = publishPmtilesArchive({
      dataDir: runtimeOptions.dataDir,
      region,
      builtPmtilesPath
    });

    if (shouldRunRuntimeFollowup({ pmtilesOnly: false, env: process.env })) {
      emitStageJson('followup', null, 'rebuilding search indexes');
      runRuntimeFollowups({
        region,
        runtimeOptions
      });
    }

    return {
      ...dbResult,
      ...buildResult,
      renderCacheRows: Number(dbResult.renderCacheRows || 0),
      pmtilesBytes: Number(fs.statSync(finalArchivePath).size || 0),
      pmtilesPath: finalArchivePath,
      bounds: exported.bounds
    };
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
}

async function runRegionSync(region, runtimeOptions) {
  if (shouldUseLowMemoryPipeline(runtimeOptions, process.env)) {
    return runRegionSyncLowMemory(region, runtimeOptions);
  }

  const workspace = createWorkspace(region.id);
  const importPath = path.join(workspace, 'region-import.ndjson');
  const geojsonPath = path.join(workspace, 'region-build.ndjson');
  const summaryPath = path.join(workspace, 'region-export-summary.json');
  const builtPmtilesPath = path.join(workspace, 'region.pmtiles');
  const importerPath = path.join(__dirname, 'sync-osm-buildings.py');

  try {
    emitStageJson('download', null, 'starting OSM extract pipeline');
    exportRegionExtractToNdjson({
      importerPath,
      region,
      dbOutputPath: importPath,
      geojsonOutputPath: geojsonPath,
      summaryOutputPath: summaryPath,
      dbGeometryMode: resolveImporterDbGeometryMode(runtimeOptions),
      env: buildExtractorEnv(process.env)
    });
    const exported = await readRegionImportSummary(runtimeOptions, summaryPath, importPath);

    if (exported.importedFeatureCount <= 0) {
      throw new Error('Sync returned 0 features; keeping previous PMTiles and current data untouched');
    }

    emitStageJson('build', null, `features=${exported.importedFeatureCount}`);
    const buildResult = await buildPmtilesStep(region, geojsonPath, builtPmtilesPath, exported);
    emitStageJson('apply', 0, buildApplyStageDetail(exported.importedFeatureCount));
    const dbResult = await applyRegionImport({
      ...runtimeOptions,
      region,
      ndjsonPath: importPath,
      builtPmtilesPath,
      renderGeojsonPath: geojsonPath,
      totalFeatureCount: exported.importedFeatureCount,
      sourceSnapshot: exported.sourceSnapshot || null,
      onProgress: createApplyStageProgressEmitter()
    });
    if (shouldRunRuntimeFollowup({ pmtilesOnly: false, env: process.env })) {
      emitStageJson('followup', null, 'rebuilding search indexes');
      runRuntimeFollowups({
        region,
        runtimeOptions
      });
    }

    return {
      ...dbResult,
      ...buildResult,
      bounds: exported.bounds
    };
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
}

async function main() {
  const stopParentWatchdog = startParentWatchdog();
  try {
    const args = parseArgs(process.argv.slice(2));
    if (!Number.isInteger(args.regionId) || args.regionId <= 0) {
      throw new Error('Pass --region-id <id>');
    }

    const runtimeOptions = createRuntimeOptions();
    const region = await loadRegion(runtimeOptions, args.regionId);
    assertRegionSupportsManagedSync(region);

    const summary = args.pmtilesOnly
      ? await buildRegionPmtilesOnly(region, runtimeOptions)
      : await runRegionSync(region, runtimeOptions);

    console.log(
      `SYNC_RESULT_JSON=${JSON.stringify({
        regionId: region.id,
        ...summary,
        bounds: summary.bounds || null
      })}`
    );
  } finally {
    stopParentWatchdog();
  }
}

if (require.main === module) {
  main().catch((error) => {
    const message = String(error?.message || error || 'Unknown managed region sync error');
    console.error(`[region-sync] ${message}`);
    process.exit(1);
  });
}

module.exports = {
  buildRuntimeFollowupEnv,
  buildRegionPmtilesOnly,
  createRuntimeOptions,
  main,
  parseArgs,
  buildApplyStageDetail,
  buildExtractorEnv,
  readExportSummary,
  isProcessAlive,
  resolveParentWatchdogPid,
  readRegionImportSummary,
  resolveImporterDbGeometryMode,
  runRuntimeFollowups,
  runRegionSync,
  runRegionSyncLowMemory,
  startParentWatchdog,
  shouldRunRuntimeFollowup,
  shouldUseLowMemoryPipeline
};
