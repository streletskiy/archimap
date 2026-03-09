require('dotenv').config({ quiet: true });

const fs = require('fs');
const path = require('path');

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
  exportImportRowsToGeojson
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
const DATA_DIR = String(process.env.ARCHIMAP_DATA_DIR || path.join(__dirname, '..', 'data')).trim() || path.join(__dirname, '..', 'data');
const TIPPECANOE_PROGRESS_JSON = String(process.env.TIPPECANOE_PROGRESS_JSON ?? 'true').toLowerCase() === 'true';
const TIPPECANOE_PROGRESS_INTERVAL_SEC = Math.max(1, Math.min(300, Number(process.env.TIPPECANOE_PROGRESS_INTERVAL_SEC || 5)));

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
    dataDir: DATA_DIR
  };
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
    exportRegionExtractToNdjson({
      importerPath,
      region,
      outputPath: importPath,
      env: process.env
    });

    const exported = await exportImportRowsToGeojson(importPath, geojsonPath);
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
  buildRegionPmtilesOnly,
  createRuntimeOptions,
  main,
  parseArgs,
  runRegionSync
};
