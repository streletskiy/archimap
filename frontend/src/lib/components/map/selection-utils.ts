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

export function decodeOsmFeatureId(featureId) {
  const n = Number(featureId);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) return null;
  const osmType = (n % 2) === 1 ? 'relation' : 'way';
  const osmId = Math.floor(n / 2);
  if (!Number.isInteger(osmId) || osmId <= 0) return null;
  return { osmType, osmId };
}

export function encodeOsmFeatureId(osmType, osmId) {
  const typeBit = osmType === 'relation' ? 1 : 0;
  return (Number(osmId) * 2) + typeBit;
}

export function getFeatureIdentity(feature) {
  const fromOsmKey = parseOsmKey(feature?.properties?.osm_key);
  if (fromOsmKey) return fromOsmKey;

  const osmType = String(feature?.properties?.osm_type || '').trim();
  const osmId = Number(feature?.properties?.osm_id);
  if (['way', 'relation'].includes(osmType) && Number.isInteger(osmId) && osmId > 0) {
    return { osmType, osmId };
  }

  const geometryType = String(feature?.geometry?.type || '').trim();
  if (Number.isInteger(osmId) && osmId > 0 && geometryType === 'MultiPolygon') {
    return { osmType: 'relation', osmId };
  }

  const fromEncodedId = decodeOsmFeatureId(feature?.id);
  if (fromEncodedId) return fromEncodedId;
  return null;
}

export function getSelectionFilter(feature, identity) {
  if (identity?.osmType && Number.isInteger(identity?.osmId)) {
    const encodedId = encodeOsmFeatureId(identity.osmType, identity.osmId);
    if (Number.isInteger(encodedId) && encodedId > 0) {
      return ['==', ['id'], encodedId];
    }
  }
  const byFeatureId = feature?.id;
  if (byFeatureId != null) {
    return ['==', ['id'], byFeatureId];
  }
  if (identity?.osmType && Number.isInteger(identity?.osmId)) {
    return ['all',
      ['==', ['get', 'osm_type'], identity.osmType],
      ['==', ['to-number', ['get', 'osm_id']], identity.osmId]
    ];
  }
  return ['==', ['id'], -1];
}
