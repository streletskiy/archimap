const {
  createAdminError,
  isLikelyEmail,
  parseLimit,
  parseOsmTarget,
  parsePositiveId
} = require('./shared');

function createAdminEditsService(options = {}) {
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
    ARCHI_FIELD_SET
  } = options;

  async function listBuildingEdits({ status, limit } = {}) {
    const statusRaw = String(status || '').trim().toLowerCase();
    const normalizedStatus = statusRaw === 'all' || !statusRaw ? null : normalizeUserEditStatus(statusRaw);
    const normalizedLimit = parseLimit(limit, 200, 1, 1000);
    return getUserEditsList({ status: normalizedStatus, limit: normalizedLimit, summary: false });
  }

  async function getBuildingEditDetails(editIdRaw) {
    const editId = parsePositiveId(editIdRaw);
    if (!editId) {
      throw createAdminError(400, 'Некорректный идентификатор правки');
    }
    const item = await getUserEditDetailsById(editId);
    if (!item) {
      throw createAdminError(404, 'Правка не найдена');
    }
    return item;
  }

  async function getUserByEmail(emailRaw) {
    const email = String(emailRaw || '').trim().toLowerCase();
    if (!isLikelyEmail(email)) {
      throw createAdminError(400, 'Некорректный email');
    }

    const row = await db.prepare(`
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
    `).get(email);
    if (!row) {
      throw createAdminError(404, 'Пользователь не найден');
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
    const email = String(emailRaw || '').trim().toLowerCase();
    if (!isLikelyEmail(email)) {
      throw createAdminError(400, 'Некорректный email');
    }
    const limit = parseLimit(limitRaw, 200, 1, 1000);
    return getUserEditsList({ createdBy: email, limit, summary: true });
  }

  async function rejectBuildingEdit(editIdRaw, { comment, reviewer } = {}) {
    const row = await getBuildingEditDetails(editIdRaw);
    if (normalizeUserEditStatus(row.status) !== 'pending') {
      throw createAdminError(409, 'Правка уже обработана');
    }

    const editId = parsePositiveId(editIdRaw);
    const adminComment = sanitizeFieldText(comment, 1200);
    const result = await db.prepare(`
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
    `).run(adminComment, reviewer || 'admin', editId);
    if (Number(result?.changes || 0) === 0) {
      throw createAdminError(409, 'Правка уже обработана другим администратором');
    }

    return {
      ok: true,
      editId,
      status: 'rejected'
    };
  }

  async function reassignBuildingEdit(editIdRaw, { target, actor, force } = {}) {
    const editId = parsePositiveId(editIdRaw);
    if (!editId) {
      throw createAdminError(400, 'Некорректный идентификатор правки');
    }

    const parsedTarget = parseOsmTarget(target);
    if (!parsedTarget) {
      throw createAdminError(400, 'Укажите корректный идентификатор целевого здания');
    }

    const before = await getUserEditDetailsById(editId);
    if (!before) {
      throw createAdminError(404, 'Правка не найдена');
    }

    try {
      const updated = await reassignUserEdit(editId, parsedTarget, {
        actor: actor || 'admin',
        force: Boolean(force === true)
      });
      if (before.osmType && Number.isInteger(Number(before.osmId))) {
        enqueueSearchIndexRefresh(before.osmType, before.osmId);
      }
      if (updated?.osmType && Number.isInteger(Number(updated.osmId))) {
        enqueueSearchIndexRefresh(updated.osmType, updated.osmId);
      }
      return updated;
    } catch (error) {
      const message = String(error?.message || error || 'Не удалось переназначить правку');
      if (message.includes('не найдена')) {
        throw createAdminError(404, message);
      }
      if (message.includes('конфликтующие локальные поля')) {
        throw createAdminError(409, message, { code: 'REASSIGN_TARGET_CONFLICT' });
      }
      throw createAdminError(400, message);
    }
  }

  async function deleteBuildingEdit(editIdRaw) {
    const editId = parsePositiveId(editIdRaw);
    if (!editId) {
      throw createAdminError(400, 'Некорректный идентификатор правки');
    }

    try {
      const deleted = await deleteUserEdit(editId);
      if (deleted?.osmType && Number.isInteger(Number(deleted.osmId))) {
        enqueueSearchIndexRefresh(deleted.osmType, deleted.osmId);
      }
      return deleted;
    } catch (error) {
      const message = String(error?.message || error || 'Не удалось удалить правку');
      if (error?.code === 'EDIT_NOT_FOUND' || message.includes('не найдена')) {
        throw createAdminError(404, message);
      }
      if (error?.code === 'EDIT_DELETE_SHARED_MERGED_STATE') {
        throw createAdminError(409, message, { code: error.code });
      }
      throw createAdminError(400, message);
    }
  }

  function sanitizeMergeValues(fieldsToMerge, valuesRaw) {
    const source = valuesRaw && typeof valuesRaw === 'object' ? valuesRaw : {};
    const sanitizedValues = {};

    for (const key of fieldsToMerge) {
      if (!Object.prototype.hasOwnProperty.call(source, key)) continue;
      if (key === 'year_built') {
        const parsedYearBuilt = sanitizeYearBuilt(source[key]);
        if (parsedYearBuilt == null && String(source[key] ?? '').trim() !== '') {
          throw createAdminError(400, 'Год постройки должен быть целым числом от 1000 до 2100');
        }
        sanitizedValues[key] = parsedYearBuilt;
        continue;
      }
      if (key === 'levels') {
        const parsedLevels = sanitizeLevels(source[key]);
        if (parsedLevels == null && String(source[key] ?? '').trim() !== '') {
          throw createAdminError(400, 'Этажность должна быть целым числом от 0 до 300');
        }
        sanitizedValues[key] = parsedLevels;
        continue;
      }
      sanitizedValues[key] = sanitizeFieldText(source[key], key === 'archimap_description' ? 1000 : 300);
    }

    return sanitizedValues;
  }

  async function buildMergedCandidate(item, editId) {
    const currentMerged = await getMergedInfoRow(item.osmType, item.osmId) || {};
    const editCreatedTs = item.createdAt ? Date.parse(String(item.createdAt)) : NaN;
    const currentMergedTs = currentMerged?.updated_at ? Date.parse(String(currentMerged.updated_at)) : NaN;

    return {
      currentMerged,
      editCreatedTs,
      currentMergedTs,
      editSource: await db.prepare(`
        SELECT name, style, levels, year_built, architect, address, archimap_description
        FROM user_edits.building_user_edits
        WHERE id = ?
        LIMIT 1
      `).get(editId) || {},
      mergedCandidate: {
        name: currentMerged.name ?? null,
        style: currentMerged.style ?? null,
        levels: currentMerged.levels ?? null,
        year_built: currentMerged.year_built ?? null,
        architect: currentMerged.architect ?? null,
        address: currentMerged.address ?? null,
        archimap_description: currentMerged.archimap_description ?? null
      }
    };
  }

  async function mergeBuildingEdit(editIdRaw, { force, fields, values, comment, reviewer } = {}) {
    const item = await getBuildingEditDetails(editIdRaw);
    if (normalizeUserEditStatus(item.status) !== 'pending') {
      throw createAdminError(409, 'Правка уже обработана');
    }

    const forceMerge = Boolean(force === true);
    const currentContour = await getOsmContourRow(item.osmType, item.osmId);
    if (!currentContour) {
      throw createAdminError(409, 'Исходное OSM-здание больше не существует в локальной базе контуров. Сначала переназначьте правку на актуальное здание.', {
        code: 'EDIT_TARGET_MISSING'
      });
    }
    if (!forceMerge && item.sourceOsmChanged) {
      throw createAdminError(409, 'Правка устарела: OSM-данные здания изменились после её создания. Обновите правку, переназначьте её или выполните merge с force.', {
        code: 'EDIT_OUTDATED_OSM',
        details: {
          currentUpdatedAt: item.currentOsmUpdatedAt || null,
          sourceUpdatedAt: item.sourceOsmUpdatedAt || null
        }
      });
    }

    const allowedFields = new Set((item.changes || []).map((change) => String(change.field || '')));
    if (allowedFields.size === 0) {
      throw createAdminError(409, 'В правке нет отличий от текущих данных');
    }

    const requestedFields = Array.isArray(fields)
      ? fields
        .map((value) => String(value || '').trim())
        .filter((key) => ARCHI_FIELD_SET.has(key) && allowedFields.has(key))
      : [];
    const fieldsToMerge = requestedFields.length > 0 ? [...new Set(requestedFields)] : [...allowedFields];
    const sanitizedValues = sanitizeMergeValues(fieldsToMerge, values);
    const editId = parsePositiveId(editIdRaw);
    const {
      currentMerged,
      editCreatedTs,
      currentMergedTs,
      editSource,
      mergedCandidate
    } = await buildMergedCandidate(item, editId);

    if (!forceMerge && Number.isFinite(editCreatedTs) && Number.isFinite(currentMergedTs) && currentMergedTs > editCreatedTs) {
      throw createAdminError(409, 'Правка устарела: данные здания были изменены после её создания. Обновите правку или выполните merge с force.', {
        code: 'EDIT_OUTDATED',
        details: {
          currentUpdatedAt: currentMerged.updated_at || null,
          editCreatedAt: item.createdAt || null
        }
      });
    }

    for (const field of fieldsToMerge) {
      mergedCandidate[field] = Object.prototype.hasOwnProperty.call(sanitizedValues, field)
        ? sanitizedValues[field]
        : (editSource[field] ?? null);
    }

    const normalizedReviewer = reviewer || 'admin';
    const adminComment = sanitizeFieldText(comment, 1200);
    const nextStatus = fieldsToMerge.length < allowedFields.size ? 'partially_accepted' : 'accepted';
    // Keep merge/update writes in one transaction to preserve legacy concurrency behaviour.
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
        item.osmType,
        item.osmId,
        mergedCandidate.name,
        mergedCandidate.style,
        mergedCandidate.levels,
        mergedCandidate.year_built,
        mergedCandidate.architect,
        mergedCandidate.address,
        mergedCandidate.archimap_description,
        normalizedReviewer
      );

      await db.prepare(`
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
      `).run(
        nextStatus,
        adminComment,
        normalizedReviewer,
        normalizedReviewer,
        JSON.stringify(fieldsToMerge),
        editId
      );
    });

    try {
      await tx();
    } catch {
      throw createAdminError(409, 'Не удалось применить merge: правка была изменена параллельно');
    }

    const updated = await db.prepare('SELECT status FROM user_edits.building_user_edits WHERE id = ?').get(editId);
    const normalizedStatus = normalizeUserEditStatus(updated?.status);
    if (!updated || (normalizedStatus !== 'accepted' && normalizedStatus !== 'partially_accepted')) {
      throw createAdminError(409, 'Правка уже обработана другим администратором');
    }

    enqueueSearchIndexRefresh(item.osmType, item.osmId);
    return {
      ok: true,
      editId,
      status: nextStatus,
      mergedFields: fieldsToMerge
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
    mergeBuildingEdit
  };
}

module.exports = {
  createAdminEditsService
};
