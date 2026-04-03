import { apiJson } from '../http.js';
import { matchesFilterRules } from '../../components/map/filter-pipeline-utils.js';
import { encodeOsmFeatureId, parseOsmKey, resolveFeatureIdentity } from './filter-utils.js';
import { normalizeBuildingMaterialSelection } from '$lib/utils/building-material';
import { resolveAddressText } from '$lib/utils/building-address';
import { coerceNullableIntegerText, pickNullableText } from '$lib/utils/text';
import { buildBboxHash } from './filter-bbox.js';
import {
  OVERPASS_BUILDING_SOURCE_ID,
  buildBuilding3dPropertiesFromTags,
  deriveBuildingLevelsText
} from './building-3d-stack.js';
import type {
  FilterBuildingSourceConfig,
  FilterMapLike,
  FilterMatchPayload,
  FilterRequestSpec,
  FilterRule,
  LayerIdsSnapshot
} from './filter-types.js';

type FilterMatchBatchItem = FilterMatchPayload & {
  id?: string;
};

type FilterMatchBatchResponse = {
  items?: FilterMatchBatchItem[];
  meta?: {
    elapsedMs?: number;
    cacheHit?: boolean;
  };
};

type FilterFetcherOptions = {
  resolveMap: () => FilterMapLike | null | undefined;
  resolveLayerIds: () => LayerIdsSnapshot;
  resolveBuildingSourceConfigs: () => FilterBuildingSourceConfig[];
  getCurrentRulesHash: () => string;
  getLastViewportHash: () => string;
  matchDefaultLimit: number;
  dataCacheTtlMs: number;
  dataCacheMaxItems: number;
  dataRequestChunkSize: number;
};

type FilterDataItem = Record<string, unknown> & {
  osmKey?: string;
  centerLon?: number;
  centerLat?: number;
};

function normalizeTags(raw: Record<string, unknown> | null | undefined) {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw || {})) {
    const text = Array.isArray(value)
      ? value
          .map((item) => String(item ?? '').trim())
          .filter(Boolean)
          .join(';')
      : String(value ?? '').trim();
    if (!key || !text) continue;
    out[String(key)] = text;
  }
  return out;
}

function collectGeometryBounds(
  coords: unknown,
  bounds = {
    minLon: Number.POSITIVE_INFINITY,
    minLat: Number.POSITIVE_INFINITY,
    maxLon: Number.NEGATIVE_INFINITY,
    maxLat: Number.NEGATIVE_INFINITY
  }
) {
  if (!Array.isArray(coords)) return bounds;
  if (coords.length >= 2 && typeof coords[0] === 'number' && typeof coords[1] === 'number') {
    const lon = Number(coords[0]);
    const lat = Number(coords[1]);
    if (Number.isFinite(lon) && Number.isFinite(lat)) {
      bounds.minLon = Math.min(bounds.minLon, lon);
      bounds.minLat = Math.min(bounds.minLat, lat);
      bounds.maxLon = Math.max(bounds.maxLon, lon);
      bounds.maxLat = Math.max(bounds.maxLat, lat);
    }
    return bounds;
  }
  for (const item of coords) {
    collectGeometryBounds(item, bounds);
  }
  return bounds;
}

function getGeometryCenter(feature: { geometry?: { coordinates?: unknown } | null } | null | undefined) {
  const bounds = collectGeometryBounds(feature?.geometry?.coordinates);
  if (
    !Number.isFinite(bounds.minLon) ||
    !Number.isFinite(bounds.minLat) ||
    !Number.isFinite(bounds.maxLon) ||
    !Number.isFinite(bounds.maxLat)
  ) {
    return { lon: null, lat: null };
  }
  return {
    lon: (bounds.minLon + bounds.maxLon) / 2,
    lat: (bounds.minLat + bounds.maxLat) / 2
  };
}

function normalizeBbox(value: unknown) {
  if (!value || typeof value !== 'object') return null;
  const bounds = value as {
    getWest?: () => number;
    getSouth?: () => number;
    getEast?: () => number;
    getNorth?: () => number;
    west?: unknown;
    south?: unknown;
    east?: unknown;
    north?: unknown;
  };
  if (typeof bounds.getWest === 'function') {
    const west = Number(bounds.getWest());
    const south = Number(bounds.getSouth?.());
    const east = Number(bounds.getEast?.());
    const north = Number(bounds.getNorth?.());
    if (![west, south, east, north].every(Number.isFinite)) return null;
    return { west, south, east, north };
  }
  const west = Number(bounds.west);
  const south = Number(bounds.south);
  const east = Number(bounds.east);
  const north = Number(bounds.north);
  if (![west, south, east, north].every(Number.isFinite)) return null;
  return { west, south, east, north };
}

function buildFilterDataItemFromFeature(feature: LooseRecord) {
  const identity = resolveFeatureIdentity(feature);
  const osmKey = String(
    feature?.properties?.osm_key || (identity ? `${identity.osmType}/${identity.osmId}` : '')
  ).trim();
  if (!osmKey) return null;
  const sourceTags = normalizeTags(
    feature?.properties?.source_tags && typeof feature.properties.source_tags === 'object'
      ? feature.properties.source_tags
      : feature?.properties?.tags && typeof feature.properties.tags === 'object'
        ? feature.properties.tags
        : {}
  );
  const archiInfo =
    feature?.properties?.archiInfo && typeof feature.properties.archiInfo === 'object'
      ? feature.properties.archiInfo
      : {};
  const center = getGeometryCenter(feature);
  const normalizedMaterial = normalizeBuildingMaterialSelection(
    pickNullableText(
      archiInfo.material,
      feature?.properties?.material,
      sourceTags['building:material'],
      sourceTags.material
    ),
    pickNullableText(
      archiInfo.materialConcrete,
      feature?.properties?.materialConcrete,
      sourceTags['building:material:concrete'],
      sourceTags.material_concrete
    )
  );
  const render3dProperties = buildBuilding3dPropertiesFromTags(sourceTags);
  const renderHeightMeters = Number.isFinite(
    Number(feature?.properties?.render_height_m ?? feature?.properties?.renderHeightMeters)
  )
    ? Number(feature?.properties?.render_height_m ?? feature?.properties?.renderHeightMeters)
    : Number(render3dProperties.render_height_m || 0);
  const renderMinHeightMeters = Number.isFinite(
    Number(feature?.properties?.render_min_height_m ?? feature?.properties?.renderMinHeightMeters)
  )
    ? Number(feature?.properties?.render_min_height_m ?? feature?.properties?.renderMinHeightMeters)
    : Number(render3dProperties.render_min_height_m || 0);
  const derivedLevels = deriveBuildingLevelsText({
    tags: sourceTags,
    renderHeightMeters: feature?.properties?.render_height_m ?? feature?.properties?.renderHeightMeters,
    renderMinHeightMeters: feature?.properties?.render_min_height_m ?? feature?.properties?.renderMinHeightMeters
  });
  const normalizedArchiInfo = {
    ...archiInfo,
    _sourceTags: sourceTags,
    name: pickNullableText(
      archiInfo.name,
      feature?.properties?.name,
      sourceTags.name,
      sourceTags['name:ru'],
      sourceTags['name:en']
    ),
    style: pickNullableText(
      archiInfo.style,
      feature?.properties?.style,
      sourceTags['building:architecture'],
      sourceTags['building:style'],
      sourceTags.architecture,
      sourceTags.style
    ),
    styleRaw: pickNullableText(
      archiInfo.styleRaw,
      feature?.properties?.styleRaw,
      feature?.properties?.style,
      sourceTags['building:architecture'],
      sourceTags['building:style'],
      sourceTags.architecture,
      sourceTags.style
    ),
    design: pickNullableText(archiInfo.design, feature?.properties?.design, sourceTags.design),
    design_ref: pickNullableText(
      archiInfo.design_ref,
      feature?.properties?.design_ref,
      sourceTags['design:ref'],
      sourceTags.design_ref
    ),
    design_year: coerceNullableIntegerText(
      archiInfo.design_year ?? feature?.properties?.design_year ?? sourceTags['design:year'] ?? sourceTags.design_year,
      1000,
      2100
    ),
    levels: coerceNullableIntegerText(
      archiInfo.levels ??
        feature?.properties?.levels ??
        sourceTags['building:levels'] ??
        sourceTags.levels ??
        derivedLevels,
      0,
      300
    ),
    year_built: coerceNullableIntegerText(
      archiInfo.year_built ?? feature?.properties?.year_built ?? sourceTags['building:year'] ?? sourceTags.start_date,
      1000,
      2100
    ),
    architect: pickNullableText(
      archiInfo.architect,
      feature?.properties?.architect,
      sourceTags.architect,
      sourceTags['building:architect']
    ),
    material: normalizedMaterial.material,
    materialRaw: pickNullableText(
      archiInfo.materialRaw,
      feature?.properties?.materialRaw,
      feature?.properties?.material,
      sourceTags['building:material'],
      sourceTags.material
    ),
    materialConcrete: pickNullableText(
      archiInfo.materialConcrete,
      feature?.properties?.materialConcrete,
      sourceTags['building:material:concrete'],
      sourceTags.material_concrete
    ),
    colour: pickNullableText(
      archiInfo.colour,
      feature?.properties?.colour,
      sourceTags.colour,
      sourceTags['building:colour']
    ),
    address: pickNullableText(
      archiInfo.address,
      resolveAddressText(
        {
          ...sourceTags,
          ...feature?.properties
        },
        pickNullableText,
        feature?.properties?.address
      )
    ),
    description: pickNullableText(archiInfo.description, feature?.properties?.description, sourceTags.description),
    archimap_description: pickNullableText(
      archiInfo.archimap_description,
      feature?.properties?.archimap_description,
      feature?.properties?.description,
      sourceTags.archimap_description,
      sourceTags.description
    ),
    design_ref_suggestions: Array.isArray(archiInfo.design_ref_suggestions) ? archiInfo.design_ref_suggestions : []
  };

  return {
    osmKey,
    centerLon: center.lon,
    centerLat: center.lat,
    sourceTags,
    archiInfo: normalizedArchiInfo,
    name: normalizedArchiInfo.name,
    style: normalizedArchiInfo.style,
    styleRaw: normalizedArchiInfo.styleRaw,
    design: normalizedArchiInfo.design,
    designRef: normalizedArchiInfo.design_ref,
    designYear: normalizedArchiInfo.design_year,
    levels: normalizedArchiInfo.levels,
    yearBuilt: normalizedArchiInfo.year_built,
    architect: normalizedArchiInfo.architect,
    material: normalizedArchiInfo.material,
    materialRaw: normalizedArchiInfo.materialRaw,
    materialConcrete: normalizedArchiInfo.materialConcrete,
    colour: normalizedArchiInfo.colour,
    address: normalizedArchiInfo.address,
    description: normalizedArchiInfo.description,
    archimap_description: normalizedArchiInfo.archimap_description,
    renderHeightMeters,
    renderMinHeightMeters
  };
}

function getRenderableLayerIds(currentMap: FilterMapLike | null | undefined, layerIds: string[] = []) {
  if (!currentMap) return [];
  return [
    ...new Set(
      (Array.isArray(layerIds) ? layerIds : [])
        .map((layerId) => String(layerId || '').trim())
        .filter((layerId) => layerId && Boolean(currentMap.getLayer?.(layerId)))
    )
  ];
}

function getLoadedSourceBuildingDataMap(
  currentMap: FilterMapLike | null | undefined,
  buildingSourceConfigs: FilterBuildingSourceConfig[] = []
) {
  if (!currentMap) return new Map<string, FilterDataItem>();
  const out = new Map<string, FilterDataItem>();
  for (const sourceConfig of buildingSourceConfigs) {
    if (!sourceConfig?.sourceId || !currentMap.getSource(sourceConfig.sourceId)) continue;
    const queryOptions = sourceConfig.sourceLayer ? { sourceLayer: sourceConfig.sourceLayer } : {};
    const features = currentMap.querySourceFeatures(sourceConfig.sourceId, queryOptions as { sourceLayer?: string });
    for (const feature of Array.isArray(features) ? features : []) {
      const item = buildFilterDataItemFromFeature(feature as LooseRecord);
      if (!item?.osmKey) continue;
      out.set(String(item.osmKey), item);
    }
  }
  return out;
}

function getLoadedOverpassBuildingDataMap(
  currentMap: FilterMapLike | null | undefined,
  buildingSourceConfigs: FilterBuildingSourceConfig[] = []
) {
  if (!currentMap) return new Map<string, FilterDataItem>();
  const out = new Map<string, FilterDataItem>();
  for (const sourceConfig of buildingSourceConfigs) {
    if (String(sourceConfig?.sourceId || '') !== OVERPASS_BUILDING_SOURCE_ID) continue;
    if (!sourceConfig?.sourceId || !currentMap.getSource(sourceConfig.sourceId)) continue;
    const queryOptions = sourceConfig.sourceLayer ? { sourceLayer: sourceConfig.sourceLayer } : {};
    let features: unknown[];
    try {
      features = currentMap.querySourceFeatures(sourceConfig.sourceId, queryOptions as { sourceLayer?: string });
    } catch {
      features = [];
    }
    for (const feature of Array.isArray(features) ? features : []) {
      const item = buildFilterDataItemFromFeature(feature as LooseRecord);
      if (!item?.osmKey) continue;
      out.set(String(item.osmKey), item);
    }
  }
  return out;
}

function buildOverpassMatchPayload({
  currentMap,
  buildingSourceConfigs,
  rules,
  maxResults
}: {
  currentMap: FilterMapLike | null | undefined;
  buildingSourceConfigs: FilterBuildingSourceConfig[];
  rules: FilterRule[];
  maxResults: number;
}) {
  const localData = getLoadedOverpassBuildingDataMap(currentMap, buildingSourceConfigs);
  const matchedKeys: string[] = [];
  const matchedFeatureIds: number[] = [];
  const matchedLocations: Array<{ id: number; lon: number; lat: number; count: number; osmKey: string }> = [];
  for (const [key, item] of localData.entries()) {
    if (!matchesFilterRules(item, rules)) continue;
    const parsed = parseOsmKey(key);
    if (!parsed) continue;
    const featureId = encodeOsmFeatureId(parsed.osmType, parsed.osmId);
    matchedKeys.push(key);
    matchedFeatureIds.push(featureId);
    const lon = Number(item.centerLon);
    const lat = Number(item.centerLat);
    if (Number.isFinite(lon) && Number.isFinite(lat)) {
      matchedLocations.push({
        id: featureId,
        lon,
        lat,
        count: 1,
        osmKey: key
      });
    }
    if (matchedKeys.length >= maxResults) break;
  }
  return {
    matchedKeys,
    matchedFeatureIds,
    matchedLocations,
    matchedCount: matchedFeatureIds.length,
    truncated: matchedKeys.length >= maxResults
  };
}

function normalizeMatchedLocation(point: unknown) {
  const id = Number((point as { id?: number | string | null } | null | undefined)?.id);
  const lon = Number((point as { lon?: number | string | null } | null | undefined)?.lon);
  const lat = Number((point as { lat?: number | string | null } | null | undefined)?.lat);
  if (!Number.isInteger(id) || id <= 0) return null;
  if (!Number.isFinite(lon) || lon < -180 || lon > 180) return null;
  if (!Number.isFinite(lat) || lat < -90 || lat > 90) return null;
  const count = Number((point as { count?: number | string | null } | null | undefined)?.count);
  const normalizedCount = Number.isFinite(count) && count > 0 ? Math.max(1, Math.trunc(count)) : 1;
  const osmKey = String((point as { osmKey?: string | null } | null | undefined)?.osmKey || '').trim();
  return {
    id,
    lon,
    lat,
    count: normalizedCount,
    ...(osmKey ? { osmKey } : {})
  };
}

function mergeMatchPayloads(
  primary: FilterMatchPayload | null | undefined,
  overpass: ReturnType<typeof buildOverpassMatchPayload> | null | undefined,
  defaults: {
    rulesHash: string;
    bboxHash: string;
    coverageHash?: string;
    coverageWindow?: FilterMatchPayload['meta']['coverageWindow'];
    zoomBucket?: number;
    renderMode?: FilterMatchPayload['meta']['renderMode'];
    dataVersion?: number;
    maxResults?: number;
  }
): FilterMatchPayload {
  const payload: FilterMatchPayload | null | undefined = primary;
  const mergedKeys: string[] = [];
  const mergedFeatureIds: number[] = [];
  const mergedLocations: Array<{ id: number; lon: number; lat: number; count: number; osmKey?: string }> = [];
  const seenKeys = new Set<string>();
  const seenIds = new Set<number>();
  const seenLocationIds = new Set<number>();

  function addPayload(
    source:
      | Pick<FilterMatchPayload, 'matchedKeys' | 'matchedFeatureIds' | 'matchedLocations'>
      | FilterMatchPayload
      | null
      | undefined
  ) {
    for (const key of Array.isArray(source?.matchedKeys) ? source.matchedKeys : []) {
      const normalizedKey = String(key || '').trim();
      if (!normalizedKey || seenKeys.has(normalizedKey)) continue;
      seenKeys.add(normalizedKey);
      mergedKeys.push(normalizedKey);
    }
    for (const rawId of Array.isArray(source?.matchedFeatureIds) ? source.matchedFeatureIds : []) {
      const id = Number(rawId);
      if (!Number.isInteger(id) || id <= 0 || seenIds.has(id)) continue;
      seenIds.add(id);
      mergedFeatureIds.push(id);
    }
    for (const point of Array.isArray(source?.matchedLocations) ? source.matchedLocations : []) {
      const normalized = normalizeMatchedLocation(point);
      if (!normalized || seenLocationIds.has(normalized.id)) continue;
      seenLocationIds.add(normalized.id);
      if (!seenIds.has(normalized.id)) {
        seenIds.add(normalized.id);
        mergedFeatureIds.push(normalized.id);
      }
      mergedLocations.push(normalized);
    }
  }

  addPayload(payload);
  if (overpass) {
    addPayload(overpass);
  }

  const maxResults = Math.max(
    1,
    Math.trunc(Number(defaults.maxResults) || mergedFeatureIds.length || mergedKeys.length || 1)
  );
  const truncated = Boolean(
    payload?.meta?.truncated ||
    overpass?.truncated ||
    mergedKeys.length >= maxResults ||
    mergedFeatureIds.length >= maxResults ||
    mergedLocations.length >= maxResults
  );
  const limitedKeys = mergedKeys.slice(0, maxResults);
  const limitedFeatureIds = mergedFeatureIds.slice(0, maxResults);
  const limitedLocations = mergedLocations.slice(0, maxResults);

  return {
    matchedKeys: limitedKeys,
    matchedFeatureIds: limitedFeatureIds,
    ...(limitedLocations.length > 0 ? { matchedLocations: limitedLocations } : {}),
    ...(Number.isFinite(Number(payload?.matchedCount))
      ? { matchedCount: Math.min(maxResults, Number(payload?.matchedCount) + Number(overpass?.matchedCount || 0)) }
      : { matchedCount: limitedFeatureIds.length }),
    meta: {
      rulesHash: String(payload?.meta?.rulesHash || defaults.rulesHash || 'fnv1a-0'),
      bboxHash: String(payload?.meta?.bboxHash || defaults.bboxHash || ''),
      truncated,
      elapsedMs: Number(payload?.meta?.elapsedMs || 0),
      cacheHit: Boolean(payload?.meta?.cacheHit),
      fallback: Boolean(payload?.meta?.fallback),
      renderMode: payload?.meta?.renderMode || defaults.renderMode || 'contours',
      coverageHash: payload?.meta?.coverageHash ?? defaults.coverageHash,
      coverageWindow: payload?.meta?.coverageWindow ?? defaults.coverageWindow ?? null,
      zoomBucket: Number(payload?.meta?.zoomBucket ?? defaults.zoomBucket ?? 0),
      dataVersion: Number(payload?.meta?.dataVersion ?? defaults.dataVersion ?? 0)
    }
  };
}

export function createFilterFetcher(
  {
    resolveMap,
    resolveLayerIds,
    resolveBuildingSourceConfigs,
    getCurrentRulesHash,
    getLastViewportHash,
    matchDefaultLimit,
    dataCacheTtlMs,
    dataCacheMaxItems,
    dataRequestChunkSize
  }: FilterFetcherOptions = {} as FilterFetcherOptions
) {
  let filterDataByOsmKeyCache = new Map<string, { cachedAt: number; item: FilterDataItem }>();

  function getVisibleBuildingOsmKeys() {
    const currentMap = resolveMap();
    if (!currentMap) return [];
    const layerIds = resolveLayerIds();
    const buildingLayerIds = getRenderableLayerIds(currentMap, [
      ...layerIds.buildingFillLayerIds,
      ...layerIds.buildingLineLayerIds,
      ...layerIds.buildingPartFillLayerIds,
      ...layerIds.buildingPartLineLayerIds
    ]);
    if (buildingLayerIds.length === 0) return [];
    const features = currentMap.queryRenderedFeatures({ layers: buildingLayerIds });
    const keys = new Set<string>();
    for (const feature of Array.isArray(features) ? features : []) {
      const identity = resolveFeatureIdentity(feature);
      if (!identity?.osmType || !Number.isInteger(identity?.osmId)) continue;
      keys.add(`${identity.osmType}/${identity.osmId}`);
    }
    return [...keys];
  }

  function getLoadedSourceBuildingOsmKeys() {
    return [...getLoadedSourceBuildingDataMap(resolveMap(), resolveBuildingSourceConfigs()).keys()];
  }

  function getFilterCandidateOsmKeys() {
    const renderedKeys = getVisibleBuildingOsmKeys();
    if (renderedKeys.length > 0) return renderedKeys;
    return getLoadedSourceBuildingOsmKeys();
  }

  async function fetchFilterMatchesPrimary({
    bbox,
    zoomBucket,
    rules,
    rulesHash,
    maxResults,
    renderMode,
    dataVersion,
    signal
  }: {
    bbox: unknown;
    zoomBucket: number;
    rules: FilterRule[];
    rulesHash: string;
    maxResults?: number;
    renderMode?: 'contours' | 'markers';
    dataVersion?: number;
    signal?: AbortSignal | null;
  }): Promise<FilterMatchPayload> {
    const requestedMaxResults = Number.isFinite(Number(maxResults)) ? Number(maxResults) : matchDefaultLimit;
    const normalizedBbox = normalizeBbox(bbox);
    const payload = (await apiJson('/api/buildings/filter-matches', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        bbox,
        zoomBucket,
        renderMode: String(renderMode || 'contours') === 'markers' ? 'markers' : 'contours',
        rules,
        rulesHash,
        maxResults: Math.max(1, Math.trunc(requestedMaxResults))
      }),
      signal
    })) as FilterMatchPayload;
    const overpassPayload = buildOverpassMatchPayload({
      currentMap: resolveMap(),
      buildingSourceConfigs: resolveBuildingSourceConfigs(),
      rules,
      maxResults: Math.max(1, Math.trunc(requestedMaxResults))
    });
    return mergeMatchPayloads(payload, overpassPayload, {
      rulesHash,
      bboxHash: getLastViewportHash?.() || '',
      coverageHash: buildBboxHash(normalizedBbox, 4),
      coverageWindow: normalizedBbox,
      zoomBucket,
      renderMode,
      dataVersion,
      maxResults: Math.max(1, Math.trunc(requestedMaxResults))
    });
  }

  async function fetchFilterMatchesBatchPrimary({
    bbox,
    zoomBucket,
    requestSpecs,
    maxResults,
    renderMode,
    dataVersion,
    signal
  }: {
    bbox: unknown;
    zoomBucket: number;
    requestSpecs: FilterRequestSpec[];
    maxResults?: number;
    renderMode?: 'contours' | 'markers';
    dataVersion?: number;
    signal?: AbortSignal | null;
  }): Promise<FilterMatchBatchResponse> {
    const requestedMaxResults = Number.isFinite(Number(maxResults)) ? Number(maxResults) : matchDefaultLimit;
    const batchPayload = (await apiJson('/api/buildings/filter-matches-batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        bbox,
        zoomBucket,
        renderMode: String(renderMode || 'contours') === 'markers' ? 'markers' : 'contours',
        requests: (Array.isArray(requestSpecs) ? requestSpecs : []).map((spec) => ({
          id: String(spec?.id || ''),
          rules: Array.isArray(spec?.rules) ? spec.rules : [],
          rulesHash: String(spec?.rulesHash || ''),
          maxResults: Math.max(1, Math.trunc(requestedMaxResults))
        }))
      }),
      signal
    })) as FilterMatchBatchResponse;
    const maxResultsInt = Math.max(1, Math.trunc(requestedMaxResults));
    const normalizedBbox = normalizeBbox(bbox);
    const items = (Array.isArray(requestSpecs) ? requestSpecs : []).map((spec) => {
      const serverItem =
        (Array.isArray(batchPayload?.items) ? batchPayload.items : []).find(
          (item) => String(item?.id || '') === String(spec?.id || '')
        ) || null;
      const overpassPayload = buildOverpassMatchPayload({
        currentMap: resolveMap(),
        buildingSourceConfigs: resolveBuildingSourceConfigs(),
        rules: Array.isArray(spec?.rules) ? spec.rules : [],
        maxResults: maxResultsInt
      });
      return {
        id: String(spec?.id || ''),
        ...mergeMatchPayloads(serverItem, overpassPayload, {
          rulesHash: String(spec?.rulesHash || ''),
          bboxHash: getLastViewportHash?.() || '',
          coverageHash: buildBboxHash(normalizedBbox, 4),
          coverageWindow: normalizedBbox,
          zoomBucket,
          renderMode,
          dataVersion,
          maxResults: maxResultsInt
        })
      };
    });
    return {
      ...(batchPayload || {}),
      items
    };
  }

  async function fetchFilterDataByOsmKeys(keys: string[], signal?: AbortSignal | null) {
    const normalized = [
      ...new Set(
        (Array.isArray(keys) ? keys : [])
          .map((key) => String(key || '').trim())
          .filter((key) => /^(way|relation)\/\d+$/.test(key))
      )
    ];
    if (normalized.length === 0) return new Map<string, FilterDataItem>();

    const out = new Map<string, FilterDataItem>();
    const missing = [];
    const now = Date.now();
    const loadedSourceData = getLoadedSourceBuildingDataMap(resolveMap(), resolveBuildingSourceConfigs());
    for (const key of normalized) {
      const localItem = loadedSourceData.get(key);
      if (localItem) {
        out.set(key, localItem);
        filterDataByOsmKeyCache.set(key, {
          cachedAt: now,
          item: localItem
        });
        continue;
      }
      const cached = filterDataByOsmKeyCache.get(key);
      if (cached && now - cached.cachedAt <= dataCacheTtlMs) {
        out.set(key, cached.item);
      } else {
        if (cached) filterDataByOsmKeyCache.delete(key);
        missing.push(key);
      }
    }

    for (let i = 0; i < missing.length; i += dataRequestChunkSize) {
      const chunk = missing.slice(i, i + dataRequestChunkSize);
      const payload = await apiJson('/api/buildings/filter-data', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ keys: chunk }),
        signal
      });
      const items = Array.isArray(payload?.items) ? payload.items : [];
      for (const item of items) {
        const osmKey = String(item?.osmKey || '').trim();
        if (!osmKey) continue;
        filterDataByOsmKeyCache.set(osmKey, {
          cachedAt: Date.now(),
          item
        });
        while (filterDataByOsmKeyCache.size > dataCacheMaxItems) {
          const oldestKey = filterDataByOsmKeyCache.keys().next().value;
          if (!oldestKey) break;
          filterDataByOsmKeyCache.delete(oldestKey);
        }
        out.set(osmKey, item);
      }
    }

    return out;
  }

  async function fetchFilterMatchesFallback({
    rules,
    dataVersion,
    signal
  }: {
    rules: FilterRule[];
    dataVersion?: number;
    signal?: AbortSignal | null;
  }): Promise<FilterMatchPayload> {
    const visibleKeys = getFilterCandidateOsmKeys();
    if (visibleKeys.length === 0) {
      return {
        matchedKeys: [],
        matchedFeatureIds: [],
        meta: {
          rulesHash: getCurrentRulesHash?.() || 'fnv1a-0',
          bboxHash: getLastViewportHash?.() || '',
          truncated: false,
          elapsedMs: 0,
          cacheHit: false,
          dataVersion: Number(dataVersion || 0)
        }
      };
    }

    const byKey = await fetchFilterDataByOsmKeys(visibleKeys, signal);
    const matchedKeys = [];
    const matchedFeatureIds = [];
    const matchedLocations = [];
    for (const key of visibleKeys) {
      const item = byKey.get(key);
      if (!item) continue;
      const ok = matchesFilterRules(item, rules);
      if (!ok) continue;
      matchedKeys.push(key);
      const parsed = parseOsmKey(key);
      if (parsed) {
        const featureId = encodeOsmFeatureId(parsed.osmType, parsed.osmId);
        matchedFeatureIds.push(featureId);
        const lon = Number(item.centerLon);
        const lat = Number(item.centerLat);
        if (Number.isFinite(lon) && Number.isFinite(lat)) {
          matchedLocations.push({
            id: featureId,
            lon,
            lat,
            count: 1,
            osmKey: key
          });
        }
      }
      if (matchedKeys.length >= matchDefaultLimit) break;
    }

    return {
      matchedKeys,
      matchedFeatureIds,
      matchedLocations,
      meta: {
        rulesHash: getCurrentRulesHash?.() || 'fnv1a-0',
        bboxHash: getLastViewportHash?.() || '',
        truncated: matchedKeys.length >= matchDefaultLimit,
        elapsedMs: 0,
        cacheHit: false,
        dataVersion: Number(dataVersion || 0)
      }
    };
  }

  function clear() {
    filterDataByOsmKeyCache = new Map();
  }

  return {
    clear,
    fetchFilterDataByOsmKeys,
    fetchFilterMatchesBatchPrimary,
    fetchFilterMatchesFallback,
    fetchFilterMatchesPrimary
  };
}
