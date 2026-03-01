function createBuildingEditsService({ db, normalizeUserEditStatus }) {
  function normalizeInfoForDiff(value) {
    if (value == null) return null;
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    const text = String(value).trim();
    return text ? text : null;
  }

  const ARCHI_EDIT_FIELDS = Object.freeze([
    { key: 'name', label: 'Название', osmTag: 'name | name:ru | official_name' },
    { key: 'address', label: 'Адрес', osmTag: 'addr:full | addr:* (city/street/housenumber/postcode)' },
    { key: 'levels', label: 'Этажей', osmTag: 'building:levels | levels' },
    { key: 'year_built', label: 'Год постройки', osmTag: 'building:year | start_date | construction_date | year_built' },
    { key: 'architect', label: 'Архитектор', osmTag: 'architect | architect_name' },
    { key: 'style', label: 'Архитектурный стиль', osmTag: 'building:architecture | architecture | style' },
    { key: 'archimap_description', label: 'Доп. информация', osmTag: null }
  ]);

  const ARCHI_FIELD_SET = new Set(ARCHI_EDIT_FIELDS.map((f) => f.key));

  function getMergedInfoRow(osmType, osmId) {
    return db.prepare(`
      SELECT osm_type, osm_id, name, style, levels, year_built, architect, address, description, archimap_description, updated_by, updated_at
      FROM local.architectural_info
      WHERE osm_type = ? AND osm_id = ?
    `).get(osmType, osmId) || null;
  }

  function getLatestUserEditRow(osmType, osmId, createdBy, statuses = null) {
    const author = String(createdBy || '').trim().toLowerCase();
    if (!author) return null;

    const normalizedStatuses = Array.isArray(statuses)
      ? statuses.map(normalizeUserEditStatus).filter(Boolean)
      : null;

    const statusClause = normalizedStatuses && normalizedStatuses.length > 0
      ? ` AND status IN (${normalizedStatuses.map(() => '?').join(',')})`
      : '';

    const params = [osmType, osmId, author];
    if (statusClause) params.push(...normalizedStatuses);

    return db.prepare(`
      SELECT *
      FROM user_edits.building_user_edits
      WHERE osm_type = ?
        AND osm_id = ?
        AND lower(trim(created_by)) = ?
        ${statusClause}
      ORDER BY id DESC
      LIMIT 1
    `).get(...params) || null;
  }

  function supersedePendingUserEdits(osmType, osmId, createdBy, keepId = null) {
    const author = String(createdBy || '').trim().toLowerCase();
    if (!author) return;

    if (Number.isInteger(keepId) && keepId > 0) {
      db.prepare(`
        UPDATE user_edits.building_user_edits
        SET status = 'superseded', updated_at = datetime('now')
        WHERE osm_type = ?
          AND osm_id = ?
          AND lower(trim(created_by)) = ?
          AND status = 'pending'
          AND id <> ?
      `).run(osmType, osmId, author, keepId);
      return;
    }

    db.prepare(`
      UPDATE user_edits.building_user_edits
      SET status = 'superseded', updated_at = datetime('now')
      WHERE osm_type = ?
        AND osm_id = ?
        AND lower(trim(created_by)) = ?
        AND status = 'pending'
    `).run(osmType, osmId, author);
  }

  function buildChangesFromRows(editRow, tags, mergedRow = null) {
    const baseline = mergedRow
      ? {
        name: mergedRow.name ?? null,
        style: mergedRow.style ?? null,
        levels: mergedRow.levels ?? null,
        year_built: mergedRow.year_built ?? null,
        architect: mergedRow.architect ?? null,
        address: mergedRow.address ?? null,
        archimap_description: mergedRow.archimap_description ?? mergedRow.description ?? null
      }
      : {
        name: tags.name ?? tags['name:ru'] ?? tags.official_name ?? null,
        style: tags['building:architecture'] ?? tags.architecture ?? tags.style ?? null,
        levels: tags['building:levels'] ?? tags.levels ?? null,
        year_built: tags['building:year'] ?? tags.start_date ?? tags.construction_date ?? tags.year_built ?? null,
        architect: tags.architect ?? tags.architect_name ?? null,
        address: tags['addr:full'] ?? null,
        archimap_description: null
      };

    const changes = [];
    for (const field of ARCHI_EDIT_FIELDS) {
      const baselineValue = normalizeInfoForDiff(baseline[field.key]);
      const localValue = normalizeInfoForDiff(editRow[field.key]);
      const differs = baselineValue !== localValue;
      if (!differs) continue;
      changes.push({
        field: field.key,
        label: field.label,
        osmTag: field.osmTag,
        osmValue: baselineValue,
        localValue
      });
    }
    return changes;
  }

  function parseTagsJsonSafe(raw) {
    if (!raw) return {};
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }

  function getSessionEditActorKey(req) {
    const email = String(req?.session?.user?.email || '').trim().toLowerCase();
    if (email) return email;
    const username = String(req?.session?.user?.username || '').trim().toLowerCase();
    return username || null;
  }

  function mapUserEditRow(row, tags, mergedInfoRow) {
    const changes = buildChangesFromRows(row, tags, mergedInfoRow);
    const mergedFields = row.merged_fields_json
      ? (() => {
        try {
          const parsed = JSON.parse(row.merged_fields_json);
          if (Array.isArray(parsed)) return parsed.map((value) => String(value || '')).filter(Boolean);
          return null;
        } catch {
          return null;
        }
      })()
      : null;

    return {
      editId: Number(row.id || 0),
      osmType: row.osm_type,
      osmId: row.osm_id,
      updatedBy: row.created_by,
      updatedAt: row.updated_at,
      createdAt: row.created_at,
      status: normalizeUserEditStatus(row.status),
      adminComment: row.admin_comment ?? null,
      reviewedBy: row.reviewed_by ?? null,
      reviewedAt: row.reviewed_at ?? null,
      mergedBy: row.merged_by ?? null,
      mergedAt: row.merged_at ?? null,
      mergedFields,
      values: {
        name: row.name ?? null,
        style: row.style ?? null,
        levels: row.levels ?? null,
        year_built: row.year_built ?? null,
        architect: row.architect ?? null,
        address: row.address ?? null,
        archimap_description: row.archimap_description ?? null
      },
      changes
    };
  }

  function getUserEditsList({ createdBy = null, status = null, limit = 2000 }) {
    const cap = Math.max(1, Math.min(5000, Number(limit) || 2000));
    const clauses = [];
    const params = [];

    const author = String(createdBy || '').trim().toLowerCase();
    if (author) {
      clauses.push('lower(trim(ue.created_by)) = ?');
      params.push(author);
    }

    if (status) {
      clauses.push('ue.status = ?');
      params.push(normalizeUserEditStatus(status));
    }

    const whereSql = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';

    const rows = db.prepare(`
      SELECT
        ue.*,
        bc.tags_json,
        ai.name AS merged_name,
        ai.style AS merged_style,
        ai.levels AS merged_levels,
        ai.year_built AS merged_year_built,
        ai.architect AS merged_architect,
        ai.address AS merged_address,
        ai.description AS merged_description,
        ai.archimap_description AS merged_archimap_description,
        ai.updated_by AS merged_updated_by,
        ai.updated_at AS merged_updated_at
      FROM user_edits.building_user_edits ue
      LEFT JOIN osm.building_contours bc
        ON bc.osm_type = ue.osm_type AND bc.osm_id = ue.osm_id
      LEFT JOIN local.architectural_info ai
        ON ai.osm_type = ue.osm_type AND ai.osm_id = ue.osm_id
      ${whereSql}
      ORDER BY ue.updated_at DESC, ue.id DESC
      LIMIT ?
    `).all(...params, cap);

    const out = [];
    for (const row of rows) {
      const tags = parseTagsJsonSafe(row.tags_json);
      const mergedInfoRow = row.merged_name != null || row.merged_style != null || row.merged_levels != null || row.merged_year_built != null || row.merged_architect != null || row.merged_address != null || row.merged_description != null || row.merged_archimap_description != null
        ? {
          name: row.merged_name,
          style: row.merged_style,
          levels: row.merged_levels,
          year_built: row.merged_year_built,
          architect: row.merged_architect,
          address: row.merged_address,
          description: row.merged_description,
          archimap_description: row.merged_archimap_description,
          updated_by: row.merged_updated_by,
          updated_at: row.merged_updated_at
        }
        : null;

      out.push(mapUserEditRow(row, tags, mergedInfoRow));
    }
    return out;
  }

  function getUserEditDetailsById(editId) {
    const id = Number(editId);
    if (!Number.isInteger(id) || id <= 0) return null;

    const row = db.prepare(`
      SELECT
        ue.*,
        bc.tags_json,
        ai.name AS merged_name,
        ai.style AS merged_style,
        ai.levels AS merged_levels,
        ai.year_built AS merged_year_built,
        ai.architect AS merged_architect,
        ai.address AS merged_address,
        ai.description AS merged_description,
        ai.archimap_description AS merged_archimap_description,
        ai.updated_by AS merged_updated_by,
        ai.updated_at AS merged_updated_at
      FROM user_edits.building_user_edits ue
      LEFT JOIN osm.building_contours bc
        ON bc.osm_type = ue.osm_type AND bc.osm_id = ue.osm_id
      LEFT JOIN local.architectural_info ai
        ON ai.osm_type = ue.osm_type AND ai.osm_id = ue.osm_id
      WHERE ue.id = ?
      LIMIT 1
    `).get(id);

    if (!row) return null;

    const tags = parseTagsJsonSafe(row.tags_json);
    const mergedInfoRow = row.merged_name != null || row.merged_style != null || row.merged_levels != null || row.merged_year_built != null || row.merged_architect != null || row.merged_address != null || row.merged_description != null || row.merged_archimap_description != null
      ? {
        name: row.merged_name,
        style: row.merged_style,
        levels: row.merged_levels,
        year_built: row.merged_year_built,
        architect: row.merged_architect,
        address: row.merged_address,
        description: row.merged_description,
        archimap_description: row.merged_archimap_description,
        updated_by: row.merged_updated_by,
        updated_at: row.merged_updated_at
      }
      : null;

    const mapped = mapUserEditRow(row, tags, mergedInfoRow);
    mapped.tags = tags;
    mapped.latestMerged = mergedInfoRow
      ? {
        name: mergedInfoRow.name ?? null,
        style: mergedInfoRow.style ?? null,
        levels: mergedInfoRow.levels ?? null,
        year_built: mergedInfoRow.year_built ?? null,
        architect: mergedInfoRow.architect ?? null,
        address: mergedInfoRow.address ?? null,
        description: mergedInfoRow.description ?? null,
        archimap_description: mergedInfoRow.archimap_description ?? mergedInfoRow.description ?? null,
        updated_by: mergedInfoRow.updated_by ?? null,
        updated_at: mergedInfoRow.updated_at ?? null
      }
      : null;
    return mapped;
  }

  function getUserPersonalEditsByKeys(actorKey, keys, statuses = ['pending', 'rejected']) {
    const actor = String(actorKey || '').trim().toLowerCase();
    if (!actor || !Array.isArray(keys) || keys.length === 0) return new Map();

    const normalizedStatuses = statuses
      .map(normalizeUserEditStatus)
      .filter(Boolean);

    if (normalizedStatuses.length === 0) return new Map();

    const out = new Map();
    const CHUNK_SIZE = 300;

    for (let i = 0; i < keys.length; i += CHUNK_SIZE) {
      const chunk = keys.slice(i, i + CHUNK_SIZE);
      const clauses = chunk.map(() => '(osm_type = ? AND osm_id = ?)').join(' OR ');
      const params = [actor];
      for (const key of chunk) {
        const [osmType, osmIdRaw] = String(key).split('/');
        const osmId = Number(osmIdRaw);
        if (!['way', 'relation'].includes(osmType) || !Number.isInteger(osmId)) continue;
        params.push(osmType, osmId);
      }
      if (params.length === 1) continue;

      const statusPlaceholders = normalizedStatuses.map(() => '?').join(',');
      params.push(...normalizedStatuses);

      const rows = db.prepare(`
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

      for (const row of rows) {
        out.set(`${row.osm_type}/${row.osm_id}`, row);
      }
    }
    return out;
  }

  function mergePersonalEditsIntoFeatureInfo(features, actorKey) {
    const keys = features
      .map((f) => String(f?.id || f?.properties?.osm_key || ''))
      .filter((id) => /^(way|relation)\/\d+$/.test(id));
    if (keys.length === 0) return features;

    const personalByKey = getUserPersonalEditsByKeys(actorKey, keys, ['pending', 'rejected']);
    if (personalByKey.size === 0) return features;

    for (const feature of features) {
      const key = String(feature?.id || feature?.properties?.osm_key || '');
      const row = personalByKey.get(key);
      if (!row) continue;
      feature.properties = feature.properties || {};
      feature.properties.archiInfo = {
        osm_type: row.osm_type,
        osm_id: row.osm_id,
        name: row.name ?? null,
        style: row.style ?? null,
        levels: row.levels ?? null,
        year_built: row.year_built ?? null,
        architect: row.architect ?? null,
        address: row.address ?? null,
        archimap_description: row.archimap_description ?? null,
        updated_by: row.created_by ?? null,
        updated_at: row.updated_at ?? null,
        review_status: normalizeUserEditStatus(row.status),
        admin_comment: row.admin_comment ?? null,
        user_edit_id: Number(row.id || 0)
      };
      feature.properties.hasExtraInfo = true;
    }

    return features;
  }

  function applyPersonalEditsToFilterItems(items, actorKey) {
    const actor = String(actorKey || '').trim().toLowerCase();
    if (!actor || !Array.isArray(items) || items.length === 0) return items;

    const keys = items.map((item) => String(item?.osmKey || '')).filter((id) => /^(way|relation)\/\d+$/.test(id));
    const personalByKey = getUserPersonalEditsByKeys(actor, keys, ['pending', 'rejected']);
    if (personalByKey.size === 0) return items;

    return items.map((item) => {
      const key = String(item?.osmKey || '');
      const row = personalByKey.get(key);
      if (!row) return item;
      return {
        ...item,
        archiInfo: {
          osm_type: row.osm_type,
          osm_id: row.osm_id,
          name: row.name ?? null,
          style: row.style ?? null,
          levels: row.levels ?? null,
          year_built: row.year_built ?? null,
          architect: row.architect ?? null,
          address: row.address ?? null,
          archimap_description: row.archimap_description ?? null,
          updated_by: row.created_by ?? null,
          updated_at: row.updated_at ?? null,
          review_status: normalizeUserEditStatus(row.status),
          admin_comment: row.admin_comment ?? null,
          user_edit_id: Number(row.id || 0)
        },
        hasExtraInfo: true
      };
    });
  }

  return {
    ARCHI_EDIT_FIELDS,
    ARCHI_FIELD_SET,
    getMergedInfoRow,
    getLatestUserEditRow,
    supersedePendingUserEdits,
    getSessionEditActorKey,
    getUserEditsList,
    getUserEditDetailsById,
    getUserPersonalEditsByKeys,
    mergePersonalEditsIntoFeatureInfo,
    applyPersonalEditsToFilterItems
  };
}

module.exports = {
  createBuildingEditsService
};
