require('dotenv').config({ quiet: true });

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const { getDbProvider, getPostgresConnectionString } = require('./lib/postgres-config');
const { createWorkspace } = require('./region-sync/common');
const { exportRegionExtractToNdjson } = require('./region-sync/python-extractor');
const {
  applyRegionImport,
  assertRegionSupportsManagedSync,
  exportRegionMembersToNdjson,
  loadRegion,
  publishPmtilesArchive
} = require('./region-sync/db-ingester');
const {
  buildPmtilesFromGeojson,
  exportImportRowsToGeojson,
  summarizeImportRows
} = require('./region-sync/pmtiles-builder');

const DB_PROVIDER = getDbProvider(process.env);
const DATABASE_URL = getPostgresConnectionString(process.env);
const ARCHIMAP_DB_PATH = String(
  process.env.DATABASE_PATH
  || process.env.ARCHIMAP_DB_PATH
  || process.env.SQLITE_URL
  || path.join(__dirname, '..', 'data', 'archimap.db')
).trim() || path.join(__dirname, '..', 'data', 'archimap.db');
const OSM_DB_PATH = String(process.env.OSM_DB_PATH || path.join(__dirname, '..', 'data', 'osm.db')).trim() || path.join(__dirname, '..', 'data', 'osm.db');
const LOCAL_EDITS_DB_PATH = String(
  process.env.LOCAL_EDITS_DB_PATH
  || path.join(__dirname, '..', 'data', 'local-edits.db')
).trim() || path.join(__dirname, '..', 'data', 'local-edits.db');
const DATA_DIR = String(process.env.ARCHIMAP_DATA_DIR || path.join(__dirname, '..', 'data')).trim() || path.join(__dirname, '..', 'data');
const TIPPECANOE_PROGRESS_JSON = String(process.env.TIPPECANOE_PROGRESS_JSON ?? 'true').toLowerCase() === 'true';
const TIPPECANOE_PROGRESS_INTERVAL_SEC = Math.max(1, Math.min(300, Number(process.env.TIPPECANOE_PROGRESS_INTERVAL_SEC || 5)));
const ROOT_DIR = path.join(__dirname, '..');

function parseArgs(argv) {
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

function shouldRunRuntimeFollowup(options = {}) {
  if (options.pmtilesOnly) return false;
  return String(options.env?.REGION_SYNC_SKIP_RUNTIME_FOLLOWUP || '').trim().toLowerCase() !== 'true';
}

function buildRuntimeFollowupEnv(runtimeOptions = {}, env = process.env) {
  return {
    ...env,
    DB_PROVIDER: String(runtimeOptions.dbProvider || env.DB_PROVIDER || DB_PROVIDER).trim() || DB_PROVIDER,
    DATABASE_URL: String(runtimeOptions.databaseUrl || env.DATABASE_URL || DATABASE_URL).trim() || DATABASE_URL,
    ARCHIMAP_DB_PATH: String(runtimeOptions.archimapDbPath || env.ARCHIMAP_DB_PATH || ARCHIMAP_DB_PATH).trim() || ARCHIMAP_DB_PATH,
    DATABASE_PATH: String(runtimeOptions.archimapDbPath || env.DATABASE_PATH || ARCHIMAP_DB_PATH).trim() || ARCHIMAP_DB_PATH,
    OSM_DB_PATH: String(runtimeOptions.osmDbPath || env.OSM_DB_PATH || OSM_DB_PATH).trim() || OSM_DB_PATH,
    LOCAL_EDITS_DB_PATH: String(runtimeOptions.localEditsDbPath || env.LOCAL_EDITS_DB_PATH || LOCAL_EDITS_DB_PATH).trim() || LOCAL_EDITS_DB_PATH
  };
}

function runWorkerScript({ label, scriptPath, env, rootDir = ROOT_DIR, spawnSyncRef = spawnSync, processExecPath = process.execPath }) {
  const result = spawnSyncRef(processExecPath, [scriptPath], {
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

function runRuntimeFollowups({ region, runtimeOptions, env = process.env, rootDir = ROOT_DIR, spawnSyncRef = spawnSync, processExecPath = process.execPath }) {
  const followupEnv = buildRuntimeFollowupEnv(runtimeOptions, env);
  const reason = `region-sync:${Number(region?.id || 0) || 'unknown'}`;

  runWorkerScript({
    label: 'search rebuild worker',
    scriptPath: path.join(rootDir, 'workers', 'rebuild-search-index.worker.js'),
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
    scriptPath: path.join(rootDir, 'workers', 'rebuild-filter-tag-keys-cache.worker.js'),
    env: {
      ...followupEnv,
      FILTER_TAG_KEYS_REBUILD_REASON: reason
    },
    rootDir,
    spawnSyncRef,
    processExecPath
  });
}

function buildPmtilesStep(region, geojsonPath, outputPath) {
  buildPmtilesFromGeojson({
    region,
    geojsonPath,
    outputPath,
    progressJson: TIPPECANOE_PROGRESS_JSON,
    progressIntervalSec: TIPPECANOE_PROGRESS_INTERVAL_SEC,
    env: process.env
  });
}

async function buildRegionPmtilesOnly(region, runtimeOptions) {
  const workspace = createWorkspace(region.id);
  const exportedNdjsonPath = path.join(workspace, 'current-region-export.ndjson');
  const geojsonPath = path.join(workspace, 'region-build.ndjson');
  const builtPmtilesPath = path.join(workspace, 'region.pmtiles');

  try {
    await exportRegionMembersToNdjson({
      ...runtimeOptions,
      regionId: region.id,
      outputPath: exportedNdjsonPath
    });

    const exported = await exportImportRowsToGeojson(exportedNdjsonPath, geojsonPath);
    if (exported.importedFeatureCount <= 0) {
      throw new Error('Region has no features, PMTiles rebuild aborted');
    }

    buildPmtilesStep(region, geojsonPath, builtPmtilesPath);
    const finalArchivePath = publishPmtilesArchive({
      dataDir: runtimeOptions.dataDir,
      region,
      builtPmtilesPath
    });

    return {
      importedFeatureCount: exported.importedFeatureCount,
      activeFeatureCount: exported.importedFeatureCount,
      orphanDeletedCount: 0,
      pmtilesBytes: Number(fs.statSync(finalArchivePath).size || 0),
      pmtilesPath: finalArchivePath,
      bounds: exported.bounds
    };
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
}

async function runRegionSync(region, runtimeOptions) {
  const workspace = createWorkspace(region.id);
  const importPath = path.join(workspace, 'region-import.ndjson');
  const geojsonPath = path.join(workspace, 'region-build.ndjson');
  const builtPmtilesPath = path.join(workspace, 'region.pmtiles');
  const importerPath = path.join(__dirname, 'sync-osm-buildings.py');

  try {
    let exported = null;
    if (runtimeOptions.dbProvider === 'postgres') {
      exportRegionExtractToNdjson({
        importerPath,
        region,
        dbOutputPath: importPath,
        geojsonOutputPath: geojsonPath,
        env: process.env
      });
      exported = await summarizeImportRows(importPath, { requireGeometryWkbHex: true });
    } else {
      exportRegionExtractToNdjson({
        importerPath,
        region,
        outputPath: importPath,
        env: process.env
      });
      exported = await exportImportRowsToGeojson(importPath, geojsonPath);
    }

    if (exported.importedFeatureCount <= 0) {
      throw new Error('Sync returned 0 features; keeping previous PMTiles and current data untouched');
    }

    buildPmtilesStep(region, geojsonPath, builtPmtilesPath);
    const dbResult = await applyRegionImport({
      ...runtimeOptions,
      region,
      ndjsonPath: importPath,
      builtPmtilesPath
    });
    if (shouldRunRuntimeFollowup({ pmtilesOnly: false, env: process.env })) {
      runRuntimeFollowups({
        region,
        runtimeOptions
      });
    }

    return {
      ...dbResult,
      bounds: exported.bounds
    };
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
}

async function main() {
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

  console.log(`SYNC_RESULT_JSON=${JSON.stringify({
    regionId: region.id,
    importedFeatureCount: summary.importedFeatureCount,
    activeFeatureCount: summary.activeFeatureCount,
    orphanDeletedCount: summary.orphanDeletedCount,
    pmtilesBytes: summary.pmtilesBytes,
    pmtilesPath: summary.pmtilesPath,
    bounds: summary.bounds || null
  })}`);
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
  runRuntimeFollowups,
  runRegionSync,
  shouldRunRuntimeFollowup
};
