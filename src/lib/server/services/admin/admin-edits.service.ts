const { createAdminError, isLikelyEmail, parseLimit, parseOsmTarget, parsePositiveId } = require('./shared');
const { splitBuildingMaterialSelection, sanitizeProjectYear } = require('../edits.service');
const { hasSearchIndexRelevantFieldChange } = require('../search-index-fields');
const { assertMutableSyncStatus } = require('../building-edits/shared');
import type {
  BuildingEdit,
  BuildingEditListQuery,
  BuildingEditMergeCandidate,
  BuildingEditMergeValues
} from '$shared/types';

function createAdminEditsService(options: LooseRecord = {}) {
  const {
    db,
    getUserEditsList,
    getUserEditDetailsById,
    normalizeUserEditStatus,
    sanitizeFieldText,
    sanitizeYearBuilt,
    sanitizeLevels,
    getMergedInfoRow,
    getOsmContourRow,
    reassignUserEdit,
    deleteUserEdit,
    enqueueSearchIndexRefresh,
    refreshDesignRefSuggestionsCache,
    ARCHI_FIELD_SET
  } = options;

  async function listBuildingEdits({ status, limit }: BuildingEditListQuery = {}): Promise<BuildingEdit[]> {
    const statusRaw = String(status || '')
      .trim()
      .toLowerCase();
    const normalizedStatus = statusRaw === 'all' || !statusRaw ? null : normalizeUserEditStatus(statusRaw);
    const normalizedLimit = parseLimit(limit, 200, 1, 1000);
    return getUserEditsList({ status: normalizedStatus, limit: normalizedLimit, summary: false });
  }

  async function getBuildingEditDetails(editIdRaw): Promise<BuildingEdit> {
    const editId = parsePositiveId(editIdRaw);
    if (!editId) {
      throw createAdminError(400, 'Invalid edit id');
    }
    const item = await getUserEditDetailsById(editId);
    if (!item) {
      throw createAdminError(404, 'Edit not found');
    }
    return item;
  }

  async function getUserByEmail(emailRaw) {
    const email = String(emailRaw || '')
      .trim()
      .toLowerCase();
    if (!isLikelyEmail(email)) {
      throw createAdminError(400, 'Invalid email');
    }

    const row = await db
      .prepare(
        `
      SELECT
        u.email,
        u.first_name,
        u.last_name,
        u.can_edit,
        u.is_admin,
        u.is_master_admin,
        u.created_at,
        COALESCE(e.edit_count, 0) AS edits_count,
        e.last_edit_at
      FROM auth.users u
      LEFT JOIN (
        SELECT
          lower(trim(created_by)) AS created_by_key,
          COUNT(*) AS edit_count,
          MAX(updated_at) AS last_edit_at
        FROM user_edits.building_user_edits
        GROUP BY lower(trim(created_by))
      ) e
        ON e.created_by_key = lower(u.email)
      WHERE lower(u.email) = ?
      LIMIT 1
    `
      )
      .get(email);
    if (!row) {
      throw createAdminError(404, 'User not found');
    }

    return {
      item: {
        email: String(row.email || ''),
        firstName: row.first_name == null ? null : String(row.first_name),
        lastName: row.last_name == null ? null : String(row.last_name),
        canEdit: Number(row.can_edit || 0) > 0,
        isAdmin: Number(row.is_master_admin || 0) > 0 || Number(row.is_admin || 0) > 0,
        isMasterAdmin: Number(row.is_master_admin || 0) > 0,
        createdAt: String(row.created_at || ''),
        editsCount: Number(row.edits_count || 0),
        lastEditAt: row.last_edit_at ? String(row.last_edit_at) : null
      },
      lastModified: row.last_edit_at || row.created_at || undefined
    };
  }

  async function getUserEditsByEmail(emailRaw, limitRaw) {
    const email = String(emailRaw || '')
      .trim()
      .toLowerCase();
    if (!isLikelyEmail(email)) {
      throw createAdminError(400, 'Invalid email');
    }
    const limit = parseLimit(limitRaw, 200, 1, 1000);
    return getUserEditsList({ createdBy: email, limit, summary: true });
  }

  function queueDesignRefSuggestionsRefresh(reason, shouldRefresh) {
    if (!shouldRefresh) return;
    void Promise.resolve(refreshDesignRefSuggestionsCache?.(reason)).catch(() => {});
  }

  function shouldRefreshSearchIndexForChanges(changes) {
    return hasSearchIndexRelevantFieldChange(changes);
  }

  async function rejectBuildingEdit(
    editIdRaw,
    { comment, reviewer }: { comment?: string; reviewer?: string | null } = {}
  ) {
    const row = await getBuildingEditDetails(editIdRaw);
    assertMutableSyncStatus(row.syncStatus);
    if (normalizeUserEditStatus(row.status) !== 'pending') {
      throw createAdminError(409, 'Edit has already been processed');
    }

    const editId = parsePositiveId(editIdRaw);
    const adminComment = sanitizeFieldText(comment, 1200);
    const result = await db
      .prepare(
        `
      UPDATE user_edits.building_user_edits
      SET
        status = 'rejected',
        admin_comment = ?,
        reviewed_by = ?,
        reviewed_at = datetime('now'),
        merged_by = NULL,
        merged_at = NULL,
        merged_fields_json = NULL,
        updated_at = datetime('now')
      WHERE id = ? AND status = 'pending'
    `
      )
      .run(adminComment, reviewer || 'admin', editId);
    if (Number(result?.changes || 0) === 0) {
      throw createAdminError(409, 'Edit has already been processed by another administrator');
    }

    return {
      ok: true,
      editId,
      status: 'rejected'
    };
  }

  async function reassignBuildingEdit(
    editIdRaw,
    { target, actor, force }: { target?: string | null; actor?: string | null; force?: boolean } = {}
  ) {
    const editId = parsePositiveId(editIdRaw);
    if (!editId) {
      throw createAdminError(400, 'Invalid edit id');
    }

    const parsedTarget = parseOsmTarget(target);
    if (!parsedTarget) {
      throw createAdminError(400, 'Provide a valid target building id');
    }

    const before = await getUserEditDetailsById(editId);
    if (!before) {
      throw createAdminError(404, 'Edit not found');
    }
    assertMutableSyncStatus(before.syncStatus);

    try {
      const updated = await reassignUserEdit(editId, parsedTarget, {
        actor: actor || 'admin',
        force: Boolean(force === true)
      });
      const beforeOsmType = String(before.osmType || '').trim();
      const beforeOsmId = Number(before.osmId);
      const afterOsmType = String(updated?.osmType || '').trim();
      const afterOsmId = Number(updated?.osmId);
      const shouldRefreshSearchIndex =
        shouldRefreshSearchIndexForChanges(before.changes) &&
        normalizeUserEditStatus(before.status) !== 'pending' &&
        Number.isInteger(beforeOsmId) &&
        beforeOsmType &&
        (beforeOsmType !== afterOsmType || beforeOsmId !== afterOsmId);
      if (shouldRefreshSearchIndex) {
        enqueueSearchIndexRefresh(beforeOsmType, beforeOsmId);
        if (
          afterOsmType &&
          Number.isInteger(afterOsmId) &&
          (beforeOsmType !== afterOsmType || beforeOsmId !== afterOsmId)
        ) {
          enqueueSearchIndexRefresh(afterOsmType, afterOsmId);
        }
      }
      return updated;
    } catch (error) {
      const message = String(error?.message || error || 'Failed to reassign edit');
      if (/synchronized/i.test(message)) {
        throw createAdminError(error.status || 409, message, { code: 'EDIT_SYNC_LOCKED' });
      }
      if (/currently being synchronized/i.test(message)) {
        throw createAdminError(error.status || 409, message, { code: 'EDIT_SYNC_IN_PROGRESS' });
      }
      if (String(error?.code || '').startsWith('EDIT_SYNC_')) {
        throw createAdminError(error.status || 409, message, { code: error.code });
      }
      if (message.includes('not found')) {
        throw createAdminError(404, message);
      }
      if (message.includes('conflicting local fields')) {
        throw createAdminError(409, message, { code: 'REASSIGN_TARGET_CONFLICT' });
      }
      throw createAdminError(400, message);
    }
  }

  async function deleteBuildingEdit(editIdRaw) {
    const editId = parsePositiveId(editIdRaw);
    if (!editId) {
      throw createAdminError(400, 'Invalid edit id');
    }

    const before = await getUserEditDetailsById(editId);
    if (!before) {
      throw createAdminError(404, 'Edit not found');
    }
    assertMutableSyncStatus(before.syncStatus);

    try {
      const deleted = await deleteUserEdit(editId);
      if (
        deleted?.deletedMergedLocal &&
        shouldRefreshSearchIndexForChanges(before.changes) &&
        deleted?.osmType &&
        Number.isInteger(Number(deleted.osmId))
      ) {
        enqueueSearchIndexRefresh(deleted.osmType, deleted.osmId);
      }
      queueDesignRefSuggestionsRefresh(
        'admin-delete',
        Array.isArray(before?.changes) && before.changes.some((change) => String(change?.field || '') === 'design_ref')
      );
      return deleted;
    } catch (error) {
      const message = String(error?.message || error || 'Failed to delete edit');
      if (/synchronized/i.test(message)) {
        throw createAdminError(error.status || 409, message, { code: 'EDIT_SYNC_LOCKED' });
      }
      if (/currently being synchronized/i.test(message)) {
        throw createAdminError(error.status || 409, message, { code: 'EDIT_SYNC_IN_PROGRESS' });
      }
      if (String(error?.code || '').startsWith('EDIT_SYNC_')) {
        throw createAdminError(error.status || 409, message, { code: error.code });
      }
      if (error?.code === 'EDIT_NOT_FOUND' || message.includes('not found')) {
        throw createAdminError(404, message);
      }
      if (error?.code === 'EDIT_DELETE_SHARED_MERGED_STATE') {
        throw createAdminError(409, message, { code: error.code });
      }
      throw createAdminError(400, message);
    }
  }

  function sanitizeMergeValues(fieldsToMerge, valuesRaw: BuildingEditMergeValues | Record<string, unknown> = {}) {
    const source: LooseRecord = valuesRaw && typeof valuesRaw === 'object' ? valuesRaw : {};
    const sanitizedValues: LooseRecord = {};

    for (const key of fieldsToMerge) {
      if (!Object.prototype.hasOwnProperty.call(source, key)) continue;
      if (key === 'year_built') {
        const parsedYearBuilt = sanitizeYearBuilt(source[key]);
        if (parsedYearBuilt == null && String(source[key] ?? '').trim() !== '') {
          throw createAdminError(400, 'Year built must be an integer between 1000 and 2100');
        }
        sanitizedValues[key] = parsedYearBuilt;
        continue;
      }
      if (key === 'design_year') {
        const parsedDesignYear = sanitizeProjectYear(source[key]);
        if (parsedDesignYear == null && String(source[key] ?? '').trim() !== '') {
          throw createAdminError(400, 'Design year must be an integer between 1000 and 2100');
        }
        sanitizedValues[key] = parsedDesignYear;
        continue;
      }
      if (key === 'levels') {
        const parsedLevels = sanitizeLevels(source[key]);
        if (parsedLevels == null && String(source[key] ?? '').trim() !== '') {
          throw createAdminError(400, 'Levels must be an integer between 0 and 300');
        }
        sanitizedValues[key] = parsedLevels;
        continue;
      }
      if (key === 'material') {
        const selection = splitBuildingMaterialSelection(source[key]);
        sanitizedValues.material = selection.material;
        sanitizedValues.material_concrete = selection.material_concrete;
        continue;
      }
      const maxLen = key === 'archimap_description' ? 1000 : key === 'design_ref' ? 500 : 300;
      sanitizedValues[key] = sanitizeFieldText(source[key], maxLen);
    }

    return sanitizedValues;
  }

  async function buildMergedCandidate(item: BuildingEdit, editId): Promise<BuildingEditMergeCandidate> {
    const currentMergedRow = (await getMergedInfoRow(item.osmType, item.osmId)) as LooseRecord | null;
    const editCreatedTs = item.createdAt ? Date.parse(String(item.createdAt)) : NaN;
    const currentMergedTs = currentMergedRow?.updated_at ? Date.parse(String(currentMergedRow.updated_at)) : NaN;
    const currentMerged: BuildingEditMergeCandidate['currentMerged'] = {
      osm_type: currentMergedRow?.osm_type ?? undefined,
      osm_id: currentMergedRow?.osm_id == null ? undefined : Number(currentMergedRow.osm_id),
      name: currentMergedRow?.name ?? null,
      style: currentMergedRow?.style ?? null,
      design: currentMergedRow?.design ?? null,
      design_ref: currentMergedRow?.design_ref ?? null,
      design_year: currentMergedRow?.design_year ?? null,
      material: currentMergedRow?.material ?? null,
      material_concrete: currentMergedRow?.material_concrete ?? null,
      colour: currentMergedRow?.colour ?? null,
      levels: currentMergedRow?.levels ?? null,
      year_built: currentMergedRow?.year_built ?? null,
      architect: currentMergedRow?.architect ?? null,
      address: currentMergedRow?.address ?? null,
      description: currentMergedRow?.description ?? null,
      archimap_description: currentMergedRow?.archimap_description ?? null,
      updated_by: currentMergedRow?.updated_by ?? null,
      updated_at: currentMergedRow?.updated_at ?? null
    };
    const editSourceRow =
      (await db
        .prepare(
          `
        SELECT name, style, design, design_ref, design_year, material, material_concrete, colour, levels, year_built, architect, address, archimap_description
        FROM user_edits.building_user_edits
        WHERE id = ?
        LIMIT 1
      `
        )
        .get(editId)) || {};
    const editSource: BuildingEditMergeCandidate['editSource'] = {
      name: editSourceRow.name ?? null,
      style: editSourceRow.style ?? null,
      design: editSourceRow.design ?? null,
      design_ref: editSourceRow.design_ref ?? null,
      design_year: editSourceRow.design_year ?? null,
      material: editSourceRow.material ?? null,
      material_raw: editSourceRow.material == null ? null : String(editSourceRow.material),
      material_concrete: editSourceRow.material_concrete ?? null,
      colour: editSourceRow.colour ?? null,
      levels: editSourceRow.levels ?? null,
      year_built: editSourceRow.year_built ?? null,
      architect: editSourceRow.architect ?? null,
      address: editSourceRow.address ?? null,
      archimap_description: editSourceRow.archimap_description ?? null
    };
    const mergedCandidate: BuildingEditMergeCandidate['mergedCandidate'] = {
      name: currentMerged?.name ?? null,
      style: currentMerged?.style ?? null,
      design: currentMerged?.design ?? null,
      design_ref: currentMerged?.design_ref ?? null,
      design_year: currentMerged?.design_year ?? null,
      material: currentMerged?.material ?? null,
      material_raw: currentMerged?.material == null ? null : String(currentMerged.material),
      material_concrete: currentMerged?.material_concrete ?? null,
      colour: currentMerged?.colour ?? null,
      levels: currentMerged?.levels ?? null,
      year_built: currentMerged?.year_built ?? null,
      architect: currentMerged?.architect ?? null,
      address: currentMerged?.address ?? null,
      archimap_description: currentMerged?.archimap_description ?? null
    };

    return {
      currentMerged,
      editCreatedTs,
      currentMergedTs,
      editSource,
      mergedCandidate
    };
  }

  async function mergeBuildingEdit(
    editIdRaw,
    {
      force,
      fields,
      values,
      comment,
      reviewer
    }: {
      force?: boolean;
      fields?: string[];
      values?: BuildingEditMergeValues | Record<string, unknown>;
      comment?: string;
      reviewer?: string;
    } = {}
  ) {
    const item = await getBuildingEditDetails(editIdRaw);
    assertMutableSyncStatus(item.syncStatus);
    if (normalizeUserEditStatus(item.status) !== 'pending') {
      throw createAdminError(409, 'Edit has already been processed');
    }

    const forceMerge = Boolean(force === true);
    const currentContour = await getOsmContourRow(item.osmType, item.osmId);
    if (!currentContour) {
      throw createAdminError(
        409,
        'Source OSM building no longer exists in the local contours database. Reassign the edit to a current building first.',
        {
          code: 'EDIT_TARGET_MISSING'
        }
      );
    }
    if (!forceMerge && item.sourceOsmChanged) {
      throw createAdminError(
        409,
        'Edit is outdated because the building OSM data changed after the edit was created. Refresh the edit, reassign it, or run merge with force.',
        {
          code: 'EDIT_OUTDATED_OSM',
          details: {
            currentUpdatedAt: item.currentOsmUpdatedAt || null,
            sourceUpdatedAt: item.sourceOsmUpdatedAt || null
          }
        }
      );
    }

    const allowedFields = new Set<string>((item.changes || []).map((change) => String(change.field || '')));
    if (allowedFields.size === 0) {
      throw createAdminError(409, 'Edit does not contain changes');
    }

    const requestedFields = Array.isArray(fields)
      ? fields
          .map((value) => String(value || '').trim())
          .filter((key) => ARCHI_FIELD_SET.has(key) && allowedFields.has(key))
      : [];
    const fieldsToMerge = requestedFields.length > 0 ? [...new Set(requestedFields)] : [...allowedFields];
    const sanitizedValues = sanitizeMergeValues(fieldsToMerge, values);
    const editId = parsePositiveId(editIdRaw);
    const { currentMerged, editCreatedTs, currentMergedTs, editSource, mergedCandidate } = await buildMergedCandidate(
      item,
      editId
    );

    if (
      !forceMerge &&
      Number.isFinite(editCreatedTs) &&
      Number.isFinite(currentMergedTs) &&
      currentMergedTs > editCreatedTs
    ) {
      throw createAdminError(
        409,
        'Edit is outdated because the building data changed after the edit was created. Refresh the edit or run merge with force.',
        {
          code: 'EDIT_OUTDATED',
          details: {
            currentUpdatedAt: currentMerged?.updated_at || null,
            editCreatedAt: item.createdAt || null
          }
        }
      );
    }

    for (const field of fieldsToMerge) {
      if (field === 'material') {
        if (Object.prototype.hasOwnProperty.call(sanitizedValues, 'material')) {
          const materialSplit = splitBuildingMaterialSelection(sanitizedValues.material);
          mergedCandidate.material = materialSplit.material;
          mergedCandidate.material_concrete = Object.prototype.hasOwnProperty.call(sanitizedValues, 'material_concrete')
            ? sanitizedValues.material_concrete
            : materialSplit.material_concrete || null;
        } else {
          mergedCandidate.material = editSource.material ?? null;
          mergedCandidate.material_concrete = editSource.material_concrete ?? null;
        }
        continue;
      }
      mergedCandidate[field] = Object.prototype.hasOwnProperty.call(sanitizedValues, field)
        ? sanitizedValues[field]
        : (editSource[field] ?? null);
    }

    const normalizedReviewer = reviewer || 'admin';
    const adminComment = sanitizeFieldText(comment, 1200);
    const nextStatus = fieldsToMerge.length < allowedFields.size ? 'partially_accepted' : 'accepted';
    // Keep merge/update writes in one transaction to preserve legacy concurrency behaviour.
    const tx = db.transaction(async () => {
      await db
        .prepare(
          `
        INSERT INTO local.architectural_info (
          osm_type, osm_id, name, style, design, design_ref, design_year, material, material_concrete, colour, levels, year_built, architect, address, archimap_description, updated_by, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
        ON CONFLICT(osm_type, osm_id) DO UPDATE SET
          name = excluded.name,
          style = excluded.style,
          design = excluded.design,
          design_ref = excluded.design_ref,
          design_year = excluded.design_year,
          material = excluded.material,
          material_concrete = excluded.material_concrete,
          colour = excluded.colour,
          levels = excluded.levels,
          year_built = excluded.year_built,
          architect = excluded.architect,
          address = excluded.address,
          archimap_description = excluded.archimap_description,
          updated_by = excluded.updated_by,
          updated_at = datetime('now')
      `
        )
        .run(
          item.osmType,
          item.osmId,
          mergedCandidate.name,
          mergedCandidate.style,
          mergedCandidate.design,
          mergedCandidate.design_ref,
          mergedCandidate.design_year,
          mergedCandidate.material,
          mergedCandidate.material_concrete,
          mergedCandidate.colour,
          mergedCandidate.levels,
          mergedCandidate.year_built,
          mergedCandidate.architect,
          mergedCandidate.address,
          mergedCandidate.archimap_description,
          normalizedReviewer
        );

      await db
        .prepare(
          `
        UPDATE user_edits.building_user_edits
        SET
          status = ?,
          admin_comment = ?,
          reviewed_by = ?,
          reviewed_at = datetime('now'),
          merged_by = ?,
          merged_at = datetime('now'),
          merged_fields_json = ?,
          updated_at = datetime('now')
        WHERE id = ? AND status = 'pending'
      `
        )
        .run(nextStatus, adminComment, normalizedReviewer, normalizedReviewer, JSON.stringify(fieldsToMerge), editId);
    });

    try {
      await tx();
    } catch {
      throw createAdminError(409, 'Failed to apply merge because the edit was modified concurrently');
    }

    const updated = await db.prepare('SELECT status FROM user_edits.building_user_edits WHERE id = ?').get(editId);
    const normalizedStatus = normalizeUserEditStatus(updated?.status);
    if (!updated || (normalizedStatus !== 'accepted' && normalizedStatus !== 'partially_accepted')) {
      throw createAdminError(409, 'Edit has already been processed by another administrator');
    }

    if (shouldRefreshSearchIndexForChanges(fieldsToMerge)) {
      enqueueSearchIndexRefresh(item.osmType, item.osmId);
    }
    queueDesignRefSuggestionsRefresh('admin-merge', fieldsToMerge.includes('design_ref'));
    return {
      ok: true,
      editId,
      status: nextStatus,
      mergedFields: fieldsToMerge
    };
  }

  async function bulkMergeBuildingEdits(
    editIdsRaw,
    {
      force,
      comment,
      reviewer
    }: {
      force?: boolean;
      comment?: string;
      reviewer?: string;
    } = {}
  ) {
    const requestedIds = Array.isArray(editIdsRaw) ? editIdsRaw : [];
    const normalizedIds: number[] = [];
    const seenIds = new Set<number>();

    for (const rawId of requestedIds) {
      const editId = parsePositiveId(rawId);
      if (!editId || seenIds.has(editId)) continue;
      seenIds.add(editId);
      normalizedIds.push(editId);
    }

    if (normalizedIds.length === 0) {
      throw createAdminError(400, 'Select at least one edit to merge', { code: 'ERR_INVALID_INPUT' });
    }

    const results: Array<LooseRecord> = [];
    let successCount = 0;
    let failureCount = 0;

    for (const editId of normalizedIds) {
      try {
        const result = await mergeBuildingEdit(editId, {
          force,
          comment,
          reviewer
        });
        successCount += 1;
        results.push({
          editId,
          ok: true,
          status: result.status,
          mergedFields: Array.isArray(result.mergedFields) ? result.mergedFields : []
        });
      } catch (error) {
        failureCount += 1;
        results.push({
          editId,
          ok: false,
          httpStatus: Number(error?.status) || 409,
          code: String(error?.code || ''),
          error: String(error?.message || 'Failed to merge edit')
        });
      }
    }

    return {
      ok: true,
      totalCount: normalizedIds.length,
      successCount,
      failureCount,
      results
    };
  }

  return {
    listBuildingEdits,
    getBuildingEditDetails,
    getUserByEmail,
    getUserEditsByEmail,
    rejectBuildingEdit,
    reassignBuildingEdit,
    deleteBuildingEdit,
    mergeBuildingEdit,
    bulkMergeBuildingEdits
  };
}

module.exports = {
  createAdminEditsService
};
