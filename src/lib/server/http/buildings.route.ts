const { sendCachedJson } = require('../infra/http-cache.infra');
const {
  buildFilterMatchBatchResults,
  createBuildingFiltersService
} = require('../services/building-filters.service');
const { createBuildingsRepository } = require('../services/buildings.repository');
const {
  compilePostgresFilterRuleGuardPredicate,
  compilePostgresFilterRulePredicate,
  compilePostgresFilterRulesGuardPredicate,
  compilePostgresFilterRulesPredicate
} = require('../utils/filter-sql-builder');
const { getFeatureKindFromTagsJson } = require('../utils/building-feature-kind');
const { toIsoTimestampOrNull } = require('../utils/timestamp');

function normalizeJsonText(value) {
  if (value == null) return null;
  if (typeof value === 'string') {
    const text = value.trim();
    if (!text) return null;
    try {
      const parsed = JSON.parse(text);
      if (parsed == null) return null;
      return JSON.stringify(parsed);
    } catch {
      return null;
    }
  }
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}

function buildSourceSnapshot(options: any = {}) {
  const snapshotOptions = options || {};
  const contourRow = snapshotOptions.contourRow ?? null;
  const body = snapshotOptions.body ?? {};
  const fallbackRow = snapshotOptions.fallbackRow ?? null;
  if (contourRow) {
    return {
      sourceGeometryJson: normalizeJsonText(contourRow.geometry_json),
      sourceTagsJson: normalizeJsonText(contourRow.tags_json),
      sourceOsmUpdatedAt: toIsoTimestampOrNull(contourRow.updated_at)
    };
  }

  const bodyGeometryJson = normalizeJsonText(body?.sourceGeometryJson);
  const bodyTagsJson = normalizeJsonText(body?.sourceTagsJson);
  const fallbackGeometryJson = normalizeJsonText(fallbackRow?.source_geometry_json);
  const fallbackTagsJson = normalizeJsonText(fallbackRow?.source_tags_json);

  return {
    sourceGeometryJson: bodyGeometryJson || fallbackGeometryJson,
    sourceTagsJson: bodyTagsJson || fallbackTagsJson,
    sourceOsmUpdatedAt: toIsoTimestampOrNull(body?.sourceOsmUpdatedAt)
      || toIsoTimestampOrNull(fallbackRow?.source_osm_updated_at)
  };
}

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
    supersedePendingUserEdits,
    getDesignRefSuggestionsCached,
    refreshDesignRefSuggestionsCache
  } = deps;
  const filtersService = createBuildingFiltersService({
    db,
    rtreeState,
    isFilterTagAllowed,
    applyPersonalEditsToFilterItems
  });
  const buildingsRepository = deps.buildingsRepository || createBuildingsRepository({ db });

  app.post('/api/buildings/filter-data', filterDataRateLimiter, async (req, res) => {
    const result = await filtersService.getFilterDataByKeys(req.body?.keys, getSessionEditActorKey(req));
    if (result.error) {
      return res.status(result.status || 400).json({ code: result.code || 'ERR_REQUEST_FAILED', error: result.error });
    }
    return res.json({ items: result.items || [] });
  });

  app.get('/api/buildings/filter-data-bbox', filterDataBboxRateLimiter, async (req, res) => {
    const result = await filtersService.getFilterDataByBbox(req.query, getSessionEditActorKey(req));
    if (result.error) {
      return res.status(result.status || 400).json({ code: result.code || 'ERR_REQUEST_FAILED', error: result.error });
    }
    return sendCachedJson(req, res, result.payload || { items: [], truncated: false }, {
      cacheControl: 'public, max-age=10'
    });
  });

  app.post('/api/buildings/filter-matches-batch', filterMatchesRateLimiter, async (req, res) => {
    const result = await filtersService.getBatchFilterMatches(req.body || {}, getSessionEditActorKey(req));
    if (result.error) {
      return res.status(result.status || 400).json({ code: result.code || 'ERR_REQUEST_FAILED', error: result.error });
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
      return res.status(result.status || 400).json({ code: result.code || 'ERR_REQUEST_FAILED', error: result.error });
    }
    return res.json(result.payload || {
      matchedKeys: [],
      matchedFeatureIds: [],
      matchedLocations: [],
      matchedCount: 0,
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
      return res.status(400).json({ code: 'ERR_INVALID_BUILDING_ID', error: 'Invalid building id' });
    }

    const [merged, contour, designRefSuggestions] = await Promise.all([
      getMergedInfoRow(osmType, osmId),
      getOsmContourRow(osmType, osmId),
      typeof getDesignRefSuggestionsCached === 'function' ? getDesignRefSuggestionsCached() : []
    ]);
    const actorKey = getSessionEditActorKey(req);
    const personal = actorKey ? await getLatestUserEditRow(osmType, osmId, actorKey, ['pending', 'rejected']) : null;
    const row = personal ? applyUserEditRowToInfo(merged, personal) : merged;
    if (!row && !contour) {
      return res.status(404).json({ code: 'ERR_BUILDING_INFO_NOT_FOUND', error: 'Building info was not found' });
    }
    const featureKind = getFeatureKindFromTagsJson(contour?.tags_json);
    const regionSlugs = (await buildingsRepository.getBuildingRegionSlugsById(osmType, osmId))
      .map((item) => String(item?.slug || '').trim())
      .filter(Boolean);

    return sendCachedJson(req, res, {
      osm_type: osmType,
      osm_id: osmId,
      feature_kind: featureKind,
      name: row?.name ?? null,
      style: row?.style ?? null,
      design: row?.design ?? null,
      design_ref: row?.design_ref ?? null,
      design_year: row?.design_year ?? null,
      material: row?.material ?? null,
      material_concrete: row?.material_concrete ?? null,
      roof_shape: row?.roof_shape ?? null,
      colour: row?.colour ?? null,
      levels: row?.levels ?? null,
      year_built: row?.year_built ?? null,
      architect: row?.architect ?? null,
      address: row?.address ?? null,
      description: row?.description ?? null,
      archimap_description: row?.archimap_description ?? row?.description ?? null,
      updated_by: row?.updated_by ?? row?.created_by ?? null,
      updated_at: row?.updated_at ?? null,
      review_status: personal ? normalizeUserEditStatus(personal.status) : 'accepted',
      admin_comment: personal?.admin_comment ?? null,
      user_edit_id: personal ? Number(personal.id || 0) : null,
      region_slugs: regionSlugs,
      design_ref_suggestions: Array.isArray(designRefSuggestions) ? designRefSuggestions : []
    }, {
      cacheControl: 'private, no-cache',
      lastModified: row?.updated_at || contour?.updated_at || undefined
    });
  });

  app.post('/api/building-info', buildingsWriteRateLimiter, requireCsrfSession, requireAuth, requireBuildingEditPermission, async (req, res) => {
    const body = req.body || {};
    const osmType = body.osmType;
    const osmId = Number(body.osmId);

    if (!['way', 'relation'].includes(osmType) || !Number.isInteger(osmId)) {
      return res.status(400).json({ code: 'ERR_INVALID_BUILDING_ID', error: 'Invalid building id' });
    }

    const validated = sanitizeArchiPayload(body);
    if (validated.error) {
      return res.status(400).json({ code: validated.code || 'ERR_INVALID_INPUT', error: validated.error });
    }
    const actorKey = getSessionEditActorKey(req);
    if (!actorKey) {
      return res.status(400).json({ code: 'ERR_CURRENT_USER_UNRESOLVED', error: 'Failed to resolve current user' });
    }
    const currentContour = await getOsmContourRow(osmType, osmId);
    const latestSnapshot = !currentContour && buildingsRepository && typeof buildingsRepository.getLatestUserEditSnapshotById === 'function'
      ? await buildingsRepository.getLatestUserEditSnapshotById(osmType, osmId)
      : null;
    const sourceSnapshot = buildSourceSnapshot({
      contourRow: currentContour,
      body,
      fallbackRow: latestSnapshot
    });
    if (!sourceSnapshot.sourceGeometryJson || !sourceSnapshot.sourceTagsJson) {
      return res.status(404).json({ code: 'ERR_BUILDING_NOT_FOUND', error: 'Building source snapshot was not found' });
    }
    const featureKind = getFeatureKindFromTagsJson(sourceSnapshot.sourceTagsJson);
    const requestedEditedFields = sanitizeEditedFields(body.editedFields);
    if (requestedEditedFields.length === 0) {
      return res.status(409).json({ code: 'ERR_EDIT_NO_CHANGES', error: 'Edit payload does not contain changes' });
    }
    const shouldRefreshDesignRefSuggestions = requestedEditedFields.includes('design_ref');
    if (featureKind === 'building_part') {
      const allowedFields = new Set(['levels', 'colour', 'style', 'material', 'roof_shape', 'year_built']);
      const hasDisallowedRequestedFields = requestedEditedFields.some((field) => !allowedFields.has(field));
      const hasDisallowedPayloadFields = ['name', 'design', 'design_ref', 'design_year', 'architect', 'address', 'archimap_description']
        .some((field) => validated.value?.[field] != null);
      if (hasDisallowedRequestedFields || hasDisallowedPayloadFields) {
        return res.status(400).json({
          code: 'ERR_BUILDING_PART_EDIT_RESTRICTED',
          error: 'Building parts can only edit levels, colour, style, material, and year built'
        });
      }
    }

    const tx = db.transaction(async () => {
      const latest = await getLatestUserEditRow(osmType, osmId, actorKey, ['pending']);
      const previousEditedFields = sanitizeEditedFields(latest?.edited_fields_json);
      const nextEditedFields = [...new Set([...previousEditedFields, ...requestedEditedFields])];
      const pendingEdit = {
        ...validated.value,
        edited_fields_json: nextEditedFields.length > 0 ? JSON.stringify(nextEditedFields) : null,
        source_osm_version: null,
        source_geometry_json: sourceSnapshot.sourceGeometryJson,
        source_tags_json: sourceSnapshot.sourceTagsJson,
        source_osm_updated_at: sourceSnapshot.sourceOsmUpdatedAt
      };
      if (latest && Number.isInteger(Number(latest.id)) && Number(latest.id) > 0) {
        await buildingsRepository.updatePendingUserEditById(latest.id, {
          id: latest.id,
          ...pendingEdit
        });
        await supersedePendingUserEdits(osmType, osmId, actorKey, Number(latest.id));
        return Number(latest.id || 0);
      }

      await supersedePendingUserEdits(osmType, osmId, actorKey, null);
      return buildingsRepository.insertPendingUserEdit({
        osm_type: osmType,
        osm_id: osmId,
        created_by: actorKey,
        ...pendingEdit
      });
    });

    const editId = await tx();
    if (shouldRefreshDesignRefSuggestions) {
      // Refreshing suggestions scans the full design-ref corpus, so keep it off the save path.
      void Promise.resolve(refreshDesignRefSuggestionsCache?.('building-info-save')).catch(() => {});
    }
    return res.json({ ok: true, editId, status: 'pending' });
  });

  app.get('/api/building/:osmType/:osmId', buildingsReadRateLimiter, async (req, res) => {
    const osmType = req.params.osmType;
    const osmId = Number(req.params.osmId);
    if (!['way', 'relation'].includes(osmType) || !Number.isInteger(osmId)) {
      return res.status(400).json({ code: 'ERR_INVALID_BUILDING_ID', error: 'Invalid building id' });
    }

    const contourRow = await buildingsRepository.getBuildingById(osmType, osmId);
    const snapshotRow = contourRow
      ? null
      : (typeof buildingsRepository.getLatestUserEditSnapshotById === 'function'
        ? await buildingsRepository.getLatestUserEditSnapshotById(osmType, osmId)
        : null);
    const row = contourRow || snapshotRow;

    if (!row) {
      return res.status(404).json({ code: 'ERR_BUILDING_NOT_FOUND', error: 'Building was not found in the local contours database' });
    }

    const feature = rowToFeature(row);
    await attachInfoToFeatures([feature], { actorKey: getSessionEditActorKey(req) });
    return sendCachedJson(req, res, feature, {
      cacheControl: 'public, max-age=30',
      lastModified: row?.updated_at || contourRow?.updated_at || undefined
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
