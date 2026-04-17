/*
 * Deterministic NDJSON merge for incremental region sync (Phase 2).
 *
 * Phase 1 pinned SQL ORDER BY so NDJSON rows come out sorted by
 * (osm_type, osm_id, feature_kind). Phase 2 reuses the cached NDJSON from
 * the previous sync and splices a delta produced by a subset importer on top.
 * The merged output MUST keep the same ORDER BY contract or the pmtiles shard
 * cache will falsely invalidate on rows that didn't actually change.
 */

const fs = require('fs');
const readline = require('readline');

type FeatureKey = string; // `${osm_type}/${osm_id}/${feature_kind}`
type ObjectKey = string;  // `${osm_type}/${osm_id}`

type MergeStats = {
  keptFromPrev: number;
  replacedByDelta: number;
  addedFromDelta: number;
  deletedFromPrev: number;
  total: number;
};

const FEATURE_ID_RE = /"id"\s*:\s*(\d+)/;
const FEATURE_KIND_RE = /"feature_kind"\s*:\s*"([^"]+)"/;

function decodeEncodedFeatureId(encoded: number): { osmType: string; osmId: number } {
  const typeBit = encoded % 2;
  return {
    osmType: typeBit === 1 ? 'relation' : 'way',
    osmId: Math.trunc(encoded / 2)
  };
}

/**
 * Extracts the ordering/dedup key from a region-build.ndjson line.
 * Lines look like:
 *   {"type":"Feature","id":123,"properties":{"osm_id":61,"feature_kind":"building",...},"geometry":{...}}
 * The encoded `id` carries the osm_type bit; feature_kind is in properties.
 */
function parseNdjsonLineKey(line: string): { featureKey: FeatureKey; objectKey: ObjectKey; osmType: string; osmId: number; featureKind: string } | null {
  const trimmed = line.trim();
  if (!trimmed || !trimmed.startsWith('{')) return null;
  const idMatch = FEATURE_ID_RE.exec(trimmed);
  if (!idMatch) return null;
  const encoded = Number(idMatch[1]);
  if (!Number.isFinite(encoded) || encoded < 0) return null;
  const decoded = decodeEncodedFeatureId(encoded);
  const kindMatch = FEATURE_KIND_RE.exec(trimmed);
  const featureKind = (kindMatch && kindMatch[1]) || 'building';
  return {
    featureKey: `${decoded.osmType}/${decoded.osmId}/${featureKind}`,
    objectKey: `${decoded.osmType}/${decoded.osmId}`,
    osmType: decoded.osmType,
    osmId: decoded.osmId,
    featureKind
  };
}

function compareFeatureKeys(a: { osmType: string; osmId: number; featureKind: string }, b: { osmType: string; osmId: number; featureKind: string }): number {
  if (a.osmType !== b.osmType) return a.osmType < b.osmType ? -1 : 1;
  if (a.osmId !== b.osmId) return a.osmId < b.osmId ? -1 : 1;
  if (a.featureKind === b.featureKind) return 0;
  return a.featureKind < b.featureKind ? -1 : 1;
}

async function collectLinesByKey(filePath: string): Promise<{ lines: Map<FeatureKey, string>; order: string[] }> {
  const lines = new Map<FeatureKey, string>();
  const order: string[] = [];
  if (!fs.existsSync(filePath)) {
    return { lines, order };
  }
  const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  for await (const raw of rl) {
    const parsed = parseNdjsonLineKey(raw);
    if (!parsed) continue;
    const line = raw.endsWith('\n') ? raw : `${raw}\n`;
    // Last occurrence wins — callers should not produce duplicates, but if the
    // upstream ever slips a dup through, we don't want merge to explode.
    if (!lines.has(parsed.featureKey)) {
      order.push(parsed.featureKey);
    }
    lines.set(parsed.featureKey, line);
  }
  return { lines, order };
}

function normalizeDeletedObjectKeys(
  deletedFeatureIds: Iterable<string> | null | undefined
): Set<ObjectKey> {
  const out = new Set<ObjectKey>();
  if (!deletedFeatureIds) return out;
  for (const raw of deletedFeatureIds) {
    const trimmed = String(raw || '').trim();
    if (!trimmed) continue;
    // Accept both 'way/123' and 'way/123/building_remainder' (the latter is
    // narrower — a Set<ObjectKey> always deletes every feature_kind for the
    // object id).
    const parts = trimmed.split('/');
    if (parts.length < 2) continue;
    const osmType = parts[0].toLowerCase();
    const osmId = parts[1];
    if ((osmType !== 'way' && osmType !== 'relation') || !/^\d+$/.test(osmId)) continue;
    out.add(`${osmType}/${osmId}`);
  }
  return out;
}

async function mergeBuildNdjson(options: {
  previousPath: string;
  deltaPath: string | null;
  deletedFeatureIds?: Iterable<string> | null;
  outputPath: string;
}): Promise<MergeStats> {
  const { previousPath, deltaPath, outputPath } = options;
  const deletedObjectKeys = normalizeDeletedObjectKeys(options.deletedFeatureIds);

  const prev = await collectLinesByKey(previousPath);
  const delta = deltaPath ? await collectLinesByKey(deltaPath) : { lines: new Map<FeatureKey, string>(), order: [] as string[] };

  const merged = new Map<FeatureKey, string>();
  let keptFromPrev = 0;
  let replacedByDelta = 0;
  let addedFromDelta = 0;
  let deletedFromPrev = 0;

  for (const key of prev.order) {
    const [osmType, osmId] = key.split('/');
    const objectKey = `${osmType}/${osmId}`;
    if (deletedObjectKeys.has(objectKey)) {
      deletedFromPrev += 1;
      continue;
    }
    if (delta.lines.has(key)) {
      // Delta shadows prev for this feature — we'll emit the delta line below.
      continue;
    }
    merged.set(key, prev.lines.get(key)!);
    keptFromPrev += 1;
  }

  for (const key of delta.order) {
    const line = delta.lines.get(key)!;
    if (prev.lines.has(key)) {
      replacedByDelta += 1;
    } else {
      addedFromDelta += 1;
    }
    merged.set(key, line);
  }

  // Stable sort by (osm_type, osm_id numeric, feature_kind). We re-parse the
  // keys we already have rather than stashing tuples in every value.
  const sortedKeys = Array.from(merged.keys())
    .map((key) => {
      const [osmType, osmIdRaw, featureKind] = key.split('/');
      return { key, osmType, osmId: Number(osmIdRaw), featureKind };
    })
    .sort(compareFeatureKeys)
    .map((entry) => entry.key);

  fs.mkdirSync(require('path').dirname(outputPath), { recursive: true });
  const out = fs.createWriteStream(outputPath);
  try {
    for (const key of sortedKeys) {
      out.write(merged.get(key)!);
    }
  } finally {
    out.end();
    await new Promise<void>((resolve, reject) => {
      out.on('finish', () => resolve());
      out.on('error', reject);
    });
  }

  return {
    keptFromPrev,
    replacedByDelta,
    addedFromDelta,
    deletedFromPrev,
    total: sortedKeys.length
  };
}

module.exports = {
  mergeBuildNdjson,
  parseNdjsonLineKey,
  compareFeatureKeys,
  normalizeDeletedObjectKeys,
  decodeEncodedFeatureId
};
