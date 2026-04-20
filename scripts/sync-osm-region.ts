require('dotenv').config({ quiet: true });

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const SHOULD_EMIT_STAGE_JSON =
  String(process.env.REGION_SYNC_EMIT_STAGE_JSON || '')
    .trim()
    .toLowerCase() === 'true';

let aggregateStageContext: LooseRecord | null = null;

function setAggregateStageContext(context: LooseRecord | null) {
  aggregateStageContext = context;
}

function emitStageJson(stage, progress = null, detail = null, extras: LooseRecord | null = null) {
  if (!SHOULD_EMIT_STAGE_JSON) return;
  const payload: LooseRecord = { stage: String(stage || '').trim() };
  if (!payload.stage) return;
  if (progress != null && Number.isFinite(Number(progress))) {
    payload.progress = Math.max(0, Math.min(100, Math.round(Number(progress))));
  }
  if (detail != null && String(detail).trim()) {
    payload.detail = String(detail).trim().slice(0, 240);
  }
  if (aggregateStageContext) {
    payload.subregionIndex = aggregateStageContext.subregionIndex ?? null;
    payload.subregionTotal = aggregateStageContext.subregionTotal ?? null;
    payload.subregionId = aggregateStageContext.subregionId ?? null;
    payload.subregionName = aggregateStageContext.subregionName ?? null;
  }
  if (extras && typeof extras === 'object') {
    for (const [key, value] of Object.entries(extras)) {
      if (value == null) continue;
      payload[key] = value;
    }
  }
  try {
    process.stdout.write(`SYNC_STAGE_JSON=${JSON.stringify(payload)}\n`);
  } catch {
    // ignore stdout write failures during cancellation
  }
}

function handleCancellationSignal(signal) {
  emitStageJson('cancelling', null, `signal=${signal}`);
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
const { downloadManagedRegionExtract } = require('./region-sync/extract-download');
const { applyRegionImportFromPostgresStage, publishPmtilesArchive } = require('./region-sync/import-applier');
const { buildPmtilesFromGeojson } = require('./region-sync/pmtiles-builder');
const { dropStageSchema, importPbfToPostgresStage } = require('./region-sync/osm2pgsql-import');
const {
  assertRegionSupportsManagedSync,
  exportRegionMembersToGeojsonNdjson,
  loadRegion,
  loadSubregions,
  updateRegionPostSync
} = require('./region-sync/db-ingester');

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
const PMTILES_PROGRESS_JSON = String(process.env.PMTILES_PROGRESS_JSON ?? 'true').toLowerCase() === 'true';
const PMTILES_PROGRESS_INTERVAL_SEC = Math.max(
  1,
  Math.min(300, Number(process.env.PMTILES_PROGRESS_INTERVAL_SEC || 5))
);
const ROOT_DIR = path.join(__dirname, '..');
const DEFAULT_PARENT_WATCHDOG_INTERVAL_MS = 5_000;

function assertManagedRegionSyncPostgres(runtimeOptions: LooseRecord = {}) {
  const provider = String(runtimeOptions.dbProvider || DB_PROVIDER)
    .trim()
    .toLowerCase();
  if (provider !== 'postgres') {
    throw new Error('Managed region sync only supports DB_PROVIDER=postgres');
  }
  if (!String(runtimeOptions.databaseUrl || DATABASE_URL).trim()) {
    throw new Error('DATABASE_URL is required for managed region sync');
  }
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
  assertManagedRegionSyncPostgres(runtimeOptions);
  return 'postgres_stage';
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
    DB_PROVIDER: 'postgres',
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
    progressJson: PMTILES_PROGRESS_JSON,
    progressIntervalSec: PMTILES_PROGRESS_INTERVAL_SEC,
    onShardProgress: (stageInfo) => {
      const stage = String(stageInfo?.stage || 'build').trim() || 'build';
      emitStageJson(stage, stageInfo?.progress ?? null, stageInfo?.detail || null);
    },
    env: process.env
  });
}

function summarizePmtilesBuildResult(buildResult: LooseRecord = {}) {
  return {
    pmtilesBuildEngine: buildResult?.engine || null,
    pmtilesBuildMode: buildResult?.mode || null,
    pmtilesShardCount: Number(buildResult?.shardCount || 0) || null,
    pmtilesShardReusedCount: Number(buildResult?.reusedShardCount || 0),
    pmtilesShardRebuiltCount: Number(buildResult?.rebuiltShardCount || 0),
    pmtilesShardCacheDir: buildResult?.cacheDir || null
  };
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

function buildApplyStageDetail(totalFeatureCount) {
  const normalizedTotalFeatureCount = Number(totalFeatureCount);
  if (!Number.isInteger(normalizedTotalFeatureCount) || normalizedTotalFeatureCount <= 0) {
    return 'merging staging rows into canonical tables';
  }
  return `merging ${normalizedTotalFeatureCount} staging rows into canonical tables`;
}

function createApplyStageProgressEmitter() {
  return (progressEvent: LooseRecord = {}) => {
    emitStageJson('apply', progressEvent?.progress ?? null, progressEvent?.detail || null);
  };
}

async function buildRegionPmtilesOnly(region, runtimeOptions) {
  assertManagedRegionSyncPostgres(runtimeOptions);
  const workspace = createWorkspace(region.id);
  const geojsonPath = path.join(workspace, 'region-build.ndjson');
  const builtPmtilesPath = path.join(workspace, 'region.pmtiles');

  try {
    emitStageJson('export', null, 'reading region members from PostgreSQL');
    const exported = await exportRegionMembersToGeojsonNdjson({
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
      ...summarizePmtilesBuildResult(buildResult),
      pmtilesBytes: Number(fs.statSync(finalArchivePath).size || 0),
      pmtilesPath: finalArchivePath,
      bounds: exported.bounds
    };
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
}

async function runRegionSync(region, runtimeOptions) {
  assertManagedRegionSyncPostgres(runtimeOptions);
  const workspace = createWorkspace(region.id);
  const geojsonPath = path.join(workspace, 'region-build.ndjson');
  const builtPmtilesPath = path.join(workspace, 'region.pmtiles');
  let stageSchema = null;

  try {
    const downloaded = await downloadManagedRegionExtract({
      region,
      workspace,
      onStage: async (stage, detail, progress = null) => emitStageJson(stage, progress, detail)
    });

    const stageImport = await importPbfToPostgresStage({
      region,
      databaseUrl: runtimeOptions.databaseUrl,
      pbfPath: downloaded.pbfPath,
      env: buildExtractorEnv(process.env),
      onStage: async (stage, detail) => emitStageJson(stage, null, detail)
    });
    stageSchema = stageImport.stageSchema;

    emitStageJson('apply', 0, buildApplyStageDetail(null));
    const dbResult = await applyRegionImportFromPostgresStage({
      region,
      databaseUrl: runtimeOptions.databaseUrl,
      stageSchema: stageImport.stageSchema,
      stageTable: stageImport.stageTable,
      totalFeatureCount: null,
      sourceSnapshot: downloaded.sourceSnapshot,
      onProgress: createApplyStageProgressEmitter()
    });

    emitStageJson('export', null, 'exporting region members from PostgreSQL');
    const exported = await exportRegionMembersToGeojsonNdjson({
      ...runtimeOptions,
      regionId: region.id,
      outputPath: geojsonPath
    });
    if (exported.importedFeatureCount <= 0) {
      throw new Error('Sync produced 0 PMTiles features; keeping previous region archive untouched');
    }

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
      ...summarizePmtilesBuildResult(buildResult),
      pmtilesBytes: Number(fs.statSync(finalArchivePath).size || 0),
      pmtilesPath: finalArchivePath,
      bounds: exported.bounds
    };
  } finally {
    if (stageSchema) {
      try {
        await dropStageSchema(runtimeOptions.databaseUrl, stageSchema);
      } catch (error) {
        console.warn(`[region-sync] staging schema cleanup failed: ${String(error?.message || error)}`);
      }
    }
    fs.rmSync(workspace, { recursive: true, force: true });
  }
}

async function runCountryAggregateSync(region, runtimeOptions) {
  const subregions = await loadSubregions(runtimeOptions, region.id);
  if (!Array.isArray(subregions) || subregions.length === 0) {
    throw new Error(`Country aggregate region ${region.id} has no subregions to sync`);
  }

  const enabledSubregions = subregions.filter((sub) => sub && sub.enabled);
  if (enabledSubregions.length === 0) {
    throw new Error(`Country aggregate region ${region.id} has no enabled subregions`);
  }

  const total = enabledSubregions.length;
  let aggregateFeatureCount = 0;
  let aggregatePmtilesBytes = 0;
  let aggregateBounds: LooseRecord | null = null;
  const subregionResults: LooseRecord[] = [];
  const failures: LooseRecord[] = [];

  emitStageJson('aggregate_start', 0, `subregions=${total}`, { subregionTotal: total });

  for (let index = 0; index < enabledSubregions.length; index += 1) {
    const sub = enabledSubregions[index];
    const oneIndexed = index + 1;
    setAggregateStageContext({
      subregionIndex: oneIndexed,
      subregionTotal: total,
      subregionId: sub.id,
      subregionName: sub.name
    });
    try {
      assertRegionSupportsManagedSync(sub);
      emitStageJson('subregion_start', 0, `${oneIndexed}/${total} ${sub.name}`);
      const summary = await runRegionSync(sub, runtimeOptions);
      await updateRegionPostSync(runtimeOptions, sub.id, summary);
      const fc = Number(summary?.activeFeatureCount ?? summary?.importedFeatureCount ?? 0) || 0;
      const pmbytes = Number(summary?.pmtilesBytes ?? 0) || 0;
      aggregateFeatureCount += fc;
      aggregatePmtilesBytes += pmbytes;
      if (summary?.bounds) {
        if (!aggregateBounds) {
          aggregateBounds = { ...summary.bounds };
        } else {
          aggregateBounds.west = Math.min(aggregateBounds.west, summary.bounds.west);
          aggregateBounds.south = Math.min(aggregateBounds.south, summary.bounds.south);
          aggregateBounds.east = Math.max(aggregateBounds.east, summary.bounds.east);
          aggregateBounds.north = Math.max(aggregateBounds.north, summary.bounds.north);
        }
      }
      subregionResults.push({
        regionId: sub.id,
        slug: sub.slug,
        name: sub.name,
        featureCount: fc,
        pmtilesBytes: pmbytes,
        status: 'success'
      });
      const progress = Math.round((oneIndexed / total) * 100);
      emitStageJson('subregion_done', progress, `${oneIndexed}/${total} ${sub.name} OK`);
    } catch (error) {
      const message = String(error?.message || error || 'Unknown subregion sync error');
      console.error(`[region-sync] subregion ${sub?.slug || sub?.id} failed: ${message}`);
      failures.push({ regionId: sub.id, slug: sub.slug, name: sub.name, error: message });
      subregionResults.push({
        regionId: sub.id,
        slug: sub.slug,
        name: sub.name,
        status: 'failed',
        error: message
      });
      emitStageJson('subregion_failed', null, `${oneIndexed}/${total} ${sub.name}: ${message}`);
    }
  }
  setAggregateStageContext(null);

  if (failures.length > 0 && subregionResults.filter((r) => r.status === 'success').length === 0) {
    throw new Error(`All ${total} subregions failed; first error: ${failures[0]?.error}`);
  }

  return {
    importedFeatureCount: aggregateFeatureCount,
    activeFeatureCount: aggregateFeatureCount,
    orphanDeletedCount: 0,
    pmtilesBytes: aggregatePmtilesBytes,
    pmtilesPath: null,
    bounds: aggregateBounds,
    subregionResults,
    subregionFailures: failures,
    subregionTotal: total,
    subregionSucceeded: total - failures.length
  };
}

async function main() {
  const stopParentWatchdog = startParentWatchdog();
  try {
    const args = parseArgs(process.argv.slice(2));
    if (!Number.isInteger(args.regionId) || args.regionId <= 0) {
      throw new Error('Pass --region-id <id>');
    }

    const runtimeOptions = createRuntimeOptions();
    assertManagedRegionSyncPostgres(runtimeOptions);
    const region = await loadRegion(runtimeOptions, args.regionId);
    assertRegionSupportsManagedSync(region);

    let summary;
    if (region.regionKind === 'country_aggregate') {
      if (args.pmtilesOnly) {
        throw new Error('--pmtiles-only is not supported for country_aggregate regions');
      }
      summary = await runCountryAggregateSync(region, runtimeOptions);
    } else {
      summary = args.pmtilesOnly
        ? await buildRegionPmtilesOnly(region, runtimeOptions)
        : await runRegionSync(region, runtimeOptions);
    }

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
  buildApplyStageDetail,
  buildExtractorEnv,
  buildRuntimeFollowupEnv,
  buildRegionPmtilesOnly,
  createRuntimeOptions,
  isProcessAlive,
  main,
  parseArgs,
  resolveImporterDbGeometryMode,
  resolveParentWatchdogPid,
  readExportSummary,
  runRegionSync,
  runRuntimeFollowups,
  shouldRunRuntimeFollowup,
  startParentWatchdog
};
