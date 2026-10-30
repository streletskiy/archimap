export const OVERPASS_TILE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const OVERPASS_DISK_MAX_TILES = 512;
export const OVERPASS_DISK_MAX_BYTES = 128 * 1024 * 1024;
export const OVERPASS_MEMORY_MAX_BYTES = 64 * 1024 * 1024;

export function isOverpassTileFresh(record: { fetchedAt?: number }, now = Date.now()) {
  const fetchedAt = Number(record?.fetchedAt || 0);
  return fetchedAt > 0 && fetchedAt <= now && now - fetchedAt < OVERPASS_TILE_TTL_MS;
}

export function estimateOverpassTileBytes(record: unknown) {
  // Conservative UTF-16 budget also covers non-ASCII tag text.
  return JSON.stringify(record).length * 2;
}

export function selectOverpassCacheEvictions(
  records: Array<{ key: string; bytes: number; touchedAt: number }>,
  maxTiles = OVERPASS_DISK_MAX_TILES,
  maxBytes = OVERPASS_DISK_MAX_BYTES
) {
  const ordered = [...records].sort((a, b) => a.touchedAt - b.touchedAt);
  let bytes = ordered.reduce((sum, entry) => sum + Math.max(0, Number(entry.bytes) || 0), 0);
  let count = ordered.length;
  const keys: string[] = [];
  for (const entry of ordered) {
    if (count <= maxTiles && bytes <= maxBytes) break;
    keys.push(entry.key);
    count -= 1;
    bytes -= Math.max(0, Number(entry.bytes) || 0);
  }
  return keys;
}
