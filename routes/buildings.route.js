function parseOsmKey(value) {
  const text = String(value || '').trim();
  const match = text.match(/^(way|relation)\/(\d+)$/);
  if (!match) return null;
  const osmId = Number(match[2]);
  if (!Number.isInteger(osmId)) return null;
  return { osmType: match[1], osmId };
}

function mapFilterDataRow(row) {
  const osmKey = `${row.osm_type}/${row.osm_id}`;
  let sourceTags = {};
  try {
    sourceTags = row.tags_json ? JSON.parse(row.tags_json) : {};
  } catch {
    sourceTags = {};
  }
  const hasExtraInfo = row.info_osm_id != null;
  return {
    osmKey,
    sourceTags,
    archiInfo: hasExtraInfo
      ? {
        osm_type: row.osm_type,
        osm_id: row.osm_id,
        name: row.name,
        style: row.style,
        levels: row.levels,
        year_built: row.year_built,
        architect: row.architect,
        address: row.address,
        description: row.description,
        archimap_description: row.archimap_description || row.description || null,
        updated_by: row.updated_by,
        updated_at: row.updated_at
      }
      : null,
    hasExtraInfo
  };
}

const FILTER_DATA_SELECT_FIELDS_SQL = `
  SELECT
    bc.osm_type,
    bc.osm_id,
    bc.tags_json,
    ai.osm_id AS info_osm_id,
    ai.name,
    ai.style,
    ai.levels,
    ai.year_built,
    ai.architect,
    ai.address,
    ai.description,
    ai.archimap_description,
    ai.updated_by,
    ai.updated_at
  FROM osm.building_contours bc
  LEFT JOIN local.architectural_info ai
    ON ai.osm_type = bc.osm_type AND ai.osm_id = bc.osm_id
`;

function registerBuildingsRoutes(deps) {
  const {
    app,
    db,
    rtreeState,
    filterDataRateLimiter,
    filterDataBboxRateLimiter,
    requireCsrfSession,
    requireAuth,
    requireBuildingEditPermission,
    getSessionEditActorKey,
    applyPersonalEditsToFilterItems,
    rowToFeature,
    attachInfoToFeatures,
    getMergedInfoRow,
    getLatestUserEditRow,
    normalizeUserEditStatus,
    sanitizeArchiPayload,
    supersedePendingUserEdits
  } = deps;

  app.post('/api/buildings/filter-data', filterDataRateLimiter, (req, res) => {
    const rawKeys = req.body?.keys;
    if (!Array.isArray(rawKeys)) {
      return res.status(400).json({ error: 'Ожидается массив keys' });
    }

    const unique = [];
    const seen = new Set();
    for (const raw of rawKeys) {
      const parsed = parseOsmKey(raw);
      if (!parsed) continue;
      const key = `${parsed.osmType}/${parsed.osmId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      unique.push(parsed);
      if (unique.length >= 5000) break;
    }

    if (unique.length === 0) {
      return res.json({ items: [] });
    }

    const outByKey = new Map();
    const CHUNK_SIZE = 300;
    for (let i = 0; i < unique.length; i += CHUNK_SIZE) {
      const chunk = unique.slice(i, i + CHUNK_SIZE);
      const clauses = chunk.map(() => '(bc.osm_type = ? AND bc.osm_id = ?)').join(' OR ');
      const params = [];
      for (const item of chunk) {
        params.push(item.osmType, item.osmId);
      }
      const rows = db.prepare(`
        ${FILTER_DATA_SELECT_FIELDS_SQL}
        WHERE ${clauses}
      `).all(...params);

      for (const row of rows) {
        const item = mapFilterDataRow(row);
        outByKey.set(item.osmKey, item);
      }
    }

    const actorKey = getSessionEditActorKey(req);
    const items = applyPersonalEditsToFilterItems([...outByKey.values()], actorKey);
    return res.json({ items });
  });

  app.get('/api/buildings/filter-data-bbox', filterDataBboxRateLimiter, (req, res) => {
    const minLon = Number(req.query.minLon);
    const minLat = Number(req.query.minLat);
    const maxLon = Number(req.query.maxLon);
    const maxLat = Number(req.query.maxLat);
    const limit = Math.max(1, Math.min(50000, Number(req.query.limit) || 12000));
    if (![minLon, minLat, maxLon, maxLat].every(Number.isFinite)) {
      return res.status(400).json({ error: 'Некорректные координаты bbox' });
    }
    if (minLon > maxLon || minLat > maxLat) {
      return res.status(400).json({ error: 'Некорректные границы bbox' });
    }

    const rows = rtreeState.ready
      ? db.prepare(`
        SELECT
          bc.osm_type,
          bc.osm_id,
          bc.tags_json,
          ai.osm_id AS info_osm_id,
          ai.name,
          ai.style,
          ai.levels,
          ai.year_built,
          ai.architect,
          ai.address,
          ai.description,
          ai.archimap_description,
          ai.updated_by,
          ai.updated_at
        FROM osm.building_contours_rtree br
        JOIN osm.building_contours bc
          ON bc.rowid = br.contour_rowid
        LEFT JOIN local.architectural_info ai
          ON ai.osm_type = bc.osm_type AND ai.osm_id = bc.osm_id
        WHERE br.max_lon >= ?
          AND br.min_lon <= ?
          AND br.max_lat >= ?
          AND br.min_lat <= ?
        LIMIT ?
      `).all(minLon, maxLon, minLat, maxLat, limit)
      : db.prepare(`
        ${FILTER_DATA_SELECT_FIELDS_SQL}
        WHERE bc.max_lon >= ?
          AND bc.min_lon <= ?
          AND bc.max_lat >= ?
          AND bc.min_lat <= ?
        LIMIT ?
      `).all(minLon, maxLon, minLat, maxLat, limit);

    const actorKey = getSessionEditActorKey(req);
    const items = applyPersonalEditsToFilterItems(rows.map(mapFilterDataRow), actorKey);
    res.setHeader('Cache-Control', 'public, max-age=60');
    return res.json({ items, truncated: rows.length >= limit });
  });

  app.get('/api/building-info/:osmType/:osmId', (req, res) => {
    const osmType = req.params.osmType;
    const osmId = Number(req.params.osmId);
    if (!['way', 'relation'].includes(osmType) || !Number.isInteger(osmId)) {
      return res.status(400).json({ error: 'Некорректный идентификатор здания' });
    }

    const merged = getMergedInfoRow(osmType, osmId);
    const actorKey = getSessionEditActorKey(req);
    const personal = actorKey ? getLatestUserEditRow(osmType, osmId, actorKey, ['pending', 'rejected']) : null;
    const row = personal || merged;
    if (!row) {
      return res.status(404).json({ error: 'Информация не найдена' });
    }

    return res.json({
      osm_type: osmType,
      osm_id: osmId,
      name: row.name ?? null,
      style: row.style ?? null,
      levels: row.levels ?? null,
      year_built: row.year_built ?? null,
      architect: row.architect ?? null,
      address: row.address ?? null,
      description: row.description ?? null,
      archimap_description: row.archimap_description ?? row.description ?? null,
      updated_by: row.created_by ?? row.updated_by ?? null,
      updated_at: row.updated_at ?? null,
      review_status: personal ? normalizeUserEditStatus(personal.status) : 'accepted',
      admin_comment: personal?.admin_comment ?? null,
      user_edit_id: personal ? Number(personal.id || 0) : null
    });
  });

  app.post('/api/building-info', requireCsrfSession, requireAuth, requireBuildingEditPermission, (req, res) => {
    const body = req.body || {};
    const osmType = body.osmType;
    const osmId = Number(body.osmId);

    if (!['way', 'relation'].includes(osmType) || !Number.isInteger(osmId)) {
      return res.status(400).json({ error: 'Некорректный идентификатор здания' });
    }

    const validated = sanitizeArchiPayload(body);
    if (validated.error) {
      return res.status(400).json({ error: validated.error });
    }
    const actorKey = getSessionEditActorKey(req);
    if (!actorKey) {
      return res.status(400).json({ error: 'Не удалось определить текущего пользователя' });
    }
    const payload = validated.value;

    const tx = db.transaction(() => {
      const latest = getLatestUserEditRow(osmType, osmId, actorKey, ['pending']);
      if (latest && Number.isInteger(Number(latest.id)) && Number(latest.id) > 0) {
        db.prepare(`
          UPDATE user_edits.building_user_edits
          SET
            name = @name,
            style = @style,
            levels = @levels,
            year_built = @year_built,
            architect = @architect,
            address = @address,
            archimap_description = @archimap_description,
            status = 'pending',
            admin_comment = NULL,
            reviewed_by = NULL,
            reviewed_at = NULL,
            merged_by = NULL,
            merged_at = NULL,
            merged_fields_json = NULL,
            updated_at = datetime('now')
          WHERE id = @id
        `).run({
          id: latest.id,
          ...payload
        });
        supersedePendingUserEdits(osmType, osmId, actorKey, Number(latest.id));
        return Number(latest.id || 0);
      }

      supersedePendingUserEdits(osmType, osmId, actorKey, null);
      const inserted = db.prepare(`
        INSERT INTO user_edits.building_user_edits (
          osm_type, osm_id, created_by,
          name, style, levels, year_built, architect, address, archimap_description,
          status, created_at, updated_at
        )
        VALUES (
          @osm_type, @osm_id, @created_by,
          @name, @style, @levels, @year_built, @architect, @address, @archimap_description,
          'pending', datetime('now'), datetime('now')
        )
      `).run({
        osm_type: osmType,
        osm_id: osmId,
        created_by: actorKey,
        ...payload
      });
      return Number(inserted?.lastInsertRowid || 0);
    });

    const editId = tx();
    return res.json({ ok: true, editId, status: 'pending' });
  });

  app.get('/api/building/:osmType/:osmId', (req, res) => {
    const osmType = req.params.osmType;
    const osmId = Number(req.params.osmId);
    if (!['way', 'relation'].includes(osmType) || !Number.isInteger(osmId)) {
      return res.status(400).json({ error: 'Некорректный идентификатор здания' });
    }

    const row = db.prepare(`
      SELECT osm_type, osm_id, tags_json, geometry_json
      FROM osm.building_contours
      WHERE osm_type = ? AND osm_id = ?
    `).get(osmType, osmId);

    if (!row) {
      return res.status(404).json({ error: 'Здание не найдено в локальной базе контуров' });
    }

    const feature = rowToFeature(row);
    attachInfoToFeatures([feature], { actorKey: getSessionEditActorKey(req) });
    return res.json(feature);
  });
}

module.exports = {
  registerBuildingsRoutes
};
