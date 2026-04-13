const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { moveFileSync } = require('../../src/lib/server/utils/fs');
const {
  closeWriteStream,
  ensureDir,
  formatGeojsonFeatureLine,
  readImportRows,
  updateBounds,
  writeStreamLine
} = require('./common');
const { expandRowsWithBuildingRemainders } = require('./building-remainder');

const KM_PER_DEGREE_LAT = 111.32;
const DEFAULT_SHARD_KM = 60;
// Default `null` means "use the adaptive floor derived from bbox size and
// feature count". Setting REGION_SYNC_SHARD_MIN_FEATURES explicitly keeps the
// old override behavior, including `0` for benchmarking/always-shard runs.
const DEFAULT_SHARD_MIN_FEATURES = null;
const MAX_SHARD_CELL_COUNT = 400;
const SHARD_CACHE_MANIFEST_VERSION = 1;

function replaceFileSync(sourcePath, targetPath) {
  const backupPath = `${targetPath}.bak`;
  if (fs.existsSync(backupPath)) {
    fs.rmSync(backupPath, { force: true });
  }
  const hadExistingFile = fs.existsSync(targetPath);
  if (hadExistingFile) {
    moveFileSync(targetPath, backupPath);
  }
  try {
    moveFileSync(sourcePath, targetPath);
  } catch (error) {
    if (hadExistingFile && fs.existsSync(backupPath)) {
      try {
        moveFileSync(backupPath, targetPath);
      } catch {
        // ignore restore failure; original error is still thrown below
      }
    }
    throw error;
  }
  if (fs.existsSync(backupPath)) {
    fs.rmSync(backupPath, { force: true });
  }
}

function normalizeRegionBounds(bounds) {
  if (!bounds || typeof bounds !== 'object') return null;
  const normalized = {
    west: Number(bounds.west),
    south: Number(bounds.south),
    east: Number(bounds.east),
    north: Number(bounds.north)
  };
  if (![normalized.west, normalized.south, normalized.east, normalized.north].every(Number.isFinite)) {
    return null;
  }
  return normalized;
}

function buildGridSignature({ region, grid, shardKm, cacheSalt = '' }) {
  const payload = {
    regionId: Number(region?.id || 0) || null,
    sourceLayer: String(region?.sourceLayer || 'buildings'),
    pmtilesMinZoom: Number(region?.pmtilesMinZoom || 13),
    pmtilesMaxZoom: Number(region?.pmtilesMaxZoom || 16),
    shardKm: Number(shardKm || 0),
    grid: grid
      ? {
          minLon: Number(grid.minLon),
          minLat: Number(grid.minLat),
          latStep: Number(grid.latStep),
          lonStep: Number(grid.lonStep),
          rows: Number(grid.rows),
          cols: Number(grid.cols),
          cellCount: Number(grid.cellCount)
        }
      : null,
    cacheSalt: String(cacheSalt || '')
  };
  return JSON.stringify(payload);
}

function getAdaptiveShardFeatureFloor(grid, env = process.env) {
  const explicit = resolveShardMinFeatures(env);
  if (explicit !== null) {
    return Math.max(0, Math.trunc(explicit));
  }
  const cellCount = Number(grid?.cellCount || 0);
  if (!Number.isFinite(cellCount) || cellCount <= 1) {
    return Number.POSITIVE_INFINITY;
  }
  return Math.max(8_000, Math.min(60_000, Math.round(cellCount * 1_500)));
}

function getShardCacheDir(shardCacheRootDir, gridSignature) {
  const root = String(shardCacheRootDir || '').trim();
  if (!root) return null;
  const signature = String(gridSignature || '').trim();
  if (!signature) return null;
  const signatureKey = crypto.createHash('sha256').update(signature).digest('hex').slice(0, 24);
  return path.join(root, signatureKey);
}

function loadShardCacheManifest(cacheDir) {
  const manifestPath = path.join(cacheDir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    return null;
  }
  try {
    const payload = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    if (!payload || typeof payload !== 'object') return null;
    if (Number(payload.version) !== SHARD_CACHE_MANIFEST_VERSION) return null;
    if (!payload.gridSignature || typeof payload.gridSignature !== 'string') return null;
    if (!payload.shards || typeof payload.shards !== 'object') return null;
    return payload;
  } catch {
    return null;
  }
}

function writeShardCacheManifest(cacheDir, manifest) {
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.writeFileSync(path.join(cacheDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}

function runCommand(exe, args, options: LooseRecord = {}) {
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

function detectTileJoinExecutable(env = process.env) {
  const envBin = String(env.TILE_JOIN_BIN || '').trim();
  const candidates = envBin ? [envBin] : ['tile-join'];
  for (const exe of candidates) {
    // tile-join has no --version flag; calling it with no args prints usage
    // and exits non-zero, so we treat "spawn succeeded, binary was located"
    // as proof of availability. `error` is populated when the binary cannot
    // be found at all.
    const probe = spawnSync(exe, [], { stdio: 'ignore', shell: false, env });
    if (!probe.error) return exe;
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
    const rows = [];
    for await (const row of readImportRows(importPath, { requireGeometryJson: true })) {
      rows.push(row);
    }
    for (const row of expandRowsWithBuildingRemainders(rows)) {
      await writeStreamLine(
        out,
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
    await closeWriteStream(out);
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

function tippecanoeArgsForRegion({ region, inputPath, outputPath, progressJson, progressIntervalSec }) {
  const args = [
    '-o', outputPath,
    '-f',
    '-l', String(region.sourceLayer || 'buildings'),
    '-Z', String(region.pmtilesMinZoom),
    '-z', String(region.pmtilesMaxZoom),
    '--read-parallel',
    '--detect-shared-borders',
    '--coalesce-densest-as-needed',
    '--extend-zooms-if-still-dropping',
    '--progress-interval', String(progressIntervalSec)
  ];
  if (progressJson) {
    args.push('--json-progress');
  }
  args.push(inputPath);
  return args;
}

function runTippecanoe({
  tippecanoeExe,
  region,
  inputPath,
  outputPath,
  progressJson,
  progressIntervalSec,
  env
}: LooseRecord) {
  ensureDir(outputPath);
  const args = tippecanoeArgsForRegion({
    region,
    inputPath,
    outputPath,
    progressJson,
    progressIntervalSec
  });
  const built = runCommand(tippecanoeExe, args, { env });
  if (!built.ok) {
    throw new Error(`tippecanoe failed with exit code ${built.status}`);
  }
}

function runTileJoin({ tileJoinExe, region, inputs, outputPath, env }: LooseRecord) {
  ensureDir(outputPath);
  const args = [
    '-o', outputPath,
    '-f',
    '-n', String(region.sourceLayer || 'buildings'),
    '--no-tile-size-limit',
    ...inputs
  ];
  const joined = runCommand(tileJoinExe, args, { env });
  if (!joined.ok) {
    throw new Error(`tile-join failed with exit code ${joined.status}`);
  }
}

function resolveShardKm(shardKm, env = process.env) {
  const explicit = Number.isFinite(shardKm) ? Number(shardKm) : NaN;
  if (Number.isFinite(explicit)) {
    return Math.max(0, explicit);
  }
  const fromEnv = Number(env.REGION_SYNC_SHARD_KM);
  if (Number.isFinite(fromEnv)) {
    return Math.max(0, fromEnv);
  }
  return DEFAULT_SHARD_KM;
}

function resolveShardMinFeatures(env = process.env) {
  const fromEnv = Number(env.REGION_SYNC_SHARD_MIN_FEATURES);
  if (Number.isFinite(fromEnv) && fromEnv >= 0) {
    return Math.floor(fromEnv);
  }
  return DEFAULT_SHARD_MIN_FEATURES;
}

function planShardGrid(bounds, shardKm) {
  if (!bounds || !Number.isFinite(shardKm) || shardKm <= 0) {
    return null;
  }
  const { west, south, east, north } = bounds;
  if (![west, south, east, north].every(Number.isFinite)) {
    return null;
  }
  if (east <= west || north <= south) {
    return null;
  }

  const centerLat = (north + south) / 2;
  const lonPerKm = KM_PER_DEGREE_LAT * Math.max(0.05, Math.cos((centerLat * Math.PI) / 180));
  const latStep = shardKm / KM_PER_DEGREE_LAT;
  const lonStep = shardKm / lonPerKm;

  const rows = Math.max(1, Math.ceil((north - south) / latStep));
  const cols = Math.max(1, Math.ceil((east - west) / lonStep));
  const cellCount = rows * cols;

  return {
    minLon: west,
    minLat: south,
    latStep,
    lonStep,
    rows,
    cols,
    cellCount,
    shardKm
  };
}

function assignCellIndex(featureBounds, grid) {
  if (!featureBounds || !grid) return null;
  const lat = (featureBounds.south + featureBounds.north) / 2;
  const lon = (featureBounds.west + featureBounds.east) / 2;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return null;
  }
  const rowRaw = Math.floor((lat - grid.minLat) / grid.latStep);
  const colRaw = Math.floor((lon - grid.minLon) / grid.lonStep);
  const row = Math.min(grid.rows - 1, Math.max(0, rowRaw));
  const col = Math.min(grid.cols - 1, Math.max(0, colRaw));
  return { row, col, key: `${row}-${col}` };
}

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

async function writeShardNdjsons({ geojsonPath, grid, workspaceDir }) {
  if (!grid) {
    return { shards: [], skippedFeatureCount: 0 };
  }

  const shards = new Map();
  let skippedFeatureCount = 0;

  const stream = fs.createReadStream(geojsonPath, {
    encoding: 'utf8',
    highWaterMark: 1024 * 1024
  });
  let bufferedLine = '';

  async function ensureShardWriter(key) {
    if (shards.has(key)) return shards.get(key);
    if (shards.size >= MAX_SHARD_CELL_COUNT) {
      throw new Error(
        `Shard grid exceeded hard cap of ${MAX_SHARD_CELL_COUNT} non-empty cells; `
          + 'increase REGION_SYNC_SHARD_KM or disable sharding by setting it to 0'
      );
    }
    const shardPath = path.join(workspaceDir, `shard-${key}.ndjson`);
    ensureDir(shardPath);
    const writer = fs.createWriteStream(shardPath, {
      encoding: 'utf8',
      highWaterMark: 1024 * 1024
    });
    const entry = {
      key,
      path: shardPath,
      writer,
      count: 0,
      hash: crypto.createHash('sha256')
    };
    shards.set(key, entry);
    return entry;
  }

  async function handleLine(rawLine) {
    const trimmed = rawLine.trim();
    if (!trimmed) return;
    let feature;
    try {
      feature = JSON.parse(trimmed);
    } catch {
      skippedFeatureCount += 1;
      return;
    }
    const featureBounds = computeGeometryBounds(feature?.geometry);
    const cell = assignCellIndex(featureBounds, grid);
    if (!cell) {
      skippedFeatureCount += 1;
      return;
    }
    const shard = await ensureShardWriter(cell.key);
    const shardLine = `${trimmed}\n`;
    await writeStreamLine(shard.writer, shardLine);
    shard.hash.update(shardLine);
    shard.count += 1;
  }

  try {
    for await (const chunk of stream) {
      bufferedLine += String(chunk || '');
      let newlineIndex = bufferedLine.indexOf('\n');
      while (newlineIndex !== -1) {
        const line = bufferedLine.slice(0, newlineIndex);
        bufferedLine = bufferedLine.slice(newlineIndex + 1);
        await handleLine(line);
        newlineIndex = bufferedLine.indexOf('\n');
      }
    }
    if (bufferedLine.length > 0) {
      await handleLine(bufferedLine);
    }
  } finally {
    stream.destroy();
  }

  const shardList = [];
  for (const entry of shards.values()) {
    await closeWriteStream(entry.writer);
    shardList.push({
      key: entry.key,
      path: entry.path,
      count: entry.count,
      hash: entry.hash.digest('hex')
    });
  }
  shardList.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

  return {
    shards: shardList,
    skippedFeatureCount
  };
}

async function buildPmtilesFromGeojson({
  region,
  geojsonPath,
  outputPath,
  bounds = null,
  featureCount = null,
  shardKm,
  shardCacheDir = null,
  shardWorkspace = null,
  progressJson = true,
  progressIntervalSec = 5,
  onShardProgress = null,
  env = process.env
}: LooseRecord) {
  const reportShardProgress = (stageInfo) => {
    if (typeof onShardProgress !== 'function') return;
    try {
      onShardProgress(stageInfo);
    } catch {
      // progress reporting must never break the build
    }
  };
  const tippecanoeExe = detectTippecanoeExecutable(env);
  if (!tippecanoeExe) {
    throw new Error('tippecanoe is not available. Install tippecanoe or set TIPPECANOE_BIN.');
  }

  const resolvedShardKm = resolveShardKm(shardKm, env);
  const effectiveBounds = normalizeRegionBounds(bounds) || normalizeRegionBounds(region?.bounds) || null;
  const grid = planShardGrid(effectiveBounds, resolvedShardKm);
  const normalizedFeatureCount = Number.isFinite(featureCount) ? Number(featureCount) : null;
  const shardFeatureFloor = getAdaptiveShardFeatureFloor(grid, env);
  const meetsShardFeatureFloor = normalizedFeatureCount === null
    || normalizedFeatureCount >= shardFeatureFloor;
  const shardingEnabled = Boolean(
    grid
    && grid.cellCount > 1
    && resolvedShardKm > 0
    && meetsShardFeatureFloor
  );

  if (!shardingEnabled) {
    reportShardProgress({
      progress: null,
      detail: 'tippecanoe (single pass)'
    });
    runTippecanoe({
      tippecanoeExe,
      region,
      inputPath: geojsonPath,
      outputPath,
      progressJson,
      progressIntervalSec,
      env
    });
    return {
      mode: 'single',
      shardCount: 1,
      grid,
      reusedShardCount: 0,
      rebuiltShardCount: 0,
      cacheDir: null
    };
  }

  const tileJoinExe = detectTileJoinExecutable(env);
  if (!tileJoinExe) {
    throw new Error('tile-join is not available. Install tippecanoe (which ships tile-join) or set TILE_JOIN_BIN.');
  }

  const workspaceDir = String(shardWorkspace || '').trim()
    || path.join(path.dirname(outputPath), `shards-${path.basename(outputPath, '.pmtiles')}`);
  fs.mkdirSync(workspaceDir, { recursive: true });

  const shardPmtilesPaths = [];
  const temporaryShardOutputs = [];
  let shardPlan: LooseRecord = { shards: [], skippedFeatureCount: 0 };
  const shardCacheRootDir = String(shardCacheDir || '').trim();
  const gridSignature = buildGridSignature({
    region,
    grid,
    shardKm: resolvedShardKm,
    cacheSalt: effectiveBounds
      ? `${effectiveBounds.west},${effectiveBounds.south},${effectiveBounds.east},${effectiveBounds.north}`
      : ''
  });
  const effectiveShardCacheDir = getShardCacheDir(shardCacheRootDir, gridSignature);
  const shardCacheEntriesDir = effectiveShardCacheDir ? path.join(effectiveShardCacheDir, 'shards') : null;
  const shardCacheManifest = effectiveShardCacheDir ? loadShardCacheManifest(effectiveShardCacheDir) : null;
  const shardCacheManifestByKey = new Map(
    Object.entries(shardCacheManifest?.shards || {}).map(([key, value]) => [key, value])
  );
  if (shardCacheEntriesDir) {
    fs.mkdirSync(shardCacheEntriesDir, { recursive: true });
  }
  let reusedShardCount = 0;
  let rebuiltShardCount = 0;

  try {
    shardPlan = await writeShardNdjsons({ geojsonPath, grid, workspaceDir });

    if (shardPlan.shards.length <= 1) {
      reportShardProgress({
        progress: null,
        detail: 'tippecanoe (collapsed to single pass)'
      });
      runTippecanoe({
        tippecanoeExe,
        region,
        inputPath: geojsonPath,
        outputPath,
        progressJson,
        progressIntervalSec,
        env
      });
      return {
        mode: 'single-collapsed',
        shardCount: 1,
        grid,
        reusedShardCount: 0,
        rebuiltShardCount: 0,
        cacheDir: effectiveShardCacheDir
      };
    }

    console.log(
      `[region-sync] sharded pmtiles build: ${shardPlan.shards.length} cells, `
        + `${resolvedShardKm}km grid (${grid.rows}x${grid.cols}), `
        + `${shardPlan.skippedFeatureCount} skipped features`
    );

    const totalShards = shardPlan.shards.length;
    const shardSharePercent = 100 / totalShards;
    for (let index = 0; index < totalShards; index += 1) {
      const shard = shardPlan.shards[index];
      const finalShardPath = effectiveShardCacheDir
        ? path.join(shardCacheEntriesDir, `shard-${shard.key}.pmtiles`)
        : path.join(workspaceDir, `shard-${shard.key}.pmtiles`);
      const cachedShardMeta = shardCacheManifestByKey.get(shard.key) as LooseRecord | undefined;
      const cacheHit = Boolean(
        effectiveShardCacheDir
        && cachedShardMeta
        && String(cachedShardMeta.hash || '') === shard.hash
        && fs.existsSync(finalShardPath)
      );
      console.log(
        `[region-sync] shard ${index + 1}/${totalShards} `
          + `key=${shard.key} features=${shard.count} ${cacheHit ? 'cache-hit' : 'dirty'}`
      );
      reportShardProgress({
        stage: 'build',
        progress: Math.round(index * shardSharePercent),
        detail: cacheHit
          ? `cached shard ${index + 1}/${totalShards}`
          : `tippecanoe shard ${index + 1}/${totalShards}`
      });
      if (!cacheHit) {
        const shardOutputPath = effectiveShardCacheDir
          ? path.join(workspaceDir, `shard-${shard.key}.pmtiles`)
          : finalShardPath;
        runTippecanoe({
          tippecanoeExe,
          region,
          inputPath: shard.path,
          outputPath: shardOutputPath,
          progressJson,
          progressIntervalSec,
          env
        });
        if (effectiveShardCacheDir) {
          replaceFileSync(shardOutputPath, finalShardPath);
          temporaryShardOutputs.push(shardOutputPath);
        }
        rebuiltShardCount += 1;
      } else {
        reusedShardCount += 1;
      }
      shardPmtilesPaths.push(finalShardPath);
      try {
        fs.rmSync(shard.path, { force: true });
      } catch {
        // best-effort cleanup of intermediate ndjson shard
      }
    }

    reportShardProgress({
      stage: 'tile_join',
      progress: null,
      detail: `tile-join: merging ${totalShards} shards (${reusedShardCount} cached, ${rebuiltShardCount} rebuilt)`
    });
    runTileJoin({
      tileJoinExe,
      region,
      inputs: shardPmtilesPaths,
      outputPath,
      env
    });
    reportShardProgress({
      stage: 'tile_join',
      progress: 100,
      detail: `tile-join done (${totalShards} shards, ${reusedShardCount} cached, ${rebuiltShardCount} rebuilt)`
    });

    if (effectiveShardCacheDir) {
      writeShardCacheManifest(effectiveShardCacheDir, {
        version: SHARD_CACHE_MANIFEST_VERSION,
        gridSignature,
        regionId: Number(region?.id || 0) || null,
        shardKm: resolvedShardKm,
        bounds: effectiveBounds,
        featureCount: Number.isFinite(normalizedFeatureCount) ? normalizedFeatureCount : null,
        shardCount: totalShards,
        skippedFeatureCount: shardPlan.skippedFeatureCount,
        reusedShardCount,
        rebuiltShardCount,
        shards: Object.fromEntries(
          shardPlan.shards.map((shard) => [shard.key, { hash: shard.hash, count: shard.count }])
        ),
        updatedAt: new Date().toISOString()
      });
    }

    return {
      mode: effectiveShardCacheDir ? 'sharded-cache' : 'sharded',
      shardCount: shardPlan.shards.length,
      grid,
      skippedFeatureCount: shardPlan.skippedFeatureCount,
      reusedShardCount,
      rebuiltShardCount,
      cacheDir: effectiveShardCacheDir
    };
  } finally {
    for (const shardOutput of temporaryShardOutputs) {
      try {
        fs.rmSync(shardOutput, { force: true });
      } catch {
        // best-effort cleanup of intermediate shard archives
      }
    }
    try {
      fs.rmSync(workspaceDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup failure
    }
  }
}

module.exports = {
  assignCellIndex,
  buildPmtilesFromGeojson,
  computeGeometryBounds,
  DEFAULT_SHARD_KM,
  DEFAULT_SHARD_MIN_FEATURES,
  exportImportRowsToGeojson,
  planShardGrid,
  resolveShardKm,
  resolveShardMinFeatures,
  summarizeImportRows,
  writeShardNdjsons
};
