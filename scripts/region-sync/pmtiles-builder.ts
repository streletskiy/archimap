const fs = require('fs');
const {
  closeWriteStream,
  ensureDir,
  formatGeojsonFeatureLine,
  readImportRows,
  updateBounds,
  writeStreamLine
} = require('./common');
const { expandRowsWithBuildingRemainders } = require('./building-remainder');
const { runPlanetilerBuild } = require('./planetiler');

const REGION_PMTILES_ATTRIBUTE_KEYS = Object.freeze([
  'feature_kind',
  'osm_id',
  'osm_key',
  'osm_type',
  'render_height_m',
  'render_hide_base_when_parts',
  'render_min_height_m'
]);

function walkCoordinatesForBounds(node, acc) {
  if (!Array.isArray(node)) return;
  if (node.length >= 2 && typeof node[0] === 'number' && typeof node[1] === 'number') {
    const lon = node[0];
    const lat = node[1];
    if (acc.west === null || lon < acc.west) acc.west = lon;
    if (acc.east === null || lon > acc.east) acc.east = lon;
    if (acc.south === null || lat < acc.south) acc.south = lat;
    if (acc.north === null || lat > acc.north) acc.north = lat;
    return;
  }
  for (const child of node) {
    walkCoordinatesForBounds(child, acc);
  }
}

function computeGeometryBounds(geometry) {
  if (!geometry || typeof geometry !== 'object') return null;
  const acc = { west: null, south: null, east: null, north: null };
  if (geometry.type === 'GeometryCollection' && Array.isArray(geometry.geometries)) {
    for (const child of geometry.geometries) {
      const childBounds = computeGeometryBounds(child);
      if (!childBounds) continue;
      if (acc.west === null || childBounds.west < acc.west) acc.west = childBounds.west;
      if (acc.east === null || childBounds.east > acc.east) acc.east = childBounds.east;
      if (acc.south === null || childBounds.south < acc.south) acc.south = childBounds.south;
      if (acc.north === null || childBounds.north > acc.north) acc.north = childBounds.north;
    }
  } else {
    walkCoordinatesForBounds(geometry.coordinates, acc);
  }
  if (acc.west === null || acc.east === null || acc.south === null || acc.north === null) {
    return null;
  }
  return acc;
}

async function exportImportRowsToGeojson(importPath, geojsonPath) {
  ensureDir(geojsonPath);
  const writer = fs.createWriteStream(geojsonPath, {
    encoding: 'utf8',
    highWaterMark: 1024 * 1024
  });
  let importedFeatureCount = 0;
  let bounds = null;

  try {
    const rows = [];
    for await (const row of readImportRows(importPath, { requireGeometryJson: true })) {
      rows.push(row);
    }
    for (const row of expandRowsWithBuildingRemainders(rows)) {
      await writeStreamLine(
        writer,
        formatGeojsonFeatureLine(
          row.osm_type,
          row.osm_id,
          row.geometry_json,
          row.tags_json,
          row.feature_kind,
          row.render_hide_base_when_parts
        )
      );
      importedFeatureCount += 1;
      bounds = updateBounds(bounds, row);
    }
  } finally {
    await closeWriteStream(writer);
  }

  return {
    importedFeatureCount,
    bounds
  };
}

async function summarizeImportRows(importPath, options: LooseRecord = {}) {
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

function runPlanetilerForRegion({ region, inputPath, outputPath, env }: LooseRecord) {
  return runPlanetilerBuild({
    inputPath,
    outputPath,
    schemaName: `ArchiMap ${String(region?.slug || region?.name || 'region').trim() || 'region'} PMTiles`,
    layer: String(region?.sourceLayer || 'buildings'),
    minZoom: Number(region?.pmtilesMinZoom || 13),
    maxZoom: Number(region?.pmtilesMaxZoom || 16),
    attributeKeys: REGION_PMTILES_ATTRIBUTE_KEYS,
    includeFeatureId: true,
    env
  });
}

async function buildPmtilesFromGeojson({
  region,
  geojsonPath,
  outputPath,
  onShardProgress = null,
  env = process.env
}: LooseRecord) {
  if (typeof onShardProgress === 'function') {
    try {
      onShardProgress({
        stage: 'build',
        progress: null,
        detail: 'planetiler (single pass)'
      });
    } catch {
      // progress reporting must never break the build
    }
  }

  runPlanetilerForRegion({
    region,
    inputPath: geojsonPath,
    outputPath,
    env
  });

  return {
    engine: 'planetiler',
    mode: 'single',
    shardCount: 1,
    reusedShardCount: 0,
    rebuiltShardCount: 0,
    cacheDir: null
  };
}

module.exports = {
  buildPmtilesFromGeojson,
  computeGeometryBounds,
  exportImportRowsToGeojson,
  summarizeImportRows
};
