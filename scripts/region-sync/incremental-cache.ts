/*
 * Disk layout helper for the Phase 2 incremental region-sync cache.
 *
 * Each region keeps its last fully-synced snapshot in
 *   <dataDir>/regions/.incremental-cache/<regionKey>/
 * containing:
 *   - prev.pbf                  the PBF that produced the snapshot
 *   - prev-build.ndjson         region-build.ndjson from the prev run
 *   - prev-import.ndjson        region-import.ndjson from the prev run
 *   - prev-summary.json         region-export-summary.json from the prev run
 *   - meta.json                 { pbfSha256, pbfSize, syncedAt, regionId, regionSlug }
 *
 * Writes are done atomically via `<name>.tmp` + rename so a crashed run
 * can't leave a partial snapshot that would silently poison the next sync.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

type RegionLike = { id?: number | string | null; slug?: string | null };

type IncrementalCachePaths = {
  root: string;
  prevPbf: string;
  prevBuildNdjson: string;
  prevImportNdjson: string;
  prevSummaryJson: string;
  metaJson: string;
};

type IncrementalCacheMeta = {
  pbfSha256: string;
  pbfSize: number;
  syncedAt: string;
  regionId: number | null;
  regionSlug: string | null;
};

function safeRegionKey(region: RegionLike): string {
  const rawId = Number(region?.id || 0) || 'unknown';
  const rawSlug = String(region?.slug || 'region').trim() || 'region';
  const key = `${rawId}-${rawSlug}`;
  return key.replace(/[^a-z0-9._-]+/gi, '-');
}

function resolveIncrementalCacheDir(dataDir: string, region: RegionLike): string {
  const base = String(dataDir || '').trim();
  if (!base) {
    throw new Error('incremental-cache: dataDir is required');
  }
  return path.join(base, 'regions', '.incremental-cache', safeRegionKey(region));
}

function resolveIncrementalCachePaths(dataDir: string, region: RegionLike): IncrementalCachePaths {
  const root = resolveIncrementalCacheDir(dataDir, region);
  return {
    root,
    prevPbf: path.join(root, 'prev.pbf'),
    prevBuildNdjson: path.join(root, 'prev-build.ndjson'),
    prevImportNdjson: path.join(root, 'prev-import.ndjson'),
    prevSummaryJson: path.join(root, 'prev-summary.json'),
    metaJson: path.join(root, 'meta.json')
  };
}

function snapshotExists(paths: IncrementalCachePaths): boolean {
  return (
    fs.existsSync(paths.prevPbf) &&
    fs.existsSync(paths.prevBuildNdjson) &&
    fs.existsSync(paths.metaJson)
  );
}

function readMeta(paths: IncrementalCachePaths): IncrementalCacheMeta | null {
  try {
    const raw = fs.readFileSync(paths.metaJson, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    const sha = String(parsed.pbfSha256 || '').trim();
    if (!sha) return null;
    return {
      pbfSha256: sha,
      pbfSize: Number.isFinite(parsed.pbfSize) ? Number(parsed.pbfSize) : 0,
      syncedAt: String(parsed.syncedAt || '').trim() || new Date(0).toISOString(),
      regionId: Number.isFinite(parsed.regionId) ? Number(parsed.regionId) : null,
      regionSlug: parsed.regionSlug ? String(parsed.regionSlug) : null
    };
  } catch {
    return null;
  }
}

async function hashFile(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

function atomicCopy(srcPath: string, destPath: string): void {
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  const tmp = `${destPath}.tmp`;
  fs.copyFileSync(srcPath, tmp);
  fs.renameSync(tmp, destPath);
}

function atomicWriteJson(destPath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  const tmp = `${destPath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, destPath);
}

async function commitIncrementalSnapshot(options: {
  dataDir: string;
  region: RegionLike;
  newPbf: string;
  buildNdjson: string;
  importNdjson: string;
  summaryJson: string;
}): Promise<IncrementalCachePaths> {
  const paths = resolveIncrementalCachePaths(options.dataDir, options.region);
  fs.mkdirSync(paths.root, { recursive: true });

  for (const src of [options.newPbf, options.buildNdjson, options.importNdjson, options.summaryJson]) {
    if (!fs.existsSync(src)) {
      throw new Error(`incremental-cache: source file missing for snapshot commit: ${src}`);
    }
  }

  atomicCopy(options.newPbf, paths.prevPbf);
  atomicCopy(options.buildNdjson, paths.prevBuildNdjson);
  atomicCopy(options.importNdjson, paths.prevImportNdjson);
  atomicCopy(options.summaryJson, paths.prevSummaryJson);

  const pbfStat = fs.statSync(paths.prevPbf);
  const pbfSha256 = await hashFile(paths.prevPbf);
  const meta: IncrementalCacheMeta = {
    pbfSha256,
    pbfSize: pbfStat.size,
    syncedAt: new Date().toISOString(),
    regionId: Number.isFinite(Number(options.region?.id)) ? Number(options.region.id) : null,
    regionSlug: options.region?.slug ? String(options.region.slug) : null
  };
  atomicWriteJson(paths.metaJson, meta);
  return paths;
}

function clearIncrementalSnapshot(dataDir: string, region: RegionLike): void {
  const root = resolveIncrementalCacheDir(dataDir, region);
  if (fs.existsSync(root)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

module.exports = {
  safeRegionKey,
  resolveIncrementalCacheDir,
  resolveIncrementalCachePaths,
  snapshotExists,
  readMeta,
  hashFile,
  commitIncrementalSnapshot,
  clearIncrementalSnapshot
};
