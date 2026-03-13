const EX_USSR = Object.freeze([
  'am', 'az', 'by', 'ee', 'ge', 'kz', 'kg', 'lv', 'lt', 'md', 'ru', 'tj', 'tm', 'ua', 'uz'
]);

const NORDIC = Object.freeze([
  'dk', 'fi', 'is', 'no', 'se'
]);

const DUTCH = Object.freeze([
  'nl'
]);

const CZECH_CUBIST = Object.freeze([
  'cz', 'sk'
]);

const BYZANTINE_LEGACY = Object.freeze([
  'am', 'bg', 'by', 'cy', 'ge', 'gr', 'md', 'mk', 'ro', 'rs', 'ru', 'tr', 'ua'
]);

const OTTOMAN_LEGACY = Object.freeze([
  'al', 'ba', 'bg', 'gr', 'jo', 'lb', 'me', 'mk', 'ps', 'ro', 'rs', 'sy', 'tr', 'xk'
]);

const ANGLOPHONE_GEORGIAN = Object.freeze([
  'ca', 'gb', 'ie', 'us'
]);

const VICTORIAN_CORE = Object.freeze([
  'au', 'ca', 'gb', 'ie', 'in', 'my', 'nz', 'pk', 'sg', 'us', 'za'
]);

const STALINIST_CORE = Object.freeze([
  ...EX_USSR,
  'bg', 'cz', 'de', 'hu', 'pl', 'ro', 'sk'
]);

const SWAHILI_COAST = Object.freeze([
  'ke', 'tz'
]);

const MAMLUK_CORE = Object.freeze([
  'eg', 'il', 'jo', 'lb', 'ps', 'sy'
]);

export const STYLE_ALLOWED_REGIONS = Object.freeze({
  mamluk: [...MAMLUK_CORE],
  ottoman: [...OTTOMAN_LEGACY],
  'pseudo-russian': [...EX_USSR],
  georgian: [...ANGLOPHONE_GEORGIAN],
  victorian: [...VICTORIAN_CORE],
  russian_gothic: ['by', 'ru', 'ua'],
  'neo-byzantine': [...BYZANTINE_LEGACY],
  nothern_modern: [...NORDIC, 'ru'],
  cubism: [...CZECH_CUBIST],
  new_objectivity: ['at', 'ch', 'cz', 'de', 'nl'],
  amsterdam_school: [...DUTCH],
  postconstructivism: [...EX_USSR],
  stalinist_neoclassicism: [...STALINIST_CORE],
  classic_swahili: [...SWAHILI_COAST],
  omani: ['tz'],
  indian: ['tz'],
  british_colonial: ['tz'],
  modernism: ['tz'],
  hypermodern: ['tz']
});

export const STYLE_ALLOWED_REGION_PATTERNS = Object.freeze({});

function normalizeStyleKey(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizeRegionSlugList(regionSlugs = []) {
  return Array.from(new Set(
    (Array.isArray(regionSlugs) ? regionSlugs : [])
      .map((item) => String(item || '').trim().toLowerCase())
      .filter(Boolean)
  ));
}

function escapeRegionPatternForRegex(value) {
  return String(value || '').replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
}

function matchRegionPattern(regionPattern, regionSlug) {
  const pattern = String(regionPattern || '').trim().toLowerCase();
  const slug = String(regionSlug || '').trim().toLowerCase();
  if (!pattern || !slug) return false;
  if (!pattern.includes('*')) return pattern === slug;
  const regex = new RegExp(`^${escapeRegionPatternForRegex(pattern).replace(/\*/g, '.*')}$`);
  return regex.test(slug);
}

function hasMatchingRegionPattern(regionPatterns, regionSlugs) {
  if (!Array.isArray(regionPatterns) || regionPatterns.length === 0) return false;
  const normalizedRegionSlugs = normalizeRegionSlugList(regionSlugs);
  if (normalizedRegionSlugs.length === 0) return false;
  return normalizedRegionSlugs.some((regionSlug) =>
    regionPatterns.some((regionPattern) => matchRegionPattern(regionPattern, regionSlug))
  );
}

function getOverrideSpecificity(regionPattern, regionSlug) {
  const pattern = String(regionPattern || '').trim().toLowerCase();
  const slug = String(regionSlug || '').trim().toLowerCase();
  const wildcardCount = (pattern.match(/\*/g) || []).length;
  return {
    exactMatch: pattern === slug,
    staticLength: pattern.replace(/\*/g, '').length,
    wildcardCount
  };
}

function compareOverridePriority(left, right) {
  if (!left) return -1;
  if (!right) return 1;
  if (left.exactMatch !== right.exactMatch) return left.exactMatch ? 1 : -1;
  if (left.staticLength !== right.staticLength) return left.staticLength - right.staticLength;
  if (left.wildcardCount !== right.wildcardCount) return right.wildcardCount - left.wildcardCount;
  if (left.numericId !== right.numericId) return left.numericId - right.numericId;
  return left.index - right.index;
}

export function extractMacroRegionCodeFromSlug(regionSlug) {
  const text = String(regionSlug || '').trim().toLowerCase();
  if (!text) return '';
  const [macroRegion = ''] = text.split('-', 1);
  return macroRegion.trim();
}

export function resolveArchitectureStyleOverrideDecision(styleKey, regionSlugs = [], overrides = []) {
  const normalizedStyleKey = normalizeStyleKey(styleKey);
  if (!normalizedStyleKey) return null;

  const normalizedRegionSlugs = normalizeRegionSlugList(regionSlugs);
  if (normalizedRegionSlugs.length === 0) return null;

  let bestMatch = null;
  for (const [index, override] of (Array.isArray(overrides) ? overrides : []).entries()) {
    const overrideStyleKey = normalizeStyleKey(override?.style_key);
    const regionPattern = String(override?.region_pattern || '').trim().toLowerCase();
    if (!overrideStyleKey || overrideStyleKey !== normalizedStyleKey || !regionPattern) continue;

    for (const regionSlug of normalizedRegionSlugs) {
      if (!matchRegionPattern(regionPattern, regionSlug)) continue;
      const specificity = getOverrideSpecificity(regionPattern, regionSlug);
      const candidate = {
        ...specificity,
        numericId: Number(override?.id || 0),
        index,
        isAllowed: Boolean(override?.is_allowed)
      };
      if (!bestMatch || compareOverridePriority(candidate, bestMatch) > 0) {
        bestMatch = candidate;
      }
    }
  }

  return bestMatch ? bestMatch.isAllowed : null;
}

export function isArchitectureStyleAllowed(styleKey, regionSlugs = [], overrides = []) {
  const normalizedStyleKey = normalizeStyleKey(styleKey);
  if (!normalizedStyleKey) return false;

  const overrideDecision = resolveArchitectureStyleOverrideDecision(normalizedStyleKey, regionSlugs, overrides);
  if (overrideDecision === true) return true;
  if (overrideDecision === false) return false;

  const normalizedRegionSlugs = normalizeRegionSlugList(regionSlugs);
  if (normalizedRegionSlugs.length === 0) {
    return true;
  }

  const allowedRegionPatterns = STYLE_ALLOWED_REGION_PATTERNS[normalizedStyleKey];
  if (Array.isArray(allowedRegionPatterns) && allowedRegionPatterns.length > 0) {
    return hasMatchingRegionPattern(allowedRegionPatterns, normalizedRegionSlugs);
  }

  const allowedMacroRegions = STYLE_ALLOWED_REGIONS[normalizedStyleKey];
  if (!Array.isArray(allowedMacroRegions) || allowedMacroRegions.length === 0) {
    return true;
  }

  const macroRegions = normalizedRegionSlugs
    .map((regionSlug) => extractMacroRegionCodeFromSlug(regionSlug))
    .filter(Boolean);
  if (macroRegions.length === 0) {
    return true;
  }

  return macroRegions.some((macroRegion) => allowedMacroRegions.includes(macroRegion));
}
