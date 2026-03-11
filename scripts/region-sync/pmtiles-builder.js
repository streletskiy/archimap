const fs = require('fs');
const { spawnSync } = require('child_process');
const {
  encodeOsmFeatureId,
  ensureDir,
  readImportRows
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
  const out = fs.createWriteStream(geojsonPath, { encoding: 'utf8' });
  let importedFeatureCount = 0;
  let bounds = null;

  try {
    for await (const row of readImportRows(importPath)) {
      const geometry = JSON.parse(row.geometry_json);
      const feature = {
        type: 'Feature',
        id: encodeOsmFeatureId(row.osm_type, row.osm_id),
        properties: {
          osm_id: Number(row.osm_id)
        },
        geometry
      };
      out.write(`${JSON.stringify(feature)}\n`);
      importedFeatureCount += 1;
      bounds = bounds
        ? {
          west: Math.min(bounds.west, row.min_lon),
          south: Math.min(bounds.south, row.min_lat),
          east: Math.max(bounds.east, row.max_lon),
          north: Math.max(bounds.north, row.max_lat)
        }
        : {
          west: row.min_lon,
          south: row.min_lat,
          east: row.max_lon,
          north: row.max_lat
        };
    }
  } finally {
    await new Promise((resolve, reject) => {
      out.end((error) => {
        if (error) return reject(error);
        return resolve();
      });
    });
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
  exportImportRowsToGeojson
};
