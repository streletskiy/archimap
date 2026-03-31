const { getFeatureKindFromTagsJson } = require('../utils/building-feature-kind');
const { createBuildingsRepository } = require('../services/buildings.repository');

function createFeatureInfoSupport(options: LooseRecord = {}) {
  const {
    db,
    mergePersonalEditsIntoFeatureInfo,
    buildingsRepository: providedBuildingsRepository
  } = options;

  if (!db && !providedBuildingsRepository) {
    throw new Error('createFeatureInfoSupport: db is required');
  }

  const buildingsRepository = providedBuildingsRepository || createBuildingsRepository({ db });

  function rowToFeature(row) {
    let ring = [];
    let geometry = null;
    let tags: LooseRecord;
    try {
      const geometryJson = row?.geometry_json ?? row?.source_geometry_json ?? null;
      const parsed = JSON.parse(geometryJson);
      if (parsed && typeof parsed === 'object' && parsed.type && Array.isArray(parsed.coordinates)) {
        geometry = parsed;
      } else if (Array.isArray(parsed)) {
        ring = parsed;
        geometry = { type: 'Polygon', coordinates: [ring] };
      }
    } catch {
      ring = [];
      geometry = { type: 'Polygon', coordinates: [ring] };
    }
    try {
      const tagsJson = row?.tags_json ?? row?.source_tags_json ?? null;
      tags = tagsJson ? JSON.parse(tagsJson) : {};
    } catch {
      tags = {};
    }
    const featureKind = getFeatureKindFromTagsJson(row?.tags_json ?? row?.source_tags_json ?? null);
    const sourceOsmUpdatedAt = row?.source_osm_updated_at ?? (row?.geometry_json != null ? row?.updated_at ?? null : null);

    return {
      type: 'Feature',
      id: `${row.osm_type}/${row.osm_id}`,
      properties: {
        ...tags,
        osm_type: row.osm_type,
        osm_id: row.osm_id,
        osm_key: `${row.osm_type}/${row.osm_id}`,
        feature_kind: featureKind,
        source_tags: tags,
        source_osm_updated_at: sourceOsmUpdatedAt
      },
      geometry: geometry || { type: 'Polygon', coordinates: [ring] }
    };
  }

  async function attachInfoToFeatures(features, options: LooseRecord = {}) {
    const keys = features
      .map((feature) => String(feature.id || ''))
      .filter((id) => /^(way|relation)\/\d+$/.test(id));

    if (keys.length === 0) return features;

    const infoByKey = new Map();
    const rows = await buildingsRepository.getLocalArchitecturalInfoRowsByKeys(keys);
    for (const row of rows) {
      infoByKey.set(`${row.osm_type}/${row.osm_id}`, row);
    }

    for (const feature of features) {
      const key = String(feature.id || '');
      feature.properties = feature.properties || {};
      if (!feature.properties.source_tags || typeof feature.properties.source_tags !== 'object') {
        const clone = { ...feature.properties };
        delete clone.osm_key;
        delete clone.archiInfo;
        delete clone.hasExtraInfo;
        feature.properties.source_tags = clone;
      }
      feature.properties.osm_key = key;
      feature.properties.archiInfo = infoByKey.get(key) || null;
      feature.properties.hasExtraInfo = infoByKey.has(key);
    }

    const actorKey = String(options.actorKey || '').trim().toLowerCase();
    if (actorKey && typeof mergePersonalEditsIntoFeatureInfo === 'function') {
      await mergePersonalEditsIntoFeatureInfo(features, actorKey);
    }

    return features;
  }

  return {
    rowToFeature,
    attachInfoToFeatures
  };
}

module.exports = {
  createFeatureInfoSupport
};
