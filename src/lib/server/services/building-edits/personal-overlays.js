function createBuildingEditPersonalOverlaysService(context) {
  const {
    applyUserEditRowToInfo,
    db,
    isPostgres,
    normalizeUserEditStatus
  } = context;

  async function getUserPersonalEditsByKeys(actorKey, keys, statuses = ['pending', 'rejected']) {
    const actor = String(actorKey || '').trim().toLowerCase();
    if (!actor || !Array.isArray(keys) || keys.length === 0) return new Map();

    const normalizedStatuses = statuses
      .map(normalizeUserEditStatus)
      .filter(Boolean);

    if (normalizedStatuses.length === 0) return new Map();

    const out = new Map();
    const CHUNK_SIZE = 300;

    for (let index = 0; index < keys.length; index += CHUNK_SIZE) {
      const chunk = keys.slice(index, index + CHUNK_SIZE);
      const pairs = [];

      for (const key of chunk) {
        const [osmType, osmIdRaw] = String(key).split('/');
        const osmId = Number(osmIdRaw);
        if (!['way', 'relation'].includes(osmType) || !Number.isInteger(osmId)) continue;
        pairs.push({ osmType, osmId });
      }
      if (pairs.length === 0) continue;

      const statusPlaceholders = normalizedStatuses.map(() => '?').join(',');

      const rows = isPostgres
        ? await (() => {
          const valuesSql = pairs.map(() => '(?::text, ?::bigint)').join(', ');
          const params = [];
          for (const pair of pairs) {
            params.push(pair.osmType, pair.osmId);
          }
          params.push(actor, ...normalizedStatuses);

          return db.prepare(`
            WITH requested(osm_type, osm_id) AS (
              VALUES ${valuesSql}
            ),
            latest AS (
              SELECT ue.osm_type, ue.osm_id, MAX(ue.id) AS max_id
              FROM user_edits.building_user_edits ue
              JOIN requested req
                ON req.osm_type = ue.osm_type AND req.osm_id = ue.osm_id
              WHERE lower(trim(ue.created_by)) = ?
                AND ue.status IN (${statusPlaceholders})
              GROUP BY ue.osm_type, ue.osm_id
            )
            SELECT ue.*
            FROM user_edits.building_user_edits ue
            JOIN latest
              ON latest.max_id = ue.id
          `).all(...params);
        })()
        : await (() => {
          const clauses = pairs.map(() => '(osm_type = ? AND osm_id = ?)').join(' OR ');
          const params = [actor];
          for (const pair of pairs) {
            params.push(pair.osmType, pair.osmId);
          }
          params.push(...normalizedStatuses);

          return db.prepare(`
            SELECT ue.*
            FROM user_edits.building_user_edits ue
            JOIN (
              SELECT osm_type, osm_id, MAX(id) AS max_id
              FROM user_edits.building_user_edits
              WHERE lower(trim(created_by)) = ?
                AND (${clauses})
                AND status IN (${statusPlaceholders})
              GROUP BY osm_type, osm_id
            ) latest
              ON latest.max_id = ue.id
          `).all(...params);
        })();

      for (const row of rows) {
        out.set(`${row.osm_type}/${row.osm_id}`, row);
      }
    }
    return out;
  }

  async function mergePersonalEditsIntoFeatureInfo(features, actorKey) {
    const keys = features
      .map((feature) => String(feature?.id || feature?.properties?.osm_key || ''))
      .filter((id) => /^(way|relation)\/\d+$/.test(id));
    if (keys.length === 0) return features;

    const personalByKey = await getUserPersonalEditsByKeys(actorKey, keys, ['pending', 'rejected']);
    if (personalByKey.size === 0) return features;

    for (const feature of features) {
      const key = String(feature?.id || feature?.properties?.osm_key || '');
      const row = personalByKey.get(key);
      if (!row) continue;
      feature.properties = feature.properties || {};
      feature.properties.archiInfo = applyUserEditRowToInfo(feature.properties.archiInfo, row);
      feature.properties.hasExtraInfo = true;
    }

    return features;
  }

  async function applyPersonalEditsToFilterItems(items, actorKey) {
    const actor = String(actorKey || '').trim().toLowerCase();
    if (!actor || !Array.isArray(items) || items.length === 0) return items;

    const keys = items.map((item) => String(item?.osmKey || '')).filter((id) => /^(way|relation)\/\d+$/.test(id));
    const personalByKey = await getUserPersonalEditsByKeys(actor, keys, ['pending', 'rejected']);
    if (personalByKey.size === 0) return items;

    return items.map((item) => {
      const key = String(item?.osmKey || '');
      const row = personalByKey.get(key);
      if (!row) return item;
      return {
        ...item,
        archiInfo: applyUserEditRowToInfo(item.archiInfo, row),
        hasExtraInfo: true
      };
    });
  }

  return {
    applyPersonalEditsToFilterItems,
    getUserPersonalEditsByKeys,
    mergePersonalEditsIntoFeatureInfo
  };
}

module.exports = {
  createBuildingEditPersonalOverlaysService
};
