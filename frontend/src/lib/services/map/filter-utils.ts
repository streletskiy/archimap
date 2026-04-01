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
    buildingExtrusionLayerIds: Array.isArray(source.buildingExtrusionLayerIds) ? source.buildingExtrusionLayerIds : [],
    buildingLineLayerIds: Array.isArray(source.buildingLineLayerIds) ? source.buildingLineLayerIds : [],
    buildingPartFillLayerIds: Array.isArray(source.buildingPartFillLayerIds) ? source.buildingPartFillLayerIds : [],
    buildingPartExtrusionLayerIds: Array.isArray(source.buildingPartExtrusionLayerIds) ? source.buildingPartExtrusionLayerIds : [],
    buildingPartLineLayerIds: Array.isArray(source.buildingPartLineLayerIds) ? source.buildingPartLineLayerIds : [],
    filterHighlightExtrusionLayerIds: Array.isArray(source.filterHighlightExtrusionLayerIds) ? source.filterHighlightExtrusionLayerIds : [],
    filterHighlightFillLayerIds: Array.isArray(source.filterHighlightFillLayerIds) ? source.filterHighlightFillLayerIds : [],
    filterHighlightLineLayerIds: Array.isArray(source.filterHighlightLineLayerIds) ? source.filterHighlightLineLayerIds : [],
    buildingPartFilterHighlightExtrusionLayerIds: Array.isArray(source.buildingPartFilterHighlightExtrusionLayerIds)
      ? source.buildingPartFilterHighlightExtrusionLayerIds
      : [],
    buildingPartFilterHighlightFillLayerIds: Array.isArray(source.buildingPartFilterHighlightFillLayerIds) ? source.buildingPartFilterHighlightFillLayerIds : [],
    buildingPartFilterHighlightLineLayerIds: Array.isArray(source.buildingPartFilterHighlightLineLayerIds) ? source.buildingPartFilterHighlightLineLayerIds : [],
    hoverExtrusionLayerIds: Array.isArray(source.hoverExtrusionLayerIds) ? source.hoverExtrusionLayerIds : [],
    hoverFillLayerIds: Array.isArray(source.hoverFillLayerIds) ? source.hoverFillLayerIds : [],
    hoverLineLayerIds: Array.isArray(source.hoverLineLayerIds) ? source.hoverLineLayerIds : [],
    selectedExtrusionLayerIds: Array.isArray(source.selectedExtrusionLayerIds) ? source.selectedExtrusionLayerIds : [],
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
