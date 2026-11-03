// A patch replaces complete tiles. Expand both invalidation and input selection
// beyond Planetiler's default 4/256 tile buffer to include rounding/simplification.
const TILE_BUFFER = 8 / 256;
const MAX_LATITUDE = 85.0511287798066;
const DEFAULT_MAX_DIRTY_TILES = 20000;

function zxyToTileId(z, x, y) {
  const n = 2 ** z;
  if (!Number.isInteger(z) || z < 0 || z > 26 || !Number.isInteger(x) || !Number.isInteger(y) ||
      x < 0 || y < 0 || x >= n || y >= n) throw new Error('Invalid PMTiles coordinate');
  let id = (n * n - 1) / 3;
  for (let s = n / 2; s >= 1; s /= 2) {
    const rx = (x & s) ? 1 : 0;
    const ry = (y & s) ? 1 : 0;
    id += s * s * ((3 * rx) ^ ry);
    if (ry === 0) {
      if (rx === 1) { x = s - 1 - x; y = s - 1 - y; }
      [x, y] = [y, x];
    }
  }
  return id;
}

function latitudeToY(latitude, n) {
  return (1 - Math.asinh(Math.tan(latitude * Math.PI / 180)) / Math.PI) / 2 * n;
}

function yToLatitude(y, n) {
  return Math.atan(Math.sinh(Math.PI * (1 - 2 * y / n))) * 180 / Math.PI;
}

function buildTilePatchPlan({ dirtyBounds, minZoom = 13, maxZoom = 16, maxDirtyTiles = DEFAULT_MAX_DIRTY_TILES }) {
  const full = (reason) => ({ mode: 'full', reason, dirtyTileIds: [], tileWindows: [] });
  if (!Number.isInteger(minZoom) || !Number.isInteger(maxZoom) || minZoom < 0 || maxZoom > 26 || minZoom > maxZoom) {
    return full('unsupported zoom range');
  }
  if (!Number.isInteger(maxDirtyTiles) || maxDirtyTiles <= 0 || maxDirtyTiles > 100000) return full('invalid tile limit');
  if (!Array.isArray(dirtyBounds) || !dirtyBounds.length || dirtyBounds.length > 256) return full('missing bounded change history');
  const ids = new Set<number>();
  const windows = [];
  for (const box of dirtyBounds) {
    const values = [box?.west, box?.south, box?.east, box?.north];
    if (!values.every(value => typeof value === 'number' && Number.isFinite(value)) ||
        box.west <= -180 || box.east >= 180 || box.south <= -MAX_LATITUDE || box.north >= MAX_LATITUDE ||
        box.west > box.east || box.south > box.north || box.east - box.west > 180) return full('unsafe change bounds');
    for (let z = minZoom; z <= maxZoom; z++) {
      const n = 2 ** z;
      const x0 = Math.max(0, Math.floor((box.west + 180) / 360 * n - TILE_BUFFER - 1e-8));
      const x1 = Math.min(n - 1, Math.floor((box.east + 180) / 360 * n + TILE_BUFFER + 1e-8));
      const y0 = Math.max(0, Math.floor(latitudeToY(box.north, n) - TILE_BUFFER - 1e-8));
      const y1 = Math.min(n - 1, Math.floor(latitudeToY(box.south, n) + TILE_BUFFER + 1e-8));
      // Planetiler renders world copies across the antimeridian. A tile at an
      // edge also needs input from the opposite edge; leave that to a full build.
      if (x0 === 0 || x1 === n - 1 || y0 === 0 || y1 === n - 1) return full('buffer reaches world edge');
      if ((x1 - x0 + 1) * (y1 - y0 + 1) > maxDirtyTiles) return full('dirty tile limit exceeded');
      for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) {
        ids.add(zxyToTileId(z, x, y));
        if (ids.size > maxDirtyTiles) return full('dirty tile limit exceeded');
      }
      const window = {
        west: Math.max(-180, (x0 - TILE_BUFFER) / n * 360 - 180),
        east: Math.min(180, (x1 + 1 + TILE_BUFFER) / n * 360 - 180),
        north: yToLatitude(Math.max(0, y0 - TILE_BUFFER), n),
        south: yToLatitude(Math.min(n, y1 + 1 + TILE_BUFFER), n)
      };
      // Coarse windows normally cover finer ones. Keep every uncovered window;
      // never approximate disjoint old/new footprints with their combined extent.
      if (!windows.some(other => other.west <= window.west && other.east >= window.east &&
          other.south <= window.south && other.north >= window.north)) windows.push(window);
    }
  }
  return { mode: 'incremental', reason: null, dirtyTileIds: [...ids].sort((a, b) => a - b), tileWindows: windows };
}

module.exports = { buildTilePatchPlan, zxyToTileId, DEFAULT_MAX_DIRTY_TILES };
