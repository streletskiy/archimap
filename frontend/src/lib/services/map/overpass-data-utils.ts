import { encodeOsmFeatureId } from './filter-utils.js';
import { normalizeBuildingMaterialSelection } from '$lib/utils/building-material';
import { resolveAddressText } from '$lib/utils/building-address';
import {
  coerceNullableIntegerText,
  pickNullableText
} from '$lib/utils/text';

type GeoJSONLike = {
  type?: string | null;
  coordinates?: unknown;
};

type OverpassFeatureLike = {
  id?: number | string | null;
  geometry?: GeoJSONLike | null;
  properties?: Record<string, unknown> | null;
} | null | undefined;

export type OverpassFeaturePayload = {
  osmType: string;
  osmId: number;
  osmKey: string;
  featureKind: 'building' | 'building_part';
  centerLon: number | null;
  centerLat: number | null;
  name: string | null;
  style: string | null;
  styleRaw: string | null;
  design: string | null;
  designRef: string | null;
  designYear: string | null;
  levels: string | null;
  yearBuilt: string | null;
  architect: string | null;
  material: string | null;
  materialRaw: string | null;
  materialConcrete: string | null;
  colour: string | null;
  address: string | null;
  description: string | null;
  archimapDescription: string | null;
  sourceTags: Record<string, string>;
  archiInfo: Record<string, unknown>;
  searchText: string;
};

function normalizeTags(rawTags: Record<string, unknown> | null | undefined) {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(rawTags || {})) {
    const text = Array.isArray(value)
      ? value.map((item) => String(item ?? '').trim()).filter(Boolean).join(';')
      : String(value ?? '').trim();
    if (!key || !text) continue;
    out[String(key)] = text;
  }
  return out;
}

function readTag(tags: Record<string, string>, ...keys: string[]) {
  for (const key of keys) {
    const value = pickNullableText(tags?.[key]);
    if (value) return value;
  }
  return null;
}

function inferFeatureKind(tags: Record<string, string>) {
  return Object.prototype.hasOwnProperty.call(tags, 'building:part')
    ? 'building_part'
    : 'building';
}

function collectBounds(coords: unknown, bounds = {
  minLon: Number.POSITIVE_INFINITY,
  minLat: Number.POSITIVE_INFINITY,
  maxLon: Number.NEGATIVE_INFINITY,
  maxLat: Number.NEGATIVE_INFINITY
}) {
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
    collectBounds(item, bounds);
  }
  return bounds;
}

function getGeometryCenter(geometry: GeoJSONLike | null | undefined) {
  const bounds = collectBounds(geometry?.coordinates);
  if (!Number.isFinite(bounds.minLon) || !Number.isFinite(bounds.minLat) || !Number.isFinite(bounds.maxLon) || !Number.isFinite(bounds.maxLat)) {
    return { lon: null, lat: null };
  }
  return {
    lon: (bounds.minLon + bounds.maxLon) / 2,
    lat: (bounds.minLat + bounds.maxLat) / 2
  };
}

export function buildOverpassArchiInfo(tags: Record<string, string> = {}) {
  const sourceTags = normalizeTags(tags);
  const styleRaw = readTag(sourceTags, 'building:architecture', 'building:style', 'architecture', 'style');
  const design = readTag(sourceTags, 'design', 'building:design');
  const designRef = readTag(sourceTags, 'design_ref', 'design:ref', 'building:design_ref');
  const designYear = coerceNullableIntegerText(
    readTag(sourceTags, 'design_year', 'design:year', 'building:design_year'),
    1000,
    2100
  );
  const levels = coerceNullableIntegerText(readTag(sourceTags, 'levels', 'building:levels'), 0, 300);
  const yearBuilt = coerceNullableIntegerText(
    readTag(sourceTags, 'year_built', 'building:year', 'start_date'),
    1000,
    2100
  );
  const architect = readTag(sourceTags, 'architect', 'building:architect');
  const materialRaw = readTag(sourceTags, 'material', 'building:material');
  const materialConcrete = readTag(sourceTags, 'material_concrete', 'building:material:concrete');
  const normalizedMaterial = normalizeBuildingMaterialSelection(materialRaw, materialConcrete);
  const colour = readTag(sourceTags, 'colour', 'building:colour');
  const name = readTag(sourceTags, 'name', 'name:ru', 'name:en');
  const address = resolveAddressText(sourceTags, pickNullableText, null);
  const description = readTag(sourceTags, 'description');
  const archimapDescription = readTag(sourceTags, 'archimap_description', 'description');

  return {
    name,
    style: styleRaw,
    styleRaw,
    design,
    design_ref: designRef,
    design_year: designYear,
    levels,
    year_built: yearBuilt,
    architect,
    material: normalizedMaterial.material,
    materialRaw,
    materialConcrete,
    colour,
    address,
    description,
    archimap_description: archimapDescription,
    design_ref_suggestions: [],
    _sourceTags: sourceTags
  } satisfies {
    name: string | null;
    style: string | null;
    styleRaw: string | null;
    design: string | null;
    design_ref: string | null;
    design_year: string | null;
    levels: string | null;
    year_built: string | null;
    architect: string | null;
    material: string | null;
    materialRaw: string | null;
    materialConcrete: string | null;
    colour: string | null;
    address: string | null;
    description: string | null;
    archimap_description: string | null;
    design_ref_suggestions: string[];
    _sourceTags: Record<string, string>;
  };
}

export function buildOverpassFeaturePayload(feature: OverpassFeatureLike, {
  tileKey = ''
} = {} as { tileKey?: string }) {
  const properties = feature?.properties && typeof feature.properties === 'object' ? feature.properties : {};
  const rawTags = properties?.tags && typeof properties.tags === 'object'
    ? properties.tags
    : (properties?.source_tags && typeof properties.source_tags === 'object'
      ? properties.source_tags
      : properties);
  const sourceTags = normalizeTags(rawTags as Record<string, unknown>);
  const osmType = String(properties?.type || properties?.osm_type || '').trim();
  const osmId = Number(properties?.id || properties?.osm_id);
  if (!['way', 'relation'].includes(osmType) || !Number.isInteger(osmId) || osmId <= 0) {
    return null;
  }

  const featureKind = inferFeatureKind(sourceTags);
  const geometryCenter = getGeometryCenter(feature?.geometry || null);
  const archiInfo = buildOverpassArchiInfo(sourceTags);
  const osmKey = `${osmType}/${osmId}`;
  const searchText = [
    archiInfo.name,
    archiInfo.address,
    archiInfo.styleRaw,
    archiInfo.design,
    archiInfo.design_ref,
    archiInfo.materialRaw,
    archiInfo.materialConcrete,
    archiInfo.architect,
    archiInfo.description,
    archiInfo.archimap_description,
    ...Object.entries(sourceTags).flatMap(([key, value]) => [key, value]),
    tileKey
  ]
    .filter(Boolean)
    .map((value) => String(value).toLowerCase())
    .join(' ');

  return {
    osmType,
    osmId,
    osmKey,
    featureKind,
    centerLon: Number.isFinite(Number(geometryCenter.lon)) ? Number(geometryCenter.lon) : null,
    centerLat: Number.isFinite(Number(geometryCenter.lat)) ? Number(geometryCenter.lat) : null,
    name: archiInfo.name,
    style: archiInfo.style,
    styleRaw: archiInfo.styleRaw,
    design: archiInfo.design,
    designRef: archiInfo.design_ref,
    designYear: archiInfo.design_year,
    levels: archiInfo.levels,
    yearBuilt: archiInfo.year_built,
    architect: archiInfo.architect,
    material: archiInfo.material,
    materialRaw: archiInfo.materialRaw,
    materialConcrete: archiInfo.materialConcrete,
    colour: archiInfo.colour,
    address: archiInfo.address,
    description: archiInfo.description,
    archimapDescription: archiInfo.archimap_description,
    sourceTags,
    archiInfo,
    searchText
  } satisfies OverpassFeaturePayload;
}

export function buildOverpassSearchItem(feature: OverpassFeatureLike) {
  const payload = buildOverpassFeaturePayload(feature);
  if (!payload) return null;
  return {
    osmType: payload.osmType,
    osmId: payload.osmId,
    lon: payload.centerLon,
    lat: payload.centerLat,
    name: payload.name,
    address: payload.address,
    style: payload.styleRaw || payload.style,
    architect: payload.architect,
    designRef: payload.designRef,
    featureKind: payload.featureKind,
    source: 'overpass',
    sourceTags: payload.sourceTags,
    archiInfo: payload.archiInfo,
    searchText: payload.searchText
  };
}

export function buildOverpassFilterDataItem(feature: OverpassFeatureLike) {
  const payload = buildOverpassFeaturePayload(feature);
  if (!payload) return null;
  return {
    osmKey: payload.osmKey,
    centerLon: payload.centerLon,
    centerLat: payload.centerLat,
    name: payload.name,
    style: payload.style,
    styleRaw: payload.styleRaw,
    design: payload.design,
    designRef: payload.designRef,
    designYear: payload.designYear,
    levels: payload.levels,
    yearBuilt: payload.yearBuilt,
    architect: payload.architect,
    material: payload.material,
    materialRaw: payload.materialRaw,
    materialConcrete: payload.materialConcrete,
    colour: payload.colour,
    address: payload.address,
    description: payload.description,
    archimap_description: payload.archimapDescription,
    sourceTags: payload.sourceTags,
    archiInfo: payload.archiInfo
  };
}

export function buildOverpassBuildingDetails(feature: OverpassFeatureLike) {
  const payload = buildOverpassFeaturePayload(feature);
  if (!payload) return null;
  const sourceGeometryJson = feature?.geometry == null
    ? null
    : JSON.stringify(feature.geometry);
  const sourceTagsJson = JSON.stringify(payload.sourceTags || {});
  return {
    source: 'overpass',
    osmType: payload.osmType,
    osmId: payload.osmId,
    lon: payload.centerLon,
    lat: payload.centerLat,
    featureKind: payload.featureKind,
    feature_kind: payload.featureKind,
    sourceGeometryJson,
    sourceTagsJson,
    sourceOsmUpdatedAt: null,
    review_status: null,
    admin_comment: null,
    user_edit_id: null,
    updated_by: null,
    updated_at: null,
    region_slugs: [],
    properties: {
      archiInfo: payload.archiInfo,
      source_tags: payload.sourceTags,
      source_osm_updated_at: null
    },
    design_ref_suggestions: []
  };
}

export function buildOverpassBuildingKey(feature: OverpassFeatureLike) {
  const payload = buildOverpassFeaturePayload(feature);
  return payload ? payload.osmKey : '';
}

export function encodeOverpassFeatureId(feature: OverpassFeatureLike) {
  const payload = buildOverpassFeaturePayload(feature);
  if (!payload) return null;
  return encodeOsmFeatureId(payload.osmType, payload.osmId);
}
