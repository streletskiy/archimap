const { assertMutableSyncStatus } = require('./shared');
const { toIsoTimestampOrNull } = require('../../utils/timestamp');

function createBuildingEditModerationService(context: LooseRecord, { getUserEditDetailsById }: LooseRecord) {
  const {
    MERGED_EDIT_STATUSES,
    REASSIGNABLE_EDIT_STATUSES,
    countMergedEditsForTarget,
    db,
    getMergedInfoRow,
    getOsmContourRow,
    normalizeComparableForField,
    normalizeUserEditStatus,
    supersedePendingUserEdits
  } = context;

  if (typeof getUserEditDetailsById !== 'function') {
    throw new Error('createBuildingEditModerationService: getUserEditDetailsById is required');
  }

  function mergeLocalInfoForReassign(sourceRow: LooseRecord, targetRow: LooseRecord, { force = false }: LooseRecord = {}) {
    const fields = ['name', 'style', 'design', 'design_ref', 'design_year', 'material', 'material_concrete', 'roof_shape', 'colour', 'levels', 'year_built', 'architect', 'address', 'archimap_description'];
    const conflicts: string[] = [];
    const merged: LooseRecord = {};

    for (const field of fields) {
      const sourceValue = sourceRow?.[field] ?? null;
      const targetValue = targetRow?.[field] ?? null;

      if (sourceValue == null) {
        merged[field] = targetValue;
        continue;
      }
      if (targetValue == null || normalizeComparableForField(field, sourceValue) === normalizeComparableForField(field, targetValue) || force) {
        merged[field] = sourceValue;
        continue;
      }

      conflicts.push(field);
      merged[field] = targetValue;
    }

    return { merged, conflicts };
  }

  async function reassignUserEdit(editId, target, options: LooseRecord = {}) {
    const id = Number(editId);
    if (!Number.isInteger(id) || id <= 0) {
      throw new Error('Invalid edit id');
    }

    const targetOsmType = String(target?.osmType || '').trim();
    const targetOsmId = Number(target?.osmId);
    if (!['way', 'relation'].includes(targetOsmType) || !Number.isInteger(targetOsmId) || targetOsmId <= 0) {
      throw new Error('Invalid target building id');
    }

    const actor = String(options.actor || '').trim() || 'admin';
    const force = Boolean(options.force);
    const item = await getUserEditDetailsById(id);
    if (!item) {
      throw new Error('Edit not found');
    }
    if (!REASSIGNABLE_EDIT_STATUSES.has(item.status)) {
      throw new Error('This edit cannot be reassigned');
    }
    assertMutableSyncStatus(item.syncStatus);

    const targetContour = await getOsmContourRow(targetOsmType, targetOsmId);
    if (!targetContour) {
      throw new Error('Target building was not found in the local contours database');
    }

    if (item.osmType === targetOsmType && Number(item.osmId) === targetOsmId) {
      return item;
    }

    if (item.status === 'pending') {
      const tx = db.transaction(async () => {
        await db.prepare(`
          UPDATE user_edits.building_user_edits
          SET
            osm_type = ?,
            osm_id = ?,
            source_tags_json = ?,
            source_osm_updated_at = ?,
            updated_at = datetime('now')
          WHERE id = ?
        `).run(targetOsmType, targetOsmId, targetContour.tags_json ?? null, toIsoTimestampOrNull(targetContour.updated_at), id);

        await supersedePendingUserEdits(targetOsmType, targetOsmId, item.updatedBy, id);
      });

      await tx();
      return getUserEditDetailsById(id);
    }

    const sourceMerged = await getMergedInfoRow(item.osmType, item.osmId);
    if (!sourceMerged) {
      throw new Error('Merged local data for this edit was not found');
    }
    const targetMerged = await getMergedInfoRow(targetOsmType, targetOsmId);
    const { merged, conflicts } = mergeLocalInfoForReassign(sourceMerged, targetMerged, { force });
    if (conflicts.length > 0) {
      throw new Error(`Target building already contains conflicting local fields: ${conflicts.join(', ')}`);
    }

    const tx = db.transaction(async () => {
      await db.prepare(`
        INSERT INTO local.architectural_info (
          osm_type, osm_id, name, style, design, design_ref, design_year, material, material_concrete, roof_shape, colour, levels, year_built, architect, address, archimap_description, updated_by, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
        ON CONFLICT(osm_type, osm_id) DO UPDATE SET
          name = excluded.name,
          style = excluded.style,
          design = excluded.design,
          design_ref = excluded.design_ref,
          design_year = excluded.design_year,
          material = excluded.material,
          material_concrete = excluded.material_concrete,
          roof_shape = excluded.roof_shape,
          colour = excluded.colour,
          levels = excluded.levels,
          year_built = excluded.year_built,
          architect = excluded.architect,
          address = excluded.address,
          archimap_description = excluded.archimap_description,
          updated_by = excluded.updated_by,
          updated_at = datetime('now')
      `).run(
        targetOsmType,
        targetOsmId,
        merged.name ?? null,
        merged.style ?? null,
        merged.design ?? null,
        merged.design_ref ?? null,
        merged.design_year ?? null,
        merged.material ?? null,
        merged.material_concrete ?? null,
        merged.roof_shape ?? null,
        merged.colour ?? null,
        merged.levels ?? null,
        merged.year_built ?? null,
        merged.architect ?? null,
        merged.address ?? null,
        merged.archimap_description ?? null,
        actor
      );

      await db.prepare(`
        DELETE FROM local.architectural_info
        WHERE osm_type = ? AND osm_id = ?
      `).run(item.osmType, item.osmId);

      await db.prepare(`
        UPDATE user_edits.building_user_edits
        SET
          osm_type = ?,
          osm_id = ?,
          updated_at = datetime('now')
        WHERE osm_type = ?
          AND osm_id = ?
          AND status IN ('accepted', 'partially_accepted')
      `).run(targetOsmType, targetOsmId, item.osmType, item.osmId);
    });

    await tx();
    return getUserEditDetailsById(id);
  }

  async function deleteUserEdit(editId) {
    const id = Number(editId);
    if (!Number.isInteger(id) || id <= 0) {
      throw new Error('Invalid edit id');
    }

    const tx = db.transaction(async () => {
      const row = await db.prepare(`
        SELECT id, osm_type, osm_id, status
        FROM user_edits.building_user_edits
        WHERE id = ?
        LIMIT 1
      `).get(id);

      if (!row) {
        const error = new Error('Edit not found');
        error.code = 'EDIT_NOT_FOUND';
        throw error;
      }

      const status = normalizeUserEditStatus(row.status);
      assertMutableSyncStatus((await getUserEditDetailsById(id))?.syncStatus);
      const deletesMergedLocal = MERGED_EDIT_STATUSES.has(status);
      if (deletesMergedLocal) {
        const otherMergedCount = await countMergedEditsForTarget(row.osm_type, row.osm_id, id);
        if (otherMergedCount > 0) {
          const error = new Error('Cannot fully delete an accepted edit while the building still has other accepted/partially_accepted edits because merged local data is already shared.');
          error.code = 'EDIT_DELETE_SHARED_MERGED_STATE';
          throw error;
        }

        await db.prepare(`
          DELETE FROM local.architectural_info
          WHERE osm_type = ? AND osm_id = ?
        `).run(row.osm_type, row.osm_id);
      }

      const result = await db.prepare(`
        DELETE FROM user_edits.building_user_edits
        WHERE id = ?
      `).run(id);

      if (Number(result?.changes || 0) === 0) {
        const error = new Error('Edit not found');
        error.code = 'EDIT_NOT_FOUND';
        throw error;
      }

      return {
        editId: id,
        osmType: row.osm_type,
        osmId: Number(row.osm_id),
        status,
        deletedMergedLocal: deletesMergedLocal
      };
    });

    return tx();
  }

  async function withdrawPendingUserEdit(editId, actor) {
    const id = Number(editId);
    if (!Number.isInteger(id) || id <= 0) {
      const error = new Error('Invalid edit id');
      error.status = 400;
      error.code = 'ERR_INVALID_EDIT_ID';
      throw error;
    }

    const owner = String(actor || '').trim().toLowerCase();
    if (!owner) {
      const error = new Error('Failed to resolve current user');
      error.status = 400;
      error.code = 'ERR_CURRENT_USER_UNRESOLVED';
      throw error;
    }

    const tx = db.transaction(async () => {
      const row = await db.prepare(`
        SELECT id, osm_type, osm_id, created_by, status, sync_status
        FROM user_edits.building_user_edits
        WHERE id = ?
        LIMIT 1
      `).get(id);

      if (!row) {
        const error = new Error('Edit not found');
        error.status = 404;
        error.code = 'EDIT_NOT_FOUND';
        throw error;
      }

      if (String(row.created_by || '').trim().toLowerCase() !== owner) {
        const error = new Error('You can only cancel your own pending edits');
        error.status = 403;
        error.code = 'EDIT_ACCESS_DENIED';
        throw error;
      }

      const status = normalizeUserEditStatus(row.status);
      if (status !== 'pending') {
        const error = new Error('This edit is no longer pending review.');
        error.status = 409;
        error.code = 'EDIT_NOT_PENDING';
        throw error;
      }

      assertMutableSyncStatus(row.sync_status);

      const result = await db.prepare(`
        DELETE FROM user_edits.building_user_edits
        WHERE id = ?
          AND lower(trim(created_by)) = ?
          AND status = 'pending'
      `).run(id, owner);

      if (Number(result?.changes || 0) === 0) {
        const error = new Error('Edit not found');
        error.status = 404;
        error.code = 'EDIT_NOT_FOUND';
        throw error;
      }

      return {
        editId: id,
        osmType: row.osm_type,
        osmId: Number(row.osm_id),
        status: 'pending',
        deletedMergedLocal: false
      };
    });

    return tx();
  }

  return {
    deleteUserEdit,
    reassignUserEdit,
    withdrawPendingUserEdit
  };
}

module.exports = {
  createBuildingEditModerationService
};
