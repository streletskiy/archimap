function createBuildingEditModerationService(context, { getUserEditDetailsById }) {
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

  function mergeLocalInfoForReassign(sourceRow, targetRow, { force = false } = {}) {
    const fields = ['name', 'style', 'levels', 'year_built', 'architect', 'address', 'archimap_description'];
    const conflicts = [];
    const merged = {};

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

  async function reassignUserEdit(editId, target, options = {}) {
    const id = Number(editId);
    if (!Number.isInteger(id) || id <= 0) {
      throw new Error('Некорректный идентификатор правки');
    }

    const targetOsmType = String(target?.osmType || '').trim();
    const targetOsmId = Number(target?.osmId);
    if (!['way', 'relation'].includes(targetOsmType) || !Number.isInteger(targetOsmId) || targetOsmId <= 0) {
      throw new Error('Некорректный идентификатор целевого здания');
    }

    const actor = String(options.actor || '').trim() || 'admin';
    const force = Boolean(options.force);
    const item = await getUserEditDetailsById(id);
    if (!item) {
      throw new Error('Правка не найдена');
    }
    if (!REASSIGNABLE_EDIT_STATUSES.has(item.status)) {
      throw new Error('Эту правку нельзя переназначить');
    }

    const targetContour = await getOsmContourRow(targetOsmType, targetOsmId);
    if (!targetContour) {
      throw new Error('Целевое здание не найдено в локальной базе контуров');
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
        `).run(targetOsmType, targetOsmId, targetContour.tags_json ?? null, targetContour.updated_at ?? null, id);

        await supersedePendingUserEdits(targetOsmType, targetOsmId, item.updatedBy, id);
      });

      await tx();
      return getUserEditDetailsById(id);
    }

    const sourceMerged = await getMergedInfoRow(item.osmType, item.osmId);
    if (!sourceMerged) {
      throw new Error('Локальные объединённые данные для этой правки не найдены');
    }
    const targetMerged = await getMergedInfoRow(targetOsmType, targetOsmId);
    const { merged, conflicts } = mergeLocalInfoForReassign(sourceMerged, targetMerged, { force });
    if (conflicts.length > 0) {
      throw new Error(`Целевое здание уже содержит конфликтующие локальные поля: ${conflicts.join(', ')}`);
    }

    const tx = db.transaction(async () => {
      await db.prepare(`
        INSERT INTO local.architectural_info (
          osm_type, osm_id, name, style, levels, year_built, architect, address, archimap_description, updated_by, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
        ON CONFLICT(osm_type, osm_id) DO UPDATE SET
          name = excluded.name,
          style = excluded.style,
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
      throw new Error('Некорректный идентификатор правки');
    }

    const tx = db.transaction(async () => {
      const row = await db.prepare(`
        SELECT id, osm_type, osm_id, status
        FROM user_edits.building_user_edits
        WHERE id = ?
        LIMIT 1
      `).get(id);

      if (!row) {
        const error = new Error('Правка не найдена');
        error.code = 'EDIT_NOT_FOUND';
        throw error;
      }

      const status = normalizeUserEditStatus(row.status);
      const deletesMergedLocal = MERGED_EDIT_STATUSES.has(status);
      if (deletesMergedLocal) {
        const otherMergedCount = await countMergedEditsForTarget(row.osm_type, row.osm_id, id);
        if (otherMergedCount > 0) {
          const error = new Error('Нельзя полностью удалить принятую правку, пока у здания есть другие accepted/partially_accepted правки: локальные merged-данные уже общие.');
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
        const error = new Error('Правка не найдена');
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

  return {
    deleteUserEdit,
    reassignUserEdit
  };
}

module.exports = {
  createBuildingEditModerationService
};
