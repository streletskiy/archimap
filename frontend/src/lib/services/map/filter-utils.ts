import type {
  FeatureIdentitySource,
  LayerIdsSnapshot
} from './filter-types.js';

export function parseOsmKey(raw) {
  const text = String(raw || '').trim();
  if (!text || !text.includes('/')) return null;
  const [osmType, osmIdRaw] = text.split('/');
  const osmId = Number(osmIdRaw);
  if (!['way', 'relation'].includes(osmType) || !Number.isInteger(osmId) || osmId <= 0) {
    return null;
  }
  return { osmType, osmId };
}

export function encodeOsmFeatureId(osmType, osmId) {
  const typeBit = osmType === 'relation' ? 1 : 0;
  return (Number(osmId) * 2) + typeBit;
}

export function getNow() {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

export function nextAnimationFrame() {
  if (typeof window === 'undefined' || typeof window.requestAnimationFrame !== 'function') {
    return new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  return new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
}

export function normalizeLayerIdsSnapshot(layerIds: Partial<LayerIdsSnapshot> | null | undefined = {}): LayerIdsSnapshot {
  const source = layerIds && typeof layerIds === 'object' ? layerIds : {};
  return {
    buildingFillLayerIds: Array.isArray(source.buildingFillLayerIds) ? source.buildingFillLayerIds : [],
    buildingLineLayerIds: Array.isArray(source.buildingLineLayerIds) ? source.buildingLineLayerIds : [],
    buildingPartFillLayerIds: Array.isArray(source.buildingPartFillLayerIds) ? source.buildingPartFillLayerIds : [],
    buildingPartLineLayerIds: Array.isArray(source.buildingPartLineLayerIds) ? source.buildingPartLineLayerIds : [],
    filterHighlightFillLayerIds: Array.isArray(source.filterHighlightFillLayerIds) ? source.filterHighlightFillLayerIds : [],
    filterHighlightLineLayerIds: Array.isArray(source.filterHighlightLineLayerIds) ? source.filterHighlightLineLayerIds : [],
    buildingPartFilterHighlightFillLayerIds: Array.isArray(source.buildingPartFilterHighlightFillLayerIds) ? source.buildingPartFilterHighlightFillLayerIds : [],
    buildingPartFilterHighlightLineLayerIds: Array.isArray(source.buildingPartFilterHighlightLineLayerIds) ? source.buildingPartFilterHighlightLineLayerIds : [],
    selectedFillLayerIds: Array.isArray(source.selectedFillLayerIds) ? source.selectedFillLayerIds : [],
    selectedLineLayerIds: Array.isArray(source.selectedLineLayerIds) ? source.selectedLineLayerIds : []
  };
}

export function resolveFeatureIdentity(feature: FeatureIdentitySource) {
  const fromKey = parseOsmKey(feature?.properties?.osm_key);
  if (fromKey) return fromKey;
  const osmType = String(feature?.properties?.osm_type || '').trim();
  const osmId = Number(feature?.properties?.osm_id);
  if (['way', 'relation'].includes(osmType) && Number.isInteger(osmId) && osmId > 0) {
    return { osmType, osmId };
  }
  const geometryType = String(feature?.geometry?.type || '').trim();
  if (Number.isInteger(osmId) && osmId > 0 && geometryType === 'MultiPolygon') {
    return { osmType: 'relation', osmId };
  }
  const encodedId = Number(feature?.id);
  if (!Number.isFinite(encodedId) || !Number.isInteger(encodedId) || encodedId < 0) return null;
  const encodedType = (encodedId % 2) === 1 ? 'relation' : 'way';
  const encodedOsmId = Math.floor(encodedId / 2);
  if (!Number.isInteger(encodedOsmId) || encodedOsmId <= 0) return null;
  return { osmType: encodedType, osmId: encodedOsmId };
}
