import polygonClipping from 'polygon-clipping';
import { encodeOsmFeatureId } from './filter-utils.js';
import { normalizeBuildingMaterialSelection } from '$lib/utils/building-material';
import { normalizeRoofShapeSelection } from '$lib/utils/roof-shape';
import { resolveAddressText } from '$lib/utils/building-address';
import {
  coerceNullableIntegerText,
  pickNullableText
} from '$lib/utils/text';
import {
  BUILDING_HIDE_BASE_WHEN_PARTS_PROPERTY,
  buildBuilding3dPropertiesFromTags,
  deriveBuildingLevelsText
} from './map-3d-utils.js';

type GeoJSONLike = {
  type?: string | null;
  coordinates?: unknown;
};

type GeometryBounds = {
  minLon: number;
  minLat: number;
  maxLon: number;
  maxLat: number;
};

type OverpassFeatureLike = {
  type: 'Feature';
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
  roofShape: string | null;
  colour: string | null;
  address: string | null;
  description: string | null;
  archimapDescription: string | null;
  sourceTags: Record<string, string>;
  archiInfo: Record<string, unknown>;
  searchText: string;
  renderHeightMeters: number;
  renderMinHeightMeters: number;
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

function cloneCoordinatePair(pair: unknown) {
  if (!Array.isArray(pair) || pair.length < 2) return null;
  const lon = Number(pair[0]);
  const lat = Number(pair[1]);
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
  return [lon, lat];
}

function closeLinearRing(ring: unknown) {
  if (!Array.isArray(ring) || ring.length < 3) return null;
  const normalized: number[][] = [];
  for (const coordinate of ring) {
    const pair = cloneCoordinatePair(coordinate);
    if (!pair) continue;
    const previous = normalized[normalized.length - 1];
    if (previous && previous[0] === pair[0] && previous[1] === pair[1]) continue;
    normalized.push(pair);
  }
  if (normalized.length < 3) return null;
  const first = normalized[0];
  const last = normalized[normalized.length - 1];
  if (first[0] !== last[0] || first[1] !== last[1]) {
    normalized.push([first[0], first[1]]);
  }
  return normalized.length >= 4 ? normalized : null;
}

function normalizePolygonCoordinates(polygon: unknown) {
  if (!Array.isArray(polygon) || polygon.length === 0) return null;
  const normalized: number[][][] = [];
  for (const ring of polygon) {
    const nextRing = closeLinearRing(ring);
    if (!nextRing) continue;
    normalized.push(nextRing);
  }
  return normalized.length > 0 ? normalized : null;
}

function normalizeMultiPolygonCoordinates(multiPolygon: unknown) {
  if (!Array.isArray(multiPolygon) || multiPolygon.length === 0) return null;
  const normalized: number[][][][] = [];
  for (const polygon of multiPolygon) {
    const nextPolygon = normalizePolygonCoordinates(polygon);
    if (!nextPolygon) continue;
    normalized.push(nextPolygon);
  }
  return normalized.length > 0 ? normalized : null;
}

function normalizePolygonGeometry(geometry: GeoJSONLike | null | undefined) {
  const geometryType = String(geometry?.type || '').trim();
  if (geometryType === 'Polygon') {
    const coordinates = normalizePolygonCoordinates(geometry?.coordinates);
    return coordinates ? { type: 'Polygon', coordinates } : null;
  }
  if (geometryType === 'MultiPolygon') {
    const coordinates = normalizeMultiPolygonCoordinates(geometry?.coordinates);
    return coordinates ? { type: 'MultiPolygon', coordinates } : null;
  }
  return null;
}

function toPolygonClippingMultiPolygon(geometry: { type: string; coordinates: unknown } | null) {
  if (!geometry) return null;
  if (geometry.type === 'Polygon') {
    return [geometry.coordinates];
  }
  if (geometry.type === 'MultiPolygon') {
    return geometry.coordinates;
  }
  return null;
}

function fromPolygonClippingMultiPolygon(multiPolygon: unknown) {
  const normalized = normalizeMultiPolygonCoordinates(multiPolygon);
  if (!normalized) return null;
  if (normalized.length === 1) {
    return {
      type: 'Polygon',
      coordinates: normalized[0]
    };
  }
  return {
    type: 'MultiPolygon',
    coordinates: normalized
  };
}

function buildDifferenceGeometry(baseGeometry: GeoJSONLike | null | undefined, subtractGeometries: Array<GeoJSONLike | null | undefined> = []) {
  const subject = toPolygonClippingMultiPolygon(normalizePolygonGeometry(baseGeometry));
  const clipGeometries = subtractGeometries
    .map((geometry) => toPolygonClippingMultiPolygon(normalizePolygonGeometry(geometry)))
    .filter(Boolean);
  if (!subject) {
    return { ok: false, geometry: null };
  }
  if (clipGeometries.length === 0) {
    return { ok: true, geometry: normalizePolygonGeometry(baseGeometry) };
  }
  try {
    const clipMask = clipGeometries.length === 1
      ? clipGeometries[0]
      : polygonClipping.union(...clipGeometries);
    const difference = clipMask ? polygonClipping.difference(subject, clipMask) : subject;
    return {
      ok: true,
      geometry: fromPolygonClippingMultiPolygon(difference)
    };
  } catch {
    return { ok: false, geometry: null };
  }
}

function getGeometryBounds(geometry: GeoJSONLike | null | undefined): GeometryBounds | null {
  const bounds = collectBounds(geometry?.coordinates);
  if (
    !Number.isFinite(bounds.minLon)
    || !Number.isFinite(bounds.minLat)
    || !Number.isFinite(bounds.maxLon)
    || !Number.isFinite(bounds.maxLat)
  ) {
    return null;
  }
  return bounds;
}

function boundsContainBounds(container: GeometryBounds | null, inner: GeometryBounds | null) {
  if (!container || !inner) return false;
  return inner.minLon >= container.minLon
    && inner.maxLon <= container.maxLon
    && inner.minLat >= container.minLat
    && inner.maxLat <= container.maxLat;
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
  const levels = coerceNullableIntegerText(
    readTag(sourceTags, 'levels', 'building:levels') ?? deriveBuildingLevelsText({ tags: sourceTags }),
    0,
    300
  );
  const yearBuilt = coerceNullableIntegerText(
    readTag(sourceTags, 'year_built', 'building:year', 'start_date'),
    1000,
    2100
  );
  const architect = readTag(sourceTags, 'architect', 'building:architect');
  const materialRaw = readTag(sourceTags, 'material', 'building:material');
  const materialConcrete = readTag(sourceTags, 'material_concrete', 'building:material:concrete');
  const normalizedMaterial = normalizeBuildingMaterialSelection(materialRaw, materialConcrete);
  const roofShape = normalizeRoofShapeSelection(
    readTag(sourceTags, 'roof:shape', 'roof_shape', 'building:roof:shape')
  );
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
    roof_shape: roofShape,
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
    roof_shape: string | null;
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
  const render3dProperties = buildBuilding3dPropertiesFromTags(sourceTags);
  const osmKey = `${osmType}/${osmId}`;
  const searchText = [
    archiInfo.name,
    archiInfo.address,
    archiInfo.styleRaw,
    archiInfo.design,
    archiInfo.design_ref,
    archiInfo.materialRaw,
    archiInfo.materialConcrete,
    archiInfo.roof_shape,
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
    roofShape: archiInfo.roof_shape,
    colour: archiInfo.colour,
    address: archiInfo.address,
    description: archiInfo.description,
    archimapDescription: archiInfo.archimap_description,
    sourceTags,
    archiInfo,
    searchText,
    renderHeightMeters: Number(render3dProperties.render_height_m || 0),
    renderMinHeightMeters: Number(render3dProperties.render_min_height_m || 0)
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
    renderHeightMeters: payload.renderHeightMeters,
    renderMinHeightMeters: payload.renderMinHeightMeters,
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
      source_osm_updated_at: null,
      render_height_m: payload.renderHeightMeters,
      render_min_height_m: payload.renderMinHeightMeters
    },
    renderHeightMeters: payload.renderHeightMeters,
    renderMinHeightMeters: payload.renderMinHeightMeters,
    design_ref_suggestions: []
  };
}

export function buildOverpassBuildingKey(feature: OverpassFeatureLike) {
  const payload = buildOverpassFeaturePayload(feature);
  return payload ? payload.osmKey : '';
}

export function applyBuildingPartBaseSuppression(features: OverpassFeatureLike[] = []) {
  const normalizedFeatures = (Array.isArray(features) ? features : []).filter(Boolean) as Array<Exclude<OverpassFeatureLike, null | undefined>>;
  const buildings: Array<{ feature: OverpassFeatureLike; bounds: GeometryBounds | null }> = [];
  const parts: Array<{ bounds: GeometryBounds; geometry: GeoJSONLike }> = [];
  const syntheticRemainders: OverpassFeatureLike[] = [];

  for (const feature of normalizedFeatures) {
    const properties = feature?.properties && typeof feature.properties === 'object' ? feature.properties : null;
    if (properties) {
      properties[BUILDING_HIDE_BASE_WHEN_PARTS_PROPERTY] = 0;
    }
    const featureKind = String(properties?.feature_kind || '').trim().toLowerCase();
    const polygonGeometry = normalizePolygonGeometry(feature?.geometry || null);
    const bounds = getGeometryBounds(polygonGeometry || feature?.geometry || null);
    if (featureKind === 'building_part') {
      if (bounds && polygonGeometry) {
        parts.push({
          bounds,
          geometry: polygonGeometry
        });
      }
      continue;
    }
    if (featureKind === 'building' && polygonGeometry) {
      buildings.push({
        feature,
        bounds,
        geometry: polygonGeometry
      } as { feature: OverpassFeatureLike; bounds: GeometryBounds | null; geometry: GeoJSONLike });
      continue;
    }
    buildings.push({ feature, bounds });
  }

  if (parts.length === 0) return normalizedFeatures;

  for (const building of buildings) {
    const properties = building.feature?.properties && typeof building.feature.properties === 'object'
      ? building.feature.properties
      : null;
    if (!properties || !building.bounds) continue;
    const containedParts = parts.filter((part) => boundsContainBounds(building.bounds, part.bounds));
    if (containedParts.length === 0) continue;
    const remainder = buildDifferenceGeometry(
      building.feature?.geometry || null,
      containedParts.map((part) => part.geometry)
    );
    if (!remainder.ok) continue;
    properties[BUILDING_HIDE_BASE_WHEN_PARTS_PROPERTY] = 1;
    if (!remainder.geometry) continue;
    syntheticRemainders.push({
      type: 'Feature',
      ...(building.feature || {}),
      geometry: remainder.geometry,
      properties: {
        ...properties,
        feature_kind: 'building_remainder',
        [BUILDING_HIDE_BASE_WHEN_PARTS_PROPERTY]: 0
      }
    });
  }

  return syntheticRemainders.length > 0
    ? [...syntheticRemainders, ...normalizedFeatures]
    : normalizedFeatures;
}

export function encodeOverpassFeatureId(feature: OverpassFeatureLike) {
  const payload = buildOverpassFeaturePayload(feature);
  if (!payload) return null;
  return encodeOsmFeatureId(payload.osmType, payload.osmId);
}
