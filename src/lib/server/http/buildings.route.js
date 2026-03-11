const { sendCachedJson } = require('../infra/http-cache.infra');
const {
  buildFilterMatchBatchResults,
  createBuildingFiltersService
} = require('../services/building-filters.service');
const {
  compilePostgresFilterRuleGuardPredicate,
  compilePostgresFilterRulePredicate,
  compilePostgresFilterRulesGuardPredicate,
  compilePostgresFilterRulesPredicate
} = require('../utils/filter-sql-builder');

function registerBuildingsRoutes(deps) {
  const {
    app,
    db,
    rtreeState,
    buildingsReadRateLimiter,
    buildingsWriteRateLimiter,
    filterDataRateLimiter,
    filterDataBboxRateLimiter,
    filterMatchesRateLimiter,
    requireCsrfSession,
    requireAuth,
    requireBuildingEditPermission,
    getSessionEditActorKey,
    applyPersonalEditsToFilterItems,
    isFilterTagAllowed,
    rowToFeature,
    attachInfoToFeatures,
    applyUserEditRowToInfo,
    getMergedInfoRow,
    getOsmContourRow,
    getLatestUserEditRow,
    normalizeUserEditStatus,
    sanitizeArchiPayload,
    sanitizeEditedFields,
    supersedePendingUserEdits
  } = deps;
  const isPostgres = db.provider === 'postgres';
  const filtersService = createBuildingFiltersService({
    db,
    rtreeState,
    isFilterTagAllowed,
    applyPersonalEditsToFilterItems
  });

  const selectBuildingById = db.prepare(isPostgres
    ? `
      SELECT
        osm_type,
        osm_id,
        tags_json,
        ST_AsGeoJSON(geom)::text AS geometry_json
      FROM osm.building_contours
      WHERE osm_type = ? AND osm_id = ?
    `
    : `
      SELECT osm_type, osm_id, tags_json, geometry_json
      FROM osm.building_contours
      WHERE osm_type = ? AND osm_id = ?
    `);

  app.post('/api/buildings/filter-data', filterDataRateLimiter, async (req, res) => {
    const result = await filtersService.getFilterDataByKeys(req.body?.keys, getSessionEditActorKey(req));
    if (result.error) {
      return res.status(result.status || 400).json({ error: result.error });
    }
    return res.json({ items: result.items || [] });
  });

  app.get('/api/buildings/filter-data-bbox', filterDataBboxRateLimiter, async (req, res) => {
    const result = await filtersService.getFilterDataByBbox(req.query, getSessionEditActorKey(req));
    if (result.error) {
      return res.status(result.status || 400).json({ error: result.error });
    }
    return sendCachedJson(req, res, result.payload || { items: [], truncated: false }, {
      cacheControl: 'public, max-age=10'
    });
  });

  app.post('/api/buildings/filter-matches-batch', filterMatchesRateLimiter, async (req, res) => {
    const result = await filtersService.getBatchFilterMatches(req.body || {}, getSessionEditActorKey(req));
    if (result.error) {
      return res.status(result.status || 400).json({ error: result.error });
    }
    return res.json(result.payload || {
      items: [],
      meta: {
        elapsedMs: 0,
        cacheHit: false
      }
    });
  });

  app.post('/api/buildings/filter-matches', filterMatchesRateLimiter, async (req, res) => {
    const result = await filtersService.getFilterMatches(req.body || {}, getSessionEditActorKey(req));
    if (result.error) {
      return res.status(result.status || 400).json({ error: result.error });
    }
    return res.json(result.payload || {
      matchedKeys: [],
      matchedFeatureIds: [],
      meta: {
        rulesHash: 'fnv1a-0',
        bboxHash: '',
        truncated: false,
        elapsedMs: 0,
        cacheHit: false
      }
    });
  });

  app.get('/api/building-info/:osmType/:osmId', buildingsReadRateLimiter, async (req, res) => {
    const osmType = req.params.osmType;
    const osmId = Number(req.params.osmId);
    if (!['way', 'relation'].includes(osmType) || !Number.isInteger(osmId)) {
      return res.status(400).json({ error: 'Некорректный идентификатор здания' });
    }

    const merged = await getMergedInfoRow(osmType, osmId);
    const actorKey = getSessionEditActorKey(req);
    const personal = actorKey ? await getLatestUserEditRow(osmType, osmId, actorKey, ['pending', 'rejected']) : null;
    const row = personal ? applyUserEditRowToInfo(merged, personal) : merged;
    if (!row) {
      return res.status(404).json({ error: 'Информация не найдена' });
    }

    return sendCachedJson(req, res, {
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
      updated_by: row.updated_by ?? row.created_by ?? null,
      updated_at: row.updated_at ?? null,
      review_status: personal ? normalizeUserEditStatus(personal.status) : 'accepted',
      admin_comment: personal?.admin_comment ?? null,
      user_edit_id: personal ? Number(personal.id || 0) : null
    }, {
      cacheControl: 'private, no-cache',
      lastModified: row.updated_at || undefined
    });
  });

  app.post('/api/building-info', buildingsWriteRateLimiter, requireCsrfSession, requireAuth, requireBuildingEditPermission, async (req, res) => {
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
    const currentContour = await getOsmContourRow(osmType, osmId);
    if (!currentContour) {
      return res.status(404).json({ error: 'Здание не найдено в локальной базе контуров' });
    }
    const requestedEditedFields = sanitizeEditedFields(body.editedFields);
    if (requestedEditedFields.length === 0) {
      return res.status(409).json({ error: 'В правке нет отличий от текущих данных' });
    }

    const tx = db.transaction(async () => {
      const latest = await getLatestUserEditRow(osmType, osmId, actorKey, ['pending']);
      const previousEditedFields = sanitizeEditedFields(latest?.edited_fields_json);
      const nextEditedFields = [...new Set([...previousEditedFields, ...requestedEditedFields])];
      const payload = {
        ...validated.value,
        edited_fields_json: nextEditedFields.length > 0 ? JSON.stringify(nextEditedFields) : null
      };
      if (latest && Number.isInteger(Number(latest.id)) && Number(latest.id) > 0) {
        await db.prepare(`
          UPDATE user_edits.building_user_edits
          SET
            name = @name,
            style = @style,
            levels = @levels,
            year_built = @year_built,
            architect = @architect,
            address = @address,
            archimap_description = @archimap_description,
            edited_fields_json = @edited_fields_json,
            source_tags_json = @source_tags_json,
            source_osm_updated_at = @source_osm_updated_at,
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
          source_tags_json: currentContour.tags_json ?? null,
          source_osm_updated_at: currentContour.updated_at ?? null,
          ...payload
        });
        await supersedePendingUserEdits(osmType, osmId, actorKey, Number(latest.id));
        return Number(latest.id || 0);
      }

      await supersedePendingUserEdits(osmType, osmId, actorKey, null);
      if (isPostgres) {
        const inserted = await db.prepare(`
          INSERT INTO user_edits.building_user_edits (
            osm_type, osm_id, created_by,
            name, style, levels, year_built, architect, address, archimap_description, edited_fields_json, source_tags_json, source_osm_updated_at,
            status, created_at, updated_at
          )
          VALUES (
            @osm_type, @osm_id, @created_by,
            @name, @style, @levels, @year_built, @architect, @address, @archimap_description, @edited_fields_json, @source_tags_json, @source_osm_updated_at,
            'pending', datetime('now'), datetime('now')
          )
          RETURNING id
        `).get({
          osm_type: osmType,
          osm_id: osmId,
          created_by: actorKey,
          source_tags_json: currentContour.tags_json ?? null,
          source_osm_updated_at: currentContour.updated_at ?? null,
          ...payload
        });
        return Number(inserted?.id || 0);
      }

      const inserted = await db.prepare(`
        INSERT INTO user_edits.building_user_edits (
          osm_type, osm_id, created_by,
          name, style, levels, year_built, architect, address, archimap_description, edited_fields_json, source_tags_json, source_osm_updated_at,
          status, created_at, updated_at
        )
        VALUES (
          @osm_type, @osm_id, @created_by,
          @name, @style, @levels, @year_built, @architect, @address, @archimap_description, @edited_fields_json, @source_tags_json, @source_osm_updated_at,
          'pending', datetime('now'), datetime('now')
        )
      `).run({
        osm_type: osmType,
        osm_id: osmId,
        created_by: actorKey,
        source_tags_json: currentContour.tags_json ?? null,
        source_osm_updated_at: currentContour.updated_at ?? null,
        ...payload
      });
      return Number(inserted?.lastInsertRowid || 0);
    });

    const editId = await tx();
    return res.json({ ok: true, editId, status: 'pending' });
  });

  app.get('/api/building/:osmType/:osmId', buildingsReadRateLimiter, async (req, res) => {
    const osmType = req.params.osmType;
    const osmId = Number(req.params.osmId);
    if (!['way', 'relation'].includes(osmType) || !Number.isInteger(osmId)) {
      return res.status(400).json({ error: 'Некорректный идентификатор здания' });
    }

    const row = await selectBuildingById.get(osmType, osmId);

    if (!row) {
      return res.status(404).json({ error: 'Здание не найдено в локальной базе контуров' });
    }

    const feature = rowToFeature(row);
    await attachInfoToFeatures([feature], { actorKey: getSessionEditActorKey(req) });
    return sendCachedJson(req, res, feature, {
      cacheControl: 'public, max-age=30'
    });
  });
}

module.exports = {
  buildFilterMatchBatchResults,
  registerBuildingsRoutes,
  compilePostgresFilterRulePredicate,
  compilePostgresFilterRulesPredicate,
  compilePostgresFilterRuleGuardPredicate,
  compilePostgresFilterRulesGuardPredicate
};
