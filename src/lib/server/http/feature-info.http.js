const { getFeatureKindFromTagsJson } = require('../utils/building-feature-kind');

function createFeatureInfoSupport(options = {}) {
  const {
    db,
    mergePersonalEditsIntoFeatureInfo
  } = options;

  if (!db) {
    throw new Error('createFeatureInfoSupport: db is required');
  }

  function rowToFeature(row) {
    let ring = [];
    let geometry = null;
    let tags = {};
    try {
      const parsed = JSON.parse(row.geometry_json);
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
      tags = row.tags_json ? JSON.parse(row.tags_json) : {};
    } catch {
      tags = {};
    }
    const featureKind = getFeatureKindFromTagsJson(row.tags_json);

    return {
      type: 'Feature',
      id: `${row.osm_type}/${row.osm_id}`,
      properties: {
        ...tags,
        osm_type: row.osm_type,
        osm_id: row.osm_id,
        osm_key: `${row.osm_type}/${row.osm_id}`,
        feature_kind: featureKind,
        source_tags: tags
      },
      geometry: geometry || { type: 'Polygon', coordinates: [ring] }
    };
  }

  async function attachInfoToFeatures(features, options = {}) {
    const keys = features
      .map((feature) => String(feature.id || ''))
      .filter((id) => /^(way|relation)\/\d+$/.test(id));

    if (keys.length === 0) return features;

    const infoByKey = new Map();
    const chunkSize = 300;
    for (let index = 0; index < keys.length; index += chunkSize) {
      const chunk = keys.slice(index, index + chunkSize);
      const clauses = chunk.map(() => '(osm_type = ? AND osm_id = ?)').join(' OR ');
      const params = [];
      for (const key of chunk) {
        const [type, id] = key.split('/');
        params.push(type, Number(id));
      }
      const rows = await db.prepare(`
        SELECT osm_type, osm_id, name, style, material, material_concrete, colour, levels, year_built, architect, address, description, archimap_description, updated_by, updated_at
        FROM local.architectural_info
        WHERE ${clauses}
      `).all(...params);
      for (const row of rows) {
        infoByKey.set(`${row.osm_type}/${row.osm_id}`, row);
      }
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
