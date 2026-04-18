const fs = require('fs');
const path = require('path');

const GEOFABRIK_INDEX_URL = 'https://download.geofabrik.de/index-v1.json';
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// Countries that already have a dedicated fine-grained hierarchy handled
// elsewhere — skip our generic Geofabrik-subregion expansion for them.
const SKIP_COUNTRY_IDS = new Set(['russia', 'us']);

interface GeofabrikFeatureProps {
  id: string;
  parent?: string;
  name: string;
  'iso3166-1:alpha2'?: string[];
  'iso3166-2'?: string[];
  urls?: { pbf?: string; [key: string]: string | undefined };
}

interface GeofabrikBBox {
  west: number;
  south: number;
  east: number;
  north: number;
}

export interface SubregionCatalogEntry {
  extractId: string;
  name: string;
  iso: string | null;
  bounds: GeofabrikBBox | null;
  pbfUrl: string | null;
}

export interface CountryCatalogEntry {
  countryId: string;
  name: string;
  iso: string | null;
  bounds: GeofabrikBBox | null;
  pbfUrl: string | null;
  subregions: SubregionCatalogEntry[];
}

function computeBBoxFromGeometry(geometry): GeofabrikBBox | null {
  try {
    let west = Infinity;
    let south = Infinity;
    let east = -Infinity;
    let north = -Infinity;
    const walk = (coords) => {
      if (!Array.isArray(coords)) return;
      if (typeof coords[0] === 'number' && typeof coords[1] === 'number') {
        const [lon, lat] = coords;
        if (Number.isFinite(lon) && Number.isFinite(lat)) {
          if (lon < west) west = lon;
          if (lon > east) east = lon;
          if (lat < south) south = lat;
          if (lat > north) north = lat;
        }
        return;
      }
      for (const inner of coords) walk(inner);
    };
    walk(geometry?.coordinates);
    if (!Number.isFinite(west) || !Number.isFinite(east) || !Number.isFinite(south) || !Number.isFinite(north)) {
      return null;
    }
    if (west >= east || south >= north) return null;
    return { west, south, east, north };
  } catch {
    return null;
  }
}

function parseIndex(raw): CountryCatalogEntry[] {
  const features = Array.isArray(raw?.features) ? raw.features : [];
  const byId = new Map<string, LooseRecord>();
  for (const feature of features) {
    const props = feature?.properties as GeofabrikFeatureProps;
    const id = String(props?.id || '').trim();
    if (!id) continue;
    byId.set(id, { feature, props });
  }

  const countries: CountryCatalogEntry[] = [];
  const subregionsByParent = new Map<string, SubregionCatalogEntry[]>();

  for (const [id, entry] of byId.entries()) {
    const props = entry.props as GeofabrikFeatureProps;
    const parent = String(props?.parent || '').trim();
    const name = String(props?.name || id);
    const iso =
      Array.isArray(props?.['iso3166-1:alpha2']) && props['iso3166-1:alpha2'].length > 0
        ? String(props['iso3166-1:alpha2'][0])
        : Array.isArray(props?.['iso3166-2']) && props['iso3166-2'].length > 0
          ? String(props['iso3166-2'][0])
          : null;
    const bounds = computeBBoxFromGeometry(entry.feature?.geometry);
    const pbfUrl = String(props?.urls?.pbf || '').trim() || null;

    if (!parent) {
      // Continent or root-level country — we keep only leaves that are countries
      // (heuristic: have iso3166-1:alpha2 set). Continents without alpha2 are skipped.
      if (!Array.isArray(props?.['iso3166-1:alpha2']) || props['iso3166-1:alpha2'].length === 0) {
        continue;
      }
      if (SKIP_COUNTRY_IDS.has(id)) continue;
      countries.push({
        countryId: id,
        name,
        iso,
        bounds,
        pbfUrl,
        subregions: []
      });
      continue;
    }

    subregionsByParent.set(
      parent,
      (subregionsByParent.get(parent) || []).concat({
        extractId: id,
        name,
        iso,
        bounds,
        pbfUrl
      })
    );
  }

  for (const country of countries) {
    const subs = subregionsByParent.get(country.countryId) || [];
    country.subregions = subs.slice().sort((a, b) => a.name.localeCompare(b.name));
  }

  return countries.sort((a, b) => a.name.localeCompare(b.name));
}

function createCountrySubregionsCatalog(options: LooseRecord = {}) {
  const dataDir: string = String(options.dataDir || '').trim() || path.join(process.cwd(), 'data');
  const fetchImpl: typeof fetch | null =
    typeof options.fetchImpl === 'function'
      ? options.fetchImpl
      : typeof globalThis.fetch === 'function'
        ? globalThis.fetch.bind(globalThis)
        : null;
  const cachePath = path.join(dataDir, 'country-subregions.json');
  const ttlMs = Number(options.cacheTtlMs ?? CACHE_TTL_MS);
  let memoryCache: { loadedAt: number; countries: CountryCatalogEntry[] } | null = null;

  async function readDiskCache(): Promise<{ loadedAt: number; countries: CountryCatalogEntry[] } | null> {
    try {
      const stat = fs.statSync(cachePath);
      if (!stat.isFile()) return null;
      const payload = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
      const loadedAt = Number(payload?.loadedAt || stat.mtimeMs || 0);
      const countries = Array.isArray(payload?.countries) ? payload.countries : [];
      if (countries.length === 0) return null;
      return { loadedAt, countries };
    } catch {
      return null;
    }
  }

  function writeDiskCache(countries: CountryCatalogEntry[]) {
    try {
      fs.mkdirSync(path.dirname(cachePath), { recursive: true });
      fs.writeFileSync(cachePath, JSON.stringify({ loadedAt: Date.now(), countries }, null, 2), 'utf8');
    } catch (error) {
      console.warn(`[country-subregions] failed to write cache: ${String(error?.message || error)}`);
    }
  }

  async function fetchFresh(): Promise<CountryCatalogEntry[]> {
    if (!fetchImpl) {
      throw new Error('country-subregions: no fetch impl available to refresh Geofabrik index');
    }
    const response = await fetchImpl(GEOFABRIK_INDEX_URL, {
      headers: { accept: 'application/json' }
    } as LooseRecord);
    if (!response?.ok) {
      throw new Error(`country-subregions: Geofabrik index request failed: HTTP ${response?.status ?? 'unknown'}`);
    }
    const body = await response.json();
    const parsed = parseIndex(body);
    writeDiskCache(parsed);
    return parsed;
  }

  async function getCountries(): Promise<CountryCatalogEntry[]> {
    const now = Date.now();
    if (memoryCache && now - memoryCache.loadedAt < ttlMs) {
      return memoryCache.countries;
    }
    const onDisk = await readDiskCache();
    if (onDisk && now - onDisk.loadedAt < ttlMs) {
      memoryCache = onDisk;
      return onDisk.countries;
    }
    try {
      const fresh = await fetchFresh();
      memoryCache = { loadedAt: now, countries: fresh };
      return fresh;
    } catch (error) {
      if (onDisk) {
        memoryCache = onDisk;
        return onDisk.countries;
      }
      throw error;
    }
  }

  async function getCountry(countryId: string): Promise<CountryCatalogEntry | null> {
    const id = String(countryId || '')
      .trim()
      .toLowerCase();
    if (!id) return null;
    const all = await getCountries();
    return all.find((entry) => entry.countryId.toLowerCase() === id) || null;
  }

  async function findByExtractId(extractId: string): Promise<{
    country: CountryCatalogEntry;
    subregion: SubregionCatalogEntry | null;
  } | null> {
    const id = String(extractId || '')
      .trim()
      .toLowerCase();
    if (!id) return null;
    const all = await getCountries();
    for (const country of all) {
      if (country.countryId.toLowerCase() === id) return { country, subregion: null };
      const sub = country.subregions.find((item) => item.extractId.toLowerCase() === id);
      if (sub) return { country, subregion: sub };
    }
    return null;
  }

  return {
    getCountries,
    getCountry,
    findByExtractId,
    refresh: fetchFresh,
    SKIP_COUNTRY_IDS
  };
}

module.exports = {
  createCountrySubregionsCatalog,
  SKIP_COUNTRY_IDS
};
