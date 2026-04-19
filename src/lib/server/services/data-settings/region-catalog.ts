const fs = require('fs');
const path = require('path');

const DEFAULT_REGION_CATALOG_PATH = path.resolve(__dirname, '..', '..', 'data', 'region-catalog.json');

function normalizeNullableText(value, maxLength = 1000) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  return text.slice(0, Math.max(1, maxLength));
}

function normalizeBoolean(value, fallbackValue = false) {
  if (typeof value === 'boolean') return value;
  const text = String(value ?? '')
    .trim()
    .toLowerCase();
  if (text === 'true' || text === '1' || text === 'yes') return true;
  if (text === 'false' || text === '0' || text === 'no') return false;
  return Boolean(fallbackValue);
}

function buildExtractIdentity(extractSource, extractId) {
  const source = String(extractSource || '')
    .trim()
    .toLowerCase();
  const id = String(extractId || '')
    .trim()
    .toLowerCase();
  if (!source || !id) return '';
  return `${source}:${id}`;
}

function normalizeRegionCatalogEntry(entry: LooseRecord = {}) {
  const extractSource = normalizeNullableText(entry.extractSource, 64);
  const extractId = normalizeNullableText(entry.extractId, 240);
  if (!extractSource || !extractId) return null;
  return {
    extractSource,
    extractId,
    name: normalizeNullableText(entry.name, 240) || extractId,
    slug: normalizeNullableText(entry.slug, 160),
    downloadUrl: normalizeNullableText(entry.downloadUrl, 4000),
    stateUrl: normalizeNullableText(entry.stateUrl, 4000),
    regionKind: normalizeNullableText(entry.regionKind, 120),
    countryCode: normalizeNullableText(entry.countryCode, 16),
    iso3166_2: normalizeNullableText(entry.iso3166_2, 32),
    visibleInAdmin: normalizeBoolean(entry.visibleInAdmin, false),
    adminFeatureId: Number.isInteger(Number(entry.adminFeatureId)) ? Number(entry.adminFeatureId) : null,
    countryAggregateEligible: normalizeBoolean(entry.countryAggregateEligible, false),
    countryAggregateParentId: normalizeNullableText(entry.countryAggregateParentId, 240)
  };
}

function createRegionCatalog(options: LooseRecord = {}) {
  const catalogPath =
    String(options.catalogPath || process.env.REGION_CATALOG_PATH || DEFAULT_REGION_CATALOG_PATH).trim() ||
    DEFAULT_REGION_CATALOG_PATH;
  let cache = null;

  function load() {
    if (cache) return cache;
    if (!fs.existsSync(catalogPath)) {
      throw new Error(`Region catalog not found: ${catalogPath}`);
    }

    const payload = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
    const entries = (Array.isArray(payload?.entries) ? payload.entries : [])
      .map((entry) => normalizeRegionCatalogEntry(entry))
      .filter(Boolean);
    const byIdentity = new Map();
    for (const entry of entries) {
      const identity = buildExtractIdentity(entry.extractSource, entry.extractId);
      if (!identity || byIdentity.has(identity)) continue;
      byIdentity.set(identity, entry);
    }

    const visibleEntries = entries.filter((entry) => entry.visibleInAdmin);
    const subregionsByCountryId = new Map();
    for (const entry of entries) {
      if (entry.extractSource !== 'geofabrik') continue;
      const parentId = String(entry.countryAggregateParentId || '').trim();
      if (!parentId) continue;
      const current = subregionsByCountryId.get(parentId) || [];
      current.push({
        extractId: entry.extractId,
        canonicalExtractId: null,
        name: entry.name,
        iso: entry.countryCode,
        bounds: null,
        pbfUrl: entry.downloadUrl
      });
      subregionsByCountryId.set(parentId, current);
    }

    const countries = entries
      .filter((entry) => entry.extractSource === 'geofabrik' && entry.countryAggregateEligible)
      .map((entry) => ({
        countryId: entry.extractId,
        canonicalExtractId: null,
        name: entry.name,
        iso: entry.countryCode,
        bounds: null,
        pbfUrl: entry.downloadUrl,
        subregions: (subregionsByCountryId.get(entry.extractId) || []).sort((left, right) =>
          String(left.name || '').localeCompare(String(right.name || ''))
        )
      }))
      .sort((left, right) => String(left.name || '').localeCompare(String(right.name || '')));

    cache = {
      path: catalogPath,
      entries,
      byIdentity,
      visibleEntries,
      countries
    };
    return cache;
  }

  function findEntry(extractSource, extractId) {
    return load().byIdentity.get(buildExtractIdentity(extractSource, extractId)) || null;
  }

  function searchVisibleEntries(query, options: LooseRecord = {}) {
    const normalizedQuery = String(query || '')
      .trim()
      .toLowerCase();
    const sourceFilter = String(options.source || '')
      .trim()
      .toLowerCase();
    const limit = Math.max(1, Math.min(50, Number(options.limit || 12) || 12));
    if (!normalizedQuery) return [];
    return load().visibleEntries
      .filter((entry) => {
        if (sourceFilter && sourceFilter !== 'any' && entry.extractSource.toLowerCase() !== sourceFilter) {
          return false;
        }
        const haystack = [entry.name, entry.slug, entry.extractId, entry.regionKind, entry.countryCode]
          .filter(Boolean)
          .join(' ')
          .toLowerCase();
        return haystack.includes(normalizedQuery);
      })
      .slice(0, limit);
  }

  function listCountries() {
    return load().countries.slice();
  }

  function getCountry(countryId) {
    const normalizedCountryId = String(countryId || '')
      .trim()
      .toLowerCase();
    if (!normalizedCountryId) return null;
    return (
      load().countries.find((country) => String(country.countryId || '').trim().toLowerCase() === normalizedCountryId) ||
      null
    );
  }

  function findCountryByExtractId(extractId) {
    const normalizedExtractId = String(extractId || '')
      .trim()
      .toLowerCase();
    if (!normalizedExtractId) return null;
    for (const country of load().countries) {
      if (String(country.countryId || '').trim().toLowerCase() === normalizedExtractId) {
        return { country, subregion: null };
      }
      const subregion =
        country.subregions.find(
          (item) => String(item.extractId || '').trim().toLowerCase() === normalizedExtractId
        ) || null;
      if (subregion) {
        return { country, subregion };
      }
    }
    return null;
  }

  return {
    load,
    findEntry,
    searchVisibleEntries,
    listCountries,
    getCountry,
    findCountryByExtractId
  };
}

module.exports = {
  DEFAULT_REGION_CATALOG_PATH,
  buildExtractIdentity,
  createRegionCatalog
};
