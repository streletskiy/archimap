/*
 * Spatial expansion for incremental region sync (Phase 2).
 *
 * An OSC `derive-changes` diff lists node/way/relation objects whose OSM
 * version changed between two PBFs. When a node moves, referencing ways do
 * NOT appear in the diff (their own object didn't change) — so we must
 * translate touched node ids into the set of buildings whose geometry
 * includes (or included) that node.
 *
 * We avoid pulling in a spatial index: the prev NDJSON is ~100MB for a
 * region-sized area and a single streaming bbox scan is cheap enough.
 * For each touched node we take its *previous* position (from prev.pbf via
 * `osmium getid -f opl`) and flag every prev building whose bbox contains
 * the point. That over-approximates (bbox is coarser than polygon) but the
 * downstream subset import is cheap and idempotent, so false positives only
 * cost us slightly more re-import work — never correctness.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { spawn } = require('child_process');

type NodePosition = { osmId: number; lon: number; lat: number };

const OPL_NODE_RE = /^n(\d+)\s+.*?\sx(-?\d+(?:\.\d+)?)\s+y(-?\d+(?:\.\d+)?)(?:\s|$)/;
const NDJSON_ID_RE = /"id"\s*:\s*(\d+)/;
const NDJSON_COORDS_RE = /"coordinates"\s*:\s*(\[.*\])\s*\}/;

function decodeEncodedFeatureId(encoded: number): { osmType: string; osmId: number } {
  const typeBit = encoded % 2;
  return {
    osmType: typeBit === 1 ? 'relation' : 'way',
    osmId: Math.trunc(encoded / 2)
  };
}

async function extractNodePositions(options: {
  prevPbf: string;
  nodeIds: Iterable<number>;
  osmiumBin?: string;
}): Promise<Map<number, NodePosition>> {
  const positions = new Map<number, NodePosition>();
  const nodeIdList = Array.from(options.nodeIds).filter((id) => Number.isFinite(id));
  if (nodeIdList.length === 0) return positions;
  if (!fs.existsSync(options.prevPbf)) {
    throw new Error(`spatial-expansion: prev PBF not found at ${options.prevPbf}`);
  }

  const bin = options.osmiumBin || 'osmium';
  const tmpDir = os.tmpdir();
  const tmpIds = path.join(tmpDir, `archimap-osmium-nodeids-${process.pid}-${Date.now()}.txt`);
  const tmpOpl = path.join(tmpDir, `archimap-osmium-nodeids-${process.pid}-${Date.now()}.opl`);

  fs.writeFileSync(tmpIds, nodeIdList.map((id) => `n${id}`).join('\n') + '\n');
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(
        bin,
        ['getid', '-i', tmpIds, '-f', 'opl', '-o', tmpOpl, '--overwrite', options.prevPbf],
        { stdio: ['ignore', 'pipe', 'pipe'] }
      );
      let stderrBuf = '';
      child.stderr.on('data', (chunk) => {
        stderrBuf += String(chunk);
      });
      child.on('error', reject);
      child.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`osmium getid exited with code ${code}: ${stderrBuf.trim()}`));
      });
    });

    const rl = readline.createInterface({
      input: fs.createReadStream(tmpOpl, { encoding: 'utf8' }),
      crlfDelay: Infinity
    });
    for await (const line of rl) {
      const match = OPL_NODE_RE.exec(line);
      if (!match) continue;
      const osmId = Number(match[1]);
      const lon = Number(match[2]);
      const lat = Number(match[3]);
      if (!Number.isFinite(osmId) || !Number.isFinite(lon) || !Number.isFinite(lat)) continue;
      positions.set(osmId, { osmId, lon, lat });
    }
  } finally {
    for (const p of [tmpIds, tmpOpl]) {
      try {
        fs.unlinkSync(p);
      } catch {
        // best-effort cleanup
      }
    }
  }
  return positions;
}

type Bbox = { minLon: number; minLat: number; maxLon: number; maxLat: number };

/**
 * Parses the coordinates array from a NDJSON Feature line and returns its
 * axis-aligned bbox. Accepts Polygon (depth-3 array) or MultiPolygon
 * (depth-4). Returns null if the geometry cannot be parsed — callers treat
 * that as "don't include this line in the scan".
 */
function parseBboxFromNdjson(line: string): Bbox | null {
  const match = NDJSON_COORDS_RE.exec(line);
  if (!match) return null;
  let coords: unknown;
  try {
    coords = JSON.parse(match[1]);
  } catch {
    return null;
  }
  let minLon = Infinity;
  let minLat = Infinity;
  let maxLon = -Infinity;
  let maxLat = -Infinity;
  const walk = (node: unknown): void => {
    if (!Array.isArray(node)) return;
    if (
      node.length >= 2 &&
      typeof node[0] === 'number' &&
      typeof node[1] === 'number'
    ) {
      const lon = node[0] as number;
      const lat = node[1] as number;
      if (lon < minLon) minLon = lon;
      if (lon > maxLon) maxLon = lon;
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
      return;
    }
    for (const child of node) walk(child);
  };
  walk(coords);
  if (!Number.isFinite(minLon) || !Number.isFinite(minLat)) return null;
  return { minLon, minLat, maxLon, maxLat };
}

function pointInBbox(lon: number, lat: number, bbox: Bbox): boolean {
  return (
    lon >= bbox.minLon &&
    lon <= bbox.maxLon &&
    lat >= bbox.minLat &&
    lat <= bbox.maxLat
  );
}

/**
 * Core API: given a set of touched node ids, return the set of `way/N` and
 * `relation/N` feature ids whose prev geometry likely references those nodes
 * (bbox-containment test against prev position).
 *
 * Features with the same (osm_type, osm_id) but different feature_kind are
 * deduplicated — we only care about the object key, since the importer's
 * `--osm-id-filter-file` expects object-level ids.
 */
async function expandAffectedByNodeChanges(options: {
  prevBuildNdjsonPath: string;
  prevPbf: string;
  modifiedNodeIds: Iterable<number>;
  osmiumBin?: string;
}): Promise<{ affectedObjectIds: Set<string>; resolvedNodeCount: number; scannedFeatures: number }> {
  const affected = new Set<string>();
  const nodeIdSet = new Set<number>();
  for (const id of options.modifiedNodeIds) {
    if (Number.isFinite(id)) nodeIdSet.add(Number(id));
  }
  if (nodeIdSet.size === 0) {
    return { affectedObjectIds: affected, resolvedNodeCount: 0, scannedFeatures: 0 };
  }
  if (!fs.existsSync(options.prevBuildNdjsonPath)) {
    return { affectedObjectIds: affected, resolvedNodeCount: 0, scannedFeatures: 0 };
  }

  const positions = await extractNodePositions({
    prevPbf: options.prevPbf,
    nodeIds: nodeIdSet,
    osmiumBin: options.osmiumBin
  });
  if (positions.size === 0) {
    return { affectedObjectIds: affected, resolvedNodeCount: 0, scannedFeatures: 0 };
  }

  // Global bbox of all changed points — a cheap short-circuit per NDJSON line
  // before the O(n_points) inner loop.
  let gMinLon = Infinity;
  let gMinLat = Infinity;
  let gMaxLon = -Infinity;
  let gMaxLat = -Infinity;
  for (const pos of positions.values()) {
    if (pos.lon < gMinLon) gMinLon = pos.lon;
    if (pos.lon > gMaxLon) gMaxLon = pos.lon;
    if (pos.lat < gMinLat) gMinLat = pos.lat;
    if (pos.lat > gMaxLat) gMaxLat = pos.lat;
  }
  const globalBbox: Bbox = {
    minLon: gMinLon,
    minLat: gMinLat,
    maxLon: gMaxLon,
    maxLat: gMaxLat
  };

  const points = Array.from(positions.values());
  let scannedFeatures = 0;

  const rl = readline.createInterface({
    input: fs.createReadStream(options.prevBuildNdjsonPath, { encoding: 'utf8' }),
    crlfDelay: Infinity
  });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed || !trimmed.startsWith('{')) continue;
    const bbox = parseBboxFromNdjson(trimmed);
    if (!bbox) continue;
    scannedFeatures += 1;

    if (
      bbox.maxLon < globalBbox.minLon ||
      bbox.minLon > globalBbox.maxLon ||
      bbox.maxLat < globalBbox.minLat ||
      bbox.minLat > globalBbox.maxLat
    ) {
      continue;
    }

    const idMatch = NDJSON_ID_RE.exec(trimmed);
    if (!idMatch) continue;
    const encoded = Number(idMatch[1]);
    if (!Number.isFinite(encoded) || encoded < 0) continue;
    const { osmType, osmId } = decodeEncodedFeatureId(encoded);
    const objectKey = `${osmType}/${osmId}`;
    if (affected.has(objectKey)) continue;

    for (const pt of points) {
      if (pointInBbox(pt.lon, pt.lat, bbox)) {
        affected.add(objectKey);
        break;
      }
    }
  }

  return {
    affectedObjectIds: affected,
    resolvedNodeCount: positions.size,
    scannedFeatures
  };
}

module.exports = {
  expandAffectedByNodeChanges,
  extractNodePositions,
  parseBboxFromNdjson,
  pointInBbox,
  decodeEncodedFeatureId
};
