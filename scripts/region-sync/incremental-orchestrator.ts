/*
 * Incremental region-sync driver.
 *
 * Given a previous snapshot (prev.pbf + prev NDJSONs) and a new PBF, this
 * module:
 *   1. Runs `osmium derive-changes` to get the OsmChange between the two PBFs.
 *   2. Classifies changed ways/relations as building-relevant, and spatially
 *      expands touched node ids into the set of prev buildings whose bbox
 *      contained the node's previous position (so node-only geometry edits
 *      still invalidate referencing ways).
 *   3. Extracts a subset PBF containing only the affected ids (plus their
 *      referenced nodes) and runs the Python importer against that subset
 *      with `--osm-id-filter-file`, producing delta NDJSONs.
 *   4. Merges the delta NDJSONs on top of the prev NDJSONs — replacing
 *      changed objects, removing deleted objects, preserving sort order.
 *   5. Hands the merged NDJSONs to the existing DB apply + PMTiles build
 *      steps. Orphan cleanup in applyRegionImport drops buildings that
 *      fell out of the merged set.
 *   6. Atomically commits a new snapshot into the incremental cache.
 *
 * Everything is feature-flagged via REGION_SYNC_INCREMENTAL=true and keyed
 * on `REGION_SYNC_NEW_PBF` (caller must provide the local PBF path — the
 * default quackosm-driven path doesn't expose it yet).
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const {
  runDeriveChanges,
  parseChangeset,
  selectBuildingChanges,
  writeOsmIdFilterFile,
  extractSubsetPbf
} = require('./osmium-diff');
const { expandAffectedByNodeChanges } = require('./spatial-expansion');
const { mergeBuildNdjson } = require('./ndjson-merge');
const {
  resolveIncrementalCachePaths,
  snapshotExists,
  commitIncrementalSnapshot
} = require('./incremental-cache');
const { ensurePythonImporterDeps } = require('./python-extractor');

type RegionLike = { id?: number | string; slug?: string | null; bounds?: unknown };

type RunIncrementalOptions = {
  region: RegionLike;
  runtimeOptions: { dataDir: string; [k: string]: unknown };
  newPbf: string;
  workspace: string;
  importerPath: string;
  dbGeometryMode: string;
  env?: NodeJS.ProcessEnv;
  osmiumBin?: string;
  onStage?: (stage: string, detail?: string | null) => void;
};

type IncrementalResult = {
  ok: true;
  mode: 'incremental';
  importerDurationMs: number;
  affectedObjectIds: number;
  touchedNodeIds: number;
  spatiallyExpandedIds: number;
  deletedIds: number;
  subsetPbfPath: string | null;
  mergedBuildPath: string;
  mergedImportPath: string;
  mergeBuildStats: Record<string, number>;
  mergeImportStats: Record<string, number>;
  sourceSnapshot: {
    extractSource: string | null;
    extractId: string | null;
    sha256: string;
    sizeBytes: number;
    sourceMtime: string;
    localPath: string;
  };
};

type IncrementalSkip = { ok: false; reason: string; detail?: string };

async function hashFile(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

function emit(onStage: RunIncrementalOptions['onStage'], stage: string, detail?: string | null): void {
  if (typeof onStage === 'function') {
    try {
      onStage(stage, detail ?? null);
    } catch {
      // stage reporters are best-effort
    }
  }
}

function buildSourceSnapshotFromLocalPbf(pbfPath: string, pbfSha256: string): IncrementalResult['sourceSnapshot'] {
  const stat = fs.statSync(pbfPath);
  const fileName = path.basename(pbfPath);
  return {
    extractSource: inferExtractSource(fileName),
    extractId: fileName,
    sha256: pbfSha256,
    sizeBytes: Number(stat.size),
    sourceMtime: new Date(stat.mtimeMs).toISOString(),
    localPath: path.resolve(pbfPath)
  };
}

function inferExtractSource(fileName: string): string | null {
  const normalized = String(fileName || '').toLowerCase();
  if (!normalized) return null;
  if (normalized.includes('geofabrik')) return 'geofabrik';
  if (normalized.includes('bbbike')) return 'bbbike';
  if (normalized.includes('osmfr') || normalized.includes('openstreetmap.fr')) return 'osmfr';
  return null;
}

function runImporterSubset(options: {
  importerPath: string;
  pythonCandidate: { exe: string; prefixArgs: string[] };
  pbf: string;
  osmIdFilterFile: string;
  dbOutputPath: string;
  geojsonOutputPath: string;
  summaryOutputPath: string;
  dbGeometryMode: string;
  env: NodeJS.ProcessEnv;
}): { durationMs: number } {
  const args = [
    options.importerPath,
    '--pbf',
    options.pbf,
    '--osm-id-filter-file',
    options.osmIdFilterFile,
    '--out-db-ndjson',
    options.dbOutputPath,
    '--out-geojson-ndjson',
    options.geojsonOutputPath,
    '--out-summary-json',
    options.summaryOutputPath,
    '--db-geometry-mode',
    options.dbGeometryMode
  ];
  const started = Date.now();
  const result = spawnSync(
    options.pythonCandidate.exe,
    [...options.pythonCandidate.prefixArgs, ...args],
    {
      stdio: 'inherit',
      env: { ...options.env, IMPORT_LIMIT: '0' }
    }
  );
  if (result?.error) {
    throw result.error;
  }
  if ((result?.status ?? 1) !== 0) {
    throw new Error(`Subset importer failed with exit code ${result?.status ?? 1}`);
  }
  return { durationMs: Date.now() - started };
}

async function runIncrementalRegionSync(options: RunIncrementalOptions): Promise<IncrementalResult | IncrementalSkip> {
  const env = options.env || process.env;
  const onStage = options.onStage;

  if (!options.newPbf || !fs.existsSync(options.newPbf)) {
    return { ok: false, reason: 'missing_new_pbf', detail: String(options.newPbf || '') };
  }

  const prevPaths = resolveIncrementalCachePaths(
    String(options.runtimeOptions.dataDir || ''),
    options.region
  );
  if (!snapshotExists(prevPaths)) {
    return { ok: false, reason: 'no_prev_snapshot', detail: prevPaths.root };
  }

  fs.mkdirSync(options.workspace, { recursive: true });

  emit(onStage, 'diff', 'deriving OSC changeset');
  const oscPath = path.join(options.workspace, 'changes.osc');
  await runDeriveChanges({
    prevPbf: prevPaths.prevPbf,
    newPbf: options.newPbf,
    outOscPath: oscPath,
    osmiumBin: options.osmiumBin
  });

  const summary = await parseChangeset(oscPath);
  const selection = selectBuildingChanges(summary);

  emit(
    onStage,
    'diff',
    `directly affected=${selection.directlyAffected.size} touched nodes=${selection.touchedNodeIds.size}`
  );

  const spatial = await expandAffectedByNodeChanges({
    prevBuildNdjsonPath: prevPaths.prevBuildNdjson,
    prevPbf: prevPaths.prevPbf,
    modifiedNodeIds: selection.touchedNodeIds,
    osmiumBin: options.osmiumBin
  });

  const affectedForSubset = new Set<string>(selection.directlyAffected);
  for (const id of spatial.affectedObjectIds) {
    affectedForSubset.add(id);
  }
  // Deletes don't need subset import — they're handled by the merge step's
  // delete list. Including them in the osmium-getid list just wastes I/O.
  for (const deleted of selection.deletedBuildingFeatureIds) {
    affectedForSubset.delete(deleted);
  }

  emit(
    onStage,
    'diff',
    `affected=${affectedForSubset.size} deleted=${selection.deletedBuildingFeatureIds.size}`
  );

  const pythonCandidate = ensurePythonImporterDeps(env);

  let deltaBuildPath: string | null = null;
  let deltaImportPath: string | null = null;
  let subsetPbfPath: string | null = null;
  let importerDurationMs = 0;

  if (affectedForSubset.size > 0) {
    const idFilterPath = path.join(options.workspace, 'osm-id-filter.txt');
    await writeOsmIdFilterFile(idFilterPath, affectedForSubset);

    emit(onStage, 'subset', `extracting ${affectedForSubset.size} features`);
    subsetPbfPath = path.join(options.workspace, 'subset.pbf');
    await extractSubsetPbf({
      newPbf: options.newPbf,
      featureIds: affectedForSubset,
      outputPbf: subsetPbfPath,
      osmiumBin: options.osmiumBin,
      addReferenced: true
    });

    emit(onStage, 'import', 'running subset importer');
    deltaBuildPath = path.join(options.workspace, 'delta-build.ndjson');
    deltaImportPath = path.join(options.workspace, 'delta-import.ndjson');
    const deltaSummaryPath = path.join(options.workspace, 'delta-summary.json');
    const importerResult = runImporterSubset({
      importerPath: options.importerPath,
      pythonCandidate,
      pbf: subsetPbfPath,
      osmIdFilterFile: idFilterPath,
      dbOutputPath: deltaImportPath,
      geojsonOutputPath: deltaBuildPath,
      summaryOutputPath: deltaSummaryPath,
      dbGeometryMode: options.dbGeometryMode,
      env
    });
    importerDurationMs = importerResult.durationMs;
  } else {
    emit(onStage, 'import', 'no affected features — skipping subset importer');
  }

  emit(onStage, 'merge', 'merging delta into prev NDJSON');
  const mergedBuildPath = path.join(options.workspace, 'region-build.ndjson');
  const mergedImportPath = path.join(options.workspace, 'region-import.ndjson');

  const deletedObjectKeys = Array.from(selection.deletedBuildingFeatureIds);

  const mergeBuildStats = await mergeBuildNdjson({
    previousPath: prevPaths.prevBuildNdjson,
    deltaPath: deltaBuildPath,
    deletedFeatureIds: deletedObjectKeys,
    outputPath: mergedBuildPath
  });
  const mergeImportStats = await mergeBuildNdjson({
    previousPath: prevPaths.prevImportNdjson,
    deltaPath: deltaImportPath,
    deletedFeatureIds: deletedObjectKeys,
    outputPath: mergedImportPath
  });

  emit(
    onStage,
    'merge',
    `build total=${mergeBuildStats.total} replaced=${mergeBuildStats.replacedByDelta} added=${mergeBuildStats.addedFromDelta} deleted=${mergeBuildStats.deletedFromPrev}`
  );

  const pbfSha256 = await hashFile(options.newPbf);
  const sourceSnapshot = buildSourceSnapshotFromLocalPbf(options.newPbf, pbfSha256);

  return {
    ok: true,
    mode: 'incremental',
    importerDurationMs,
    affectedObjectIds: affectedForSubset.size,
    touchedNodeIds: selection.touchedNodeIds.size,
    spatiallyExpandedIds: spatial.affectedObjectIds.size,
    deletedIds: selection.deletedBuildingFeatureIds.size,
    subsetPbfPath,
    mergedBuildPath,
    mergedImportPath,
    mergeBuildStats,
    mergeImportStats,
    sourceSnapshot
  };
}

async function commitIncrementalSuccess(options: {
  runtimeOptions: { dataDir: string };
  region: RegionLike;
  newPbf: string;
  mergedBuildPath: string;
  mergedImportPath: string;
  summaryJsonSource?: string | null;
}): Promise<string> {
  // applyRegionImport needs a summary.json alongside the NDJSONs when the
  // orchestrator tries to re-read it. We synthesize a minimal one from the
  // merged files — importedFeatureCount is the merged row total; bounds
  // come from the region itself (admin polygon bbox), which is what the
  // non-incremental path uses.
  const tmpSummary = `${options.mergedBuildPath}.summary.json`;
  const lineCount = await countNdjsonLines(options.mergedImportPath);
  fs.writeFileSync(
    tmpSummary,
    JSON.stringify(
      {
        importedFeatureCount: lineCount,
        bounds: options.region?.bounds || null,
        sourceSnapshot: null
      },
      null,
      2
    )
  );

  const paths = await commitIncrementalSnapshot({
    dataDir: options.runtimeOptions.dataDir,
    region: options.region,
    newPbf: options.newPbf,
    buildNdjson: options.mergedBuildPath,
    importNdjson: options.mergedImportPath,
    summaryJson: options.summaryJsonSource || tmpSummary
  });
  return paths.root;
}

async function countNdjsonLines(filePath: string): Promise<number> {
  if (!fs.existsSync(filePath)) return 0;
  const readline = require('readline');
  const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let count = 0;
  for await (const line of rl) {
    if (String(line || '').trim()) count += 1;
  }
  return count;
}

function isIncrementalEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return String(env.REGION_SYNC_INCREMENTAL || '').trim().toLowerCase() === 'true';
}

function resolveIncrementalNewPbf(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = String(env.REGION_SYNC_NEW_PBF || '').trim();
  if (!raw) return null;
  return path.resolve(raw);
}

module.exports = {
  runIncrementalRegionSync,
  commitIncrementalSuccess,
  countNdjsonLines,
  isIncrementalEnabled,
  resolveIncrementalNewPbf,
  buildSourceSnapshotFromLocalPbf,
  hashFile
};
