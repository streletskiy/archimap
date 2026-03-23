export function clampMapNumber(value, min, max) {
  const num = Number(value);
  if (!Number.isFinite(num)) return Number(min);
  return Math.max(Number(min), Math.min(Number(max), num));
}

export function expandBboxWithMargin(bbox, marginRatio = 0.25) {
  if (!bbox) return null;
  const west = Number(bbox.west);
  const south = Number(bbox.south);
  const east = Number(bbox.east);
  const north = Number(bbox.north);
  if (![west, south, east, north].every(Number.isFinite)) return null;

  const width = Math.max(1e-6, east - west);
  const height = Math.max(1e-6, north - south);
  const ratio = clampMapNumber(marginRatio, 0, 2);
  const growX = width * ratio;
  const growY = height * ratio;

  return {
    west: west - growX,
    south: clampMapNumber(south - growY, -90, 90),
    east: east + growX,
    north: clampMapNumber(north + growY, -90, 90)
  };
}

export function getAdaptiveCoverageMarginRatio({
  lastCount = 0,
  defaultLimit = 12_000,
  min = 0.2,
  max = 0.35
} = {}) {
  const minRatio = clampMapNumber(min, 0, 1);
  const maxRatio = clampMapNumber(max, minRatio, 1);
  const count = Math.max(0, Number(lastCount) || 0);
  const limit = Math.max(1, Number(defaultLimit) || 1);
  const saturation = clampMapNumber(count / limit, 0, 1);
  const ratio = maxRatio - ((maxRatio - minRatio) * saturation);
  return clampMapNumber(ratio, minRatio, maxRatio);
}
