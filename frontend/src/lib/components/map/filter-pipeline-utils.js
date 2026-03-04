const FILTER_RULE_OPS = new Set(['contains', 'equals', 'not_equals', 'starts_with', 'exists', 'not_exists']);

export function parseOsmKey(raw) {
  const text = String(raw || '').trim();
  const match = text.match(/^(way|relation)\/(\d+)$/);
  if (!match) return null;
  const osmId = Number(match[2]);
  if (!Number.isInteger(osmId) || osmId <= 0) return null;
  return { osmType: match[1], osmId };
}

export function encodeOsmFeatureId(osmType, osmId) {
  const typeBit = osmType === 'relation' ? 1 : 0;
  return (Number(osmId) * 2) + typeBit;
}

export function normalizeFilterRules(rawRules) {
  const input = Array.isArray(rawRules) ? rawRules : [];
  const rules = [];
  for (const raw of input) {
    const key = String(raw?.key || '').trim();
    if (!key) continue;
    const op = String(raw?.op || 'contains').trim();
    if (!FILTER_RULE_OPS.has(op)) {
      return { rules: [], invalidReason: `Invalid filter operator: ${op}` };
    }
    const value = String(raw?.value || '').trim();
    rules.push({
      key,
      op,
      value,
      valueNormalized: value.toLowerCase()
    });
  }
  return { rules, invalidReason: '' };
}

export function isHeavyRule(rule) {
  return String(rule?.op || '') === 'contains';
}

export function computeRulesHash(rules) {
  const raw = JSON.stringify(Array.isArray(rules) ? rules : []);
  let hash = 2166136261;
  for (let i = 0; i < raw.length; i += 1) {
    hash ^= raw.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `fnv1a-${(hash >>> 0).toString(16)}`;
}

export function toFeatureIdSetFromMatches(matched = {}) {
  const out = new Set();
  const ids = Array.isArray(matched?.matchedFeatureIds) ? matched.matchedFeatureIds : [];
  for (const raw of ids) {
    const id = Number(raw);
    if (!Number.isInteger(id) || id <= 0) continue;
    out.add(id);
  }
  const keys = Array.isArray(matched?.matchedKeys) ? matched.matchedKeys : [];
  for (const key of keys) {
    const parsed = parseOsmKey(key);
    if (!parsed) continue;
    out.add(encodeOsmFeatureId(parsed.osmType, parsed.osmId));
  }
  return out;
}

export function buildFeatureStateDiffPlan(prevFeatureIds, nextFeatureIds) {
  const prev = new Set(Array.isArray(prevFeatureIds) ? prevFeatureIds : []);
  const next = new Set(Array.isArray(nextFeatureIds) ? nextFeatureIds : []);
  const toDisable = [];
  const toEnable = [];

  for (const id of prev) {
    if (!next.has(id)) toDisable.push(id);
  }
  for (const id of next) {
    if (!prev.has(id)) toEnable.push(id);
  }

  return {
    toEnable,
    toDisable,
    nextFeatureIds: [...next],
    total: next.size
  };
}

export function buildBboxSnapshot(bounds) {
  const west = Number(bounds?.getWest?.());
  const south = Number(bounds?.getSouth?.());
  const east = Number(bounds?.getEast?.());
  const north = Number(bounds?.getNorth?.());
  if (![west, south, east, north].every(Number.isFinite)) return null;
  return { west, south, east, north };
}

export function buildBboxHash(bbox, precision = 4) {
  if (!bbox) return 'bbox:none';
  return [
    Number(bbox.west).toFixed(precision),
    Number(bbox.south).toFixed(precision),
    Number(bbox.east).toFixed(precision),
    Number(bbox.north).toFixed(precision)
  ].join(':');
}

export function clampNumber(value, min, max) {
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
  const ratio = clampNumber(marginRatio, 0, 2);
  const growX = width * ratio;
  const growY = height * ratio;
  return {
    west: west - growX,
    south: clampNumber(south - growY, -90, 90),
    east: east + growX,
    north: clampNumber(north + growY, -90, 90)
  };
}

export function isViewportInsideBbox(viewport, containerBbox, epsilon = 1e-7) {
  if (!viewport || !containerBbox) return false;
  const viewportWest = Number(viewport.west);
  const viewportSouth = Number(viewport.south);
  const viewportEast = Number(viewport.east);
  const viewportNorth = Number(viewport.north);
  const boxWest = Number(containerBbox.west);
  const boxSouth = Number(containerBbox.south);
  const boxEast = Number(containerBbox.east);
  const boxNorth = Number(containerBbox.north);
  if (![viewportWest, viewportSouth, viewportEast, viewportNorth, boxWest, boxSouth, boxEast, boxNorth].every(Number.isFinite)) {
    return false;
  }
  return (
    viewportWest >= (boxWest - epsilon) &&
    viewportSouth >= (boxSouth - epsilon) &&
    viewportEast <= (boxEast + epsilon) &&
    viewportNorth <= (boxNorth + epsilon)
  );
}

export function getAdaptiveCoverageMarginRatio({
  lastCount = 0,
  defaultLimit = 12_000,
  min = 0.2,
  max = 0.35
} = {}) {
  const minRatio = clampNumber(min, 0, 1);
  const maxRatio = clampNumber(max, minRatio, 1);
  const count = Math.max(0, Number(lastCount) || 0);
  const limit = Math.max(1, Number(defaultLimit) || 1);
  const saturation = clampNumber(count / limit, 0, 1);
  const ratio = maxRatio - ((maxRatio - minRatio) * saturation);
  return clampNumber(ratio, minRatio, maxRatio);
}
