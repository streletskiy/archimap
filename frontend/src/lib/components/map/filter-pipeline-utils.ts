import {
  clampMapNumber as clampNumber,
  expandBboxWithMargin,
  getAdaptiveCoverageMarginRatio
} from '../../services/map/map-math-utils.js';
import {
  FILTER_LAYER_BASE_COLOR,
  FILTER_LAYER_COLOR_PALETTE
} from '../../constants/filter-presets.js';

const FILTER_RULE_OPS = new Set([
  'contains',
  'equals',
  'not_equals',
  'starts_with',
  'exists',
  'not_exists',
  'greater_than',
  'greater_or_equals',
  'less_than',
  'less_or_equals'
]);
const FILTER_LAYER_MODES = new Set(['and', 'or', 'layer']);
const FILTER_COLOR_RE = /^#[0-9a-f]{6}$/i;
const FILTER_CLEAR_COLOR = '#000000';
const NUMERIC_FILTER_RULE_OPS = new Set(['greater_than', 'greater_or_equals', 'less_than', 'less_or_equals']);

let filterLayerIdSeq = 0;

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

export function createFilterLayerId(prefix = 'filter-layer') {
  filterLayerIdSeq += 1;
  return `${prefix}-${Date.now()}-${filterLayerIdSeq}`;
}

export function normalizeFilterLayerMode(rawMode) {
  const mode = String(rawMode || 'and').trim().toLowerCase();
  return FILTER_LAYER_MODES.has(mode) ? mode : 'and';
}

export function resolveDefaultFilterLayerColor(priority = 0) {
  const index = Math.max(0, Number(priority) || 0);
  if (index === 0) return FILTER_LAYER_BASE_COLOR;
  const paletteIndex = (index - 1) % FILTER_LAYER_COLOR_PALETTE.length;
  return FILTER_LAYER_COLOR_PALETTE[paletteIndex] || FILTER_LAYER_BASE_COLOR;
}

export function normalizeFilterColor(rawColor, fallbackColor = FILTER_LAYER_BASE_COLOR) {
  const color = String(rawColor || '').trim();
  if (FILTER_COLOR_RE.test(color)) {
    return color.toLowerCase();
  }
  return String(fallbackColor || FILTER_LAYER_BASE_COLOR).trim().toLowerCase();
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
    const numericValue = NUMERIC_FILTER_RULE_OPS.has(op) ? parseNumericFilterValue(value) : null;
    if (NUMERIC_FILTER_RULE_OPS.has(op) && !Number.isFinite(numericValue)) {
      return { rules: [], invalidReason: 'Rule value must be numeric' };
    }
    rules.push({
      key,
      op,
      value,
      valueNormalized: value.toLowerCase(),
      numericValue
    });
  }
  return { rules, invalidReason: '' };
}

export function sortFilterLayersByPriority(layers) {
  return [...(Array.isArray(layers) ? layers : [])].sort((left, right) => {
    const leftPriority = Number(left?.priority);
    const rightPriority = Number(right?.priority);
    if (leftPriority !== rightPriority) return leftPriority - rightPriority;
    return String(left?.id || '').localeCompare(String(right?.id || ''), 'en');
  });
}

export function normalizeFilterLayers(rawLayers, { preserveEmpty = false }: LooseRecord = {}) {
  const input = Array.isArray(rawLayers) ? rawLayers : [];
  const normalizedLayers = [];
  for (let index = 0; index < input.length; index += 1) {
    const rawLayer = input[index] || {};
    const normalizedRules = normalizeFilterRules(rawLayer.rules);
    if (normalizedRules.invalidReason) {
      return { layers: [], invalidReason: normalizedRules.invalidReason };
    }
    const rules = normalizedRules.rules;
    if (!preserveEmpty && rules.length === 0) continue;
    const rawPriority = Number(rawLayer.priority);
    const normalizedPriority = Number.isFinite(rawPriority) ? rawPriority : index;
    const id = String(rawLayer.id || '').trim() || createFilterLayerId();
    normalizedLayers.push({
      id,
      color: normalizeFilterColor(rawLayer.color, resolveDefaultFilterLayerColor(normalizedPriority)),
      priority: normalizedPriority,
      mode: normalizeFilterLayerMode(rawLayer.mode),
      rules,
      originalIndex: index
    });
  }
  const layers = normalizedLayers
    .sort((left, right) => {
      if (left.priority !== right.priority) return left.priority - right.priority;
      return left.originalIndex - right.originalIndex;
    })
    .map((layer, priority) => ({
      id: layer.id,
      color: normalizeFilterColor(layer.color, resolveDefaultFilterLayerColor(priority)),
      priority,
      mode: normalizeFilterLayerMode(layer.mode),
      rules: Array.isArray(layer.rules) ? [...layer.rules] : []
    }));
  return { layers, invalidReason: '' };
}

export function flattenFilterLayers(rawLayers) {
  return sortFilterLayersByPriority(rawLayers)
    .flatMap((layer) => (Array.isArray(layer?.rules) ? layer.rules : []));
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

export function parseNumericFilterValue(rawValue) {
  const text = String(rawValue ?? '').trim().replace(',', '.');
  if (!/^-?\d+(?:\.\d+)?$/.test(text)) return null;
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
}

const ARCHI_RULE_KEYS = new Set(['name', 'style', 'material', 'colour', 'levels', 'year_built', 'architect', 'address', 'description', 'archimap_description']);

function getFilterRuleValue(source, key) {
  const sourceTags = source?.sourceTags && typeof source.sourceTags === 'object'
    ? source.sourceTags
    : (source && typeof source === 'object' ? source : {});
  const archiInfo = source?.archiInfo && typeof source.archiInfo === 'object' ? source.archiInfo : {};
  const hasMeaningfulValue = (value) => {
    const normalized = Array.isArray(value) ? value.join(';') : (value == null ? null : String(value));
    return normalized != null && String(normalized).trim().length > 0;
  };
  
  if (key.startsWith('archi.')) return archiInfo[key.slice(6)];
  
  // Apply archiInfo overrides for common OSM tags
  if (key === 'building:colour' || key === 'colour') {
    if (hasMeaningfulValue(archiInfo.colour)) return archiInfo.colour;
    if (Object.prototype.hasOwnProperty.call(sourceTags, 'building:colour')) return sourceTags['building:colour'];
    if (Object.prototype.hasOwnProperty.call(sourceTags, 'colour')) return sourceTags.colour;
  }
  if (key === 'building:material' || key === 'material') {
    if (hasMeaningfulValue(archiInfo.material)) return archiInfo.material;
    if (Object.prototype.hasOwnProperty.call(sourceTags, 'building:material')) return sourceTags['building:material'];
    if (Object.prototype.hasOwnProperty.call(sourceTags, 'material')) return sourceTags.material;
  }
  if (key === 'building:material:concrete' || key === 'material_concrete') {
    if (hasMeaningfulValue(archiInfo.material_concrete)) return archiInfo.material_concrete;
    if (Object.prototype.hasOwnProperty.call(sourceTags, 'building:material:concrete')) return sourceTags['building:material:concrete'];
    if (Object.prototype.hasOwnProperty.call(sourceTags, 'material_concrete')) return sourceTags.material_concrete;
  }
  if (key === 'building:architecture' || key === 'architecture' || key === 'style') {
     if (hasMeaningfulValue(archiInfo.style)) return archiInfo.style;
  }
  if (key === 'building:levels' || key === 'levels') {
     if (hasMeaningfulValue(archiInfo.levels)) return archiInfo.levels;
  }
  if (key === 'building:year' || key === 'year_built' || key === 'start_date') {
     if (hasMeaningfulValue(archiInfo.year_built)) return archiInfo.year_built;
  }
  if (key === 'architect' || key === 'architect_name') {
     if (hasMeaningfulValue(archiInfo.architect)) return archiInfo.architect;
  }
  if (key === 'name' || key === 'name:ru' || key === 'name:en') {
     if (hasMeaningfulValue(archiInfo.name)) return archiInfo.name;
  }
  if (key === 'description' || key === 'archimap_description') {
     if (hasMeaningfulValue(archiInfo.archimap_description)) return archiInfo.archimap_description;
     if (hasMeaningfulValue(archiInfo.description)) return archiInfo.description;
  }

  if (ARCHI_RULE_KEYS.has(key) && hasMeaningfulValue(archiInfo[key])) {
    return archiInfo[key];
  }
  if (Object.prototype.hasOwnProperty.call(sourceTags, key)) return sourceTags[key];
  if (ARCHI_RULE_KEYS.has(key)) return archiInfo[key];
  return undefined;
}

export function matchesFilterRule(tags, rule) {
  if (!rule || !rule.key) return true;
  const actualRaw = getFilterRuleValue(tags, rule.key);
  const actual = Array.isArray(actualRaw) ? actualRaw.join(';') : (actualRaw == null ? null : String(actualRaw));
  const hasValue = actual != null && String(actual).trim().length > 0;
  if (rule.op === 'exists') return hasValue;
  if (rule.op === 'not_exists') return !hasValue;
  if (actual == null) return false;
  if (NUMERIC_FILTER_RULE_OPS.has(rule.op)) {
    const leftNumber = parseNumericFilterValue(actual);
    const rightNumber = Number.isFinite(rule.numericValue) ? rule.numericValue : parseNumericFilterValue(rule.value);
    if (!Number.isFinite(leftNumber) || !Number.isFinite(rightNumber)) return false;
    if (rule.op === 'greater_than') return leftNumber > rightNumber;
    if (rule.op === 'greater_or_equals') return leftNumber >= rightNumber;
    if (rule.op === 'less_than') return leftNumber < rightNumber;
    return leftNumber <= rightNumber;
  }
  const left = String(actual).toLowerCase();
  const right = String(rule.valueNormalized || rule.value || '').toLowerCase();
  if (rule.op === 'equals') return left === right;
  if (rule.op === 'not_equals') return left !== right;
  if (rule.op === 'starts_with') return left.startsWith(right);
  return left.includes(right);
}

export function matchesFilterRules(tags, rules) {
  return (Array.isArray(rules) ? rules : []).every((rule) => matchesFilterRule(tags, rule));
}

export function toFeatureIdSetFromMatches(matched: LooseRecord = {}) {
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

function normalizeFeatureStateEntry(rawEntry) {
  const id = Number(rawEntry?.id);
  if (!Number.isInteger(id) || id <= 0) return null;
  return {
    id,
    state: {
      isFiltered: Boolean(rawEntry?.state?.isFiltered),
      filterColor: normalizeFilterColor(rawEntry?.state?.filterColor, FILTER_CLEAR_COLOR)
    }
  };
}

export function buildFeatureStateEntry(id, state: LooseRecord = {}) {
  return normalizeFeatureStateEntry({ id, state });
}

export function areFeatureStatesEqual(left, right) {
  return (
    Boolean(left?.isFiltered) === Boolean(right?.isFiltered) &&
    normalizeFilterColor(left?.filterColor, FILTER_CLEAR_COLOR) === normalizeFilterColor(right?.filterColor, FILTER_CLEAR_COLOR)
  );
}

export function buildFeatureStateEntryDiffPlan(prevEntries, nextEntries) {
  const prev = new Map();
  const next = new Map();
  for (const rawEntry of Array.isArray(prevEntries) ? prevEntries : []) {
    const entry = normalizeFeatureStateEntry(rawEntry);
    if (!entry) continue;
    prev.set(entry.id, entry.state);
  }
  for (const rawEntry of Array.isArray(nextEntries) ? nextEntries : []) {
    const entry = normalizeFeatureStateEntry(rawEntry);
    if (!entry) continue;
    next.set(entry.id, entry.state);
  }
  const toDisable = [];
  const toEnable = [];
  const toUpdate = [];

  for (const id of prev.keys()) {
    if (!next.has(id)) {
      toDisable.push(id);
    }
  }

  for (const [id, nextState] of next.entries()) {
    if (!prev.has(id)) {
      toEnable.push({ id, state: nextState });
      continue;
    }
    if (!areFeatureStatesEqual(prev.get(id), nextState)) {
      toUpdate.push({ id, state: nextState });
    }
  }

  return {
    toEnable,
    toDisable,
    toUpdate,
    nextEntries: [...next.entries()].map(([id, state]) => ({ id, state })),
    total: next.size
  };
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

export {
  clampNumber,
  expandBboxWithMargin,
  getAdaptiveCoverageMarginRatio
};
