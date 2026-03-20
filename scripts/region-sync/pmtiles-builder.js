const fs = require('fs');
const { spawnSync } = require('child_process');
const {
  closeWriteStream,
  ensureDir,
  formatGeojsonFeatureLine,
  readImportRows,
  updateBounds,
  writeStreamLine
} = require('./common');

function runCommand(exe, args, options = {}) {
  const result = spawnSync(exe, args, {
    stdio: options.stdio || 'inherit',
    shell: false,
    env: options.env || process.env
  });
  return { ok: result.status === 0, status: result.status ?? 1 };
}

function detectTippecanoeExecutable(env = process.env) {
  const envBin = String(env.TIPPECANOE_BIN || '').trim();
  const candidates = envBin ? [envBin] : ['tippecanoe'];
  for (const exe of candidates) {
    const probe = runCommand(exe, ['--version'], { stdio: 'pipe', env });
    if (probe.ok) return exe;
  }
  return null;
}

async function exportImportRowsToGeojson(importPath, geojsonPath) {
  ensureDir(geojsonPath);
  const out = fs.createWriteStream(geojsonPath, {
    encoding: 'utf8',
    highWaterMark: 1024 * 1024
  });
  let importedFeatureCount = 0;
  let bounds = null;

  try {
    for await (const row of readImportRows(importPath, { requireGeometryJson: true })) {
      await writeStreamLine(
        out,
        formatGeojsonFeatureLine(row.osm_type, row.osm_id, row.geometry_json, row.tags_json, row.feature_kind)
      );
      importedFeatureCount += 1;
      bounds = updateBounds(bounds, row);
    }
  } finally {
    await closeWriteStream(out);
  }

  return {
    importedFeatureCount,
    bounds
  };
}

async function summarizeImportRows(importPath, options = {}) {
  let importedFeatureCount = 0;
  let bounds = null;

  for await (const row of readImportRows(importPath, options)) {
    importedFeatureCount += 1;
    bounds = updateBounds(bounds, row);
  }

  return {
    importedFeatureCount,
    bounds
  };
}

function buildPmtilesFromGeojson({
  region,
  geojsonPath,
  outputPath,
  progressJson = true,
  progressIntervalSec = 5,
  env = process.env
}) {
  const tippecanoeExe = detectTippecanoeExecutable(env);
  if (!tippecanoeExe) {
    throw new Error('tippecanoe is not available. Install tippecanoe or set TIPPECANOE_BIN.');
  }

  ensureDir(outputPath);
  const tippecanoeArgs = [
    '-o', outputPath,
    '-f',
    '-l', String(region.sourceLayer || 'buildings'),
    '-Z', String(region.pmtilesMinZoom),
    '-z', String(region.pmtilesMaxZoom),
    '--read-parallel',
    '--detect-shared-borders',
    '--coalesce-densest-as-needed',
    '--extend-zooms-if-still-dropping',
    '--progress-interval', String(progressIntervalSec),
    geojsonPath
  ];
  if (progressJson) {
    tippecanoeArgs.splice(tippecanoeArgs.length - 1, 0, '--json-progress');
  }

  const built = runCommand(tippecanoeExe, tippecanoeArgs, { env });
  if (!built.ok) {
    throw new Error(`tippecanoe failed with exit code ${built.status}`);
  }
}

module.exports = {
  buildPmtilesFromGeojson,
  exportImportRowsToGeojson,
  summarizeImportRows
};
