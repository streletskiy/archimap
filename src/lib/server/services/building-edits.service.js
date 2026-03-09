const { sanitizeEditedFields } = require('./edits.service');

function createBuildingEditsService({ db, normalizeUserEditStatus }) {
  const isPostgres = db.provider === 'postgres';
  const REASSIGNABLE_EDIT_STATUSES = new Set(['pending', 'accepted', 'partially_accepted']);
  const MERGED_EDIT_STATUSES = new Set(['accepted', 'partially_accepted']);
  const MERGED_EDITS_FOR_TARGET_SQL = `
        (
          SELECT COUNT(*)
          FROM user_edits.building_user_edits ue2
          WHERE ue2.osm_type = ue.osm_type
            AND ue2.osm_id = ue.osm_id
            AND ue2.status IN ('accepted', 'partially_accepted')
        ) AS merged_edits_for_target`;
  const BASE_USER_EDITS_SUMMARY_SELECT = `
      SELECT
        ue.id,
        ue.osm_type,
        ue.osm_id,
        ue.created_by,
        ue.updated_at,
        ue.created_at,
        ue.status,
        bc.osm_id AS contour_osm_id,
        ${MERGED_EDITS_FOR_TARGET_SQL}
  `;
  const BASE_USER_EDITS_SELECT = `
      SELECT
        ue.*,
        bc.osm_id AS contour_osm_id,
        bc.tags_json,
        bc.updated_at AS current_osm_updated_at,
        ${MERGED_EDITS_FOR_TARGET_SQL},
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
  `;
  const BASE_USER_EDITS_SUMMARY_JOINS = `
      FROM user_edits.building_user_edits ue
      LEFT JOIN osm.building_contours bc
        ON bc.osm_type = ue.osm_type AND bc.osm_id = ue.osm_id
  `;
  const BASE_USER_EDITS_JOINS = `
      FROM user_edits.building_user_edits ue
      LEFT JOIN osm.building_contours bc
        ON bc.osm_type = ue.osm_type AND bc.osm_id = ue.osm_id
      LEFT JOIN local.architectural_info ai
        ON ai.osm_type = ue.osm_type AND ai.osm_id = ue.osm_id
  `;
  const USER_EDITS_ORDER_BY_SQL = 'ORDER BY ue.updated_at DESC, ue.id DESC';

  function normalizeInfoForDiff(value) {
    if (value == null) return null;
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    const text = String(value).trim();
    return text ? text : null;
  }

  function normalizeComparableForField(fieldKey, value) {
    const normalized = normalizeInfoForDiff(value);
    if (normalized == null) return null;

    const key = String(fieldKey || '').trim();
    if (key === 'levels' || key === 'year_built') {
      const text = String(normalized).trim();
      if (/^-?\d+(?:\.\d+)?$/.test(text)) {
        const num = Number(text);
        if (Number.isFinite(num)) return String(num);
      }
      return text;
    }

    return normalized;
  }

  function pickTagValue(tags, keys) {
    for (const key of keys) {
      const value = normalizeInfoForDiff(tags?.[key]);
      if (value != null) return value;
    }
    return null;
  }

  function osmAddressFromTags(tags) {
    const full = pickTagValue(tags, ['addr:full']);
    if (full != null) return full;
    const parts = [
      pickTagValue(tags, ['addr:postcode', 'addr_postcode']),
      pickTagValue(tags, ['addr:city', 'addr_city']),
      pickTagValue(tags, ['addr:place', 'addr_place']),
      pickTagValue(tags, ['addr:street', 'addr_street', 'addr_stree'])
    ].filter((value) => value != null);
    const house = pickTagValue(tags, ['addr:housenumber', 'addr_housenumber', 'addr_hous']);
    if (house != null) {
      if (parts.length > 0) {
        parts[parts.length - 1] = `${parts[parts.length - 1]}, ${house}`;
      } else {
        parts.push(house);
      }
    }
    return parts.length > 0 ? parts.join(', ') : null;
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

  function getEditedFieldsFromRow(row) {
    const fields = sanitizeEditedFields(row?.edited_fields_json);
    return fields.length > 0 ? fields : null;
  }

  function applyUserEditRowToInfo(baseInfo, row) {
    if (!row) return baseInfo || null;
    const next = baseInfo && typeof baseInfo === 'object' ? { ...baseInfo } : {};
    const editedFields = getEditedFieldsFromRow(row) || [...ARCHI_FIELD_SET];

    next.osm_type = row.osm_type ?? next.osm_type ?? null;
    next.osm_id = row.osm_id ?? next.osm_id ?? null;
    next.updated_by = row.created_by ?? row.updated_by ?? next.updated_by ?? null;
    next.updated_at = row.updated_at ?? next.updated_at ?? null;
    next.review_status = normalizeUserEditStatus(row.status);
    next.admin_comment = row.admin_comment ?? next.admin_comment ?? null;
    next.user_edit_id = Number.isInteger(Number(row.id)) && Number(row.id) > 0
      ? Number(row.id)
      : (next.user_edit_id ?? null);

    for (const field of editedFields) {
      if (field === 'archimap_description') {
        next.archimap_description = row.archimap_description ?? null;
        next.description = row.archimap_description ?? null;
        continue;
      }
      next[field] = row[field] ?? null;
    }

    return next;
  }

  async function getMergedInfoRow(osmType, osmId) {
    return await db.prepare(`
      SELECT osm_type, osm_id, name, style, levels, year_built, architect, address, description, archimap_description, updated_by, updated_at
      FROM local.architectural_info
      WHERE osm_type = ? AND osm_id = ?
    `).get(osmType, osmId) || null;
  }

  async function getOsmContourRow(osmType, osmId) {
    return await db.prepare(`
      SELECT osm_type, osm_id, tags_json, updated_at
      FROM osm.building_contours
      WHERE osm_type = ? AND osm_id = ?
      LIMIT 1
    `).get(osmType, osmId) || null;
  }

  async function countMergedEditsForTarget(osmType, osmId, excludeEditId = null) {
    const excludedId = Number(excludeEditId);
    const hasExcludedId = Number.isInteger(excludedId) && excludedId > 0;
    const row = await db.prepare(`
      SELECT COUNT(*) AS total
      FROM user_edits.building_user_edits
      WHERE osm_type = ?
        AND osm_id = ?
        AND status IN ('accepted', 'partially_accepted')
        ${hasExcludedId ? 'AND id <> ?' : ''}
    `).get(...(hasExcludedId ? [osmType, osmId, excludedId] : [osmType, osmId])) || {};
    return Math.max(0, Number(row.total || 0));
  }

  async function getLatestUserEditRow(osmType, osmId, createdBy, statuses = null) {
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

    return await db.prepare(`
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

  async function supersedePendingUserEdits(osmType, osmId, createdBy, keepId = null) {
    const author = String(createdBy || '').trim().toLowerCase();
    if (!author) return;

    if (Number.isInteger(keepId) && keepId > 0) {
      await db.prepare(`
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

    await db.prepare(`
      UPDATE user_edits.building_user_edits
      SET status = 'superseded', updated_at = datetime('now')
      WHERE osm_type = ?
        AND osm_id = ?
        AND lower(trim(created_by)) = ?
        AND status = 'pending'
    `).run(osmType, osmId, author);
  }

  function buildChangesFromRows(editRow, tags, mergedRow = null) {
    const osmBaseline = {
      name: pickTagValue(tags, ['name', 'name:ru', 'official_name']),
      style: pickTagValue(tags, ['building:architecture', 'architecture', 'style']),
      levels: pickTagValue(tags, ['building:levels', 'levels']),
      year_built: pickTagValue(tags, ['building:year', 'start_date', 'construction_date', 'year_built']),
      architect: pickTagValue(tags, ['architect', 'architect_name']),
      address: osmAddressFromTags(tags),
      archimap_description: null
    };

    const mergedBaseline = mergedRow
      ? {
        name: normalizeInfoForDiff(mergedRow.name),
        style: normalizeInfoForDiff(mergedRow.style),
        levels: normalizeInfoForDiff(mergedRow.levels),
        year_built: normalizeInfoForDiff(mergedRow.year_built),
        architect: normalizeInfoForDiff(mergedRow.architect),
        address: normalizeInfoForDiff(mergedRow.address),
        archimap_description: normalizeInfoForDiff(mergedRow.archimap_description ?? mergedRow.description ?? null)
      }
      : null;

    const explicitEditedFields = getEditedFieldsFromRow(editRow);
    const fieldsToCompare = explicitEditedFields
      ? ARCHI_EDIT_FIELDS.filter((field) => explicitEditedFields.includes(field.key))
      : ARCHI_EDIT_FIELDS;

    const changes = [];
    for (const field of fieldsToCompare) {
      const baselineValue = mergedBaseline
        ? (mergedBaseline[field.key] ?? osmBaseline[field.key] ?? null)
        : (osmBaseline[field.key] ?? null);
      const localValue = normalizeInfoForDiff(editRow[field.key]);
      const baselineComparable = normalizeComparableForField(field.key, baselineValue);
      const localComparable = normalizeComparableForField(field.key, localValue);
      const differs = baselineComparable !== localComparable;
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

  function stableNormalizeJson(value) {
    if (Array.isArray(value)) {
      return value.map((item) => stableNormalizeJson(item));
    }
    if (!value || typeof value !== 'object') {
      return value;
    }
    const out = {};
    for (const key of Object.keys(value).sort()) {
      out[key] = stableNormalizeJson(value[key]);
    }
    return out;
  }

  function normalizeTagsFingerprint(raw) {
    return JSON.stringify(stableNormalizeJson(parseTagsJsonSafe(raw)));
  }

  function getSessionEditActorKey(req) {
    const email = String(req?.session?.user?.email || '').trim().toLowerCase();
    if (email) return email;
    const username = String(req?.session?.user?.username || '').trim().toLowerCase();
    return username || null;
  }

  function normalizeMergedInfoRow(row) {
    if (!row) return null;
    const hasMergedValue = row.name != null
      || row.style != null
      || row.levels != null
      || row.year_built != null
      || row.architect != null
      || row.address != null
      || row.description != null
      || row.archimap_description != null;
    if (!hasMergedValue) return null;

    return {
      name: row.name ?? null,
      style: row.style ?? null,
      levels: row.levels ?? null,
      year_built: row.year_built ?? null,
      architect: row.architect ?? null,
      address: row.address ?? null,
      description: row.description ?? null,
      archimap_description: row.archimap_description ?? null,
      updated_by: row.updated_by ?? null,
      updated_at: row.updated_at ?? null
    };
  }

  function getMergedInfoRowFromUserEditRow(row) {
    return normalizeMergedInfoRow({
      name: row?.merged_name,
      style: row?.merged_style,
      levels: row?.merged_levels,
      year_built: row?.merged_year_built,
      architect: row?.merged_architect,
      address: row?.merged_address,
      description: row?.merged_description,
      archimap_description: row?.merged_archimap_description,
      updated_by: row?.merged_updated_by,
      updated_at: row?.merged_updated_at
    });
  }

  function mapDetailedUserEditRow(row) {
    const tags = parseTagsJsonSafe(row?.source_tags_json || row?.tags_json);
    const mergedInfoRow = getMergedInfoRowFromUserEditRow(row);
    return {
      tags,
      mergedInfoRow,
      mapped: mapUserEditRow(row, tags, mergedInfoRow)
    };
  }

  function buildEditRuntimeState(row, mergedInfoRow = null) {
    const status = normalizeUserEditStatus(row?.status);
    const osmPresent = row?.contour_osm_id != null;
    const hasMergedLocal = Boolean(mergedInfoRow);
    const orphaned = !osmPresent && hasMergedLocal;
    const sourceOsmChanged = Boolean(
      osmPresent
      && row?.source_tags_json
      && normalizeTagsFingerprint(row.source_tags_json) !== normalizeTagsFingerprint(row.tags_json)
    );
    const mergedEditsForTarget = Math.max(0, Number(row?.merged_edits_for_target || 0));
    const canHardDelete = !MERGED_EDIT_STATUSES.has(status) || mergedEditsForTarget <= 1;
    const hardDeleteBlockedReason = canHardDelete
      ? null
      : 'merged_with_other_accepted_edits';

    return {
      status,
      osmPresent,
      orphaned,
      hasMergedLocal,
      sourceOsmChanged,
      canReassign: REASSIGNABLE_EDIT_STATUSES.has(status),
      canHardDelete,
      hardDeleteBlockedReason,
      mergedEditsForTarget
    };
  }

  function mapUserEditRow(row, tags, mergedInfoRow) {
    const runtimeState = buildEditRuntimeState(row, mergedInfoRow);
    const changes = buildChangesFromRows(row, tags, mergedInfoRow);
    const editedFields = getEditedFieldsFromRow(row);
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
      status: runtimeState.status,
      adminComment: row.admin_comment ?? null,
      reviewedBy: row.reviewed_by ?? null,
      reviewedAt: row.reviewed_at ?? null,
      mergedBy: row.merged_by ?? null,
      mergedAt: row.merged_at ?? null,
      osmPresent: runtimeState.osmPresent,
      orphaned: runtimeState.orphaned,
      hasMergedLocal: runtimeState.hasMergedLocal,
      sourceOsmChanged: runtimeState.sourceOsmChanged,
      canReassign: runtimeState.canReassign,
      canHardDelete: runtimeState.canHardDelete,
      hardDeleteBlockedReason: runtimeState.hardDeleteBlockedReason,
      mergedEditsForTarget: runtimeState.mergedEditsForTarget,
      sourceOsmUpdatedAt: row.source_osm_updated_at ?? null,
      currentOsmUpdatedAt: row.current_osm_updated_at ?? null,
      editedFields,
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

  async function getUserEditsList({ createdBy = null, status = null, limit = 2000, summary = false }) {
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

    if (summary) {
      const rows = await db.prepare(`
      ${BASE_USER_EDITS_SUMMARY_SELECT}
      ${BASE_USER_EDITS_SUMMARY_JOINS}
      ${whereSql}
      ${USER_EDITS_ORDER_BY_SQL}
      LIMIT ?
    `).all(...params, cap);

      return rows.map((row) => ({
        id: Number(row.id || 0),
        editId: Number(row.id || 0),
        osmType: row.osm_type,
        osmId: row.osm_id,
        updatedBy: row.created_by,
        updatedAt: row.updated_at,
        createdAt: row.created_at,
        status: normalizeUserEditStatus(row.status),
        osmPresent: row.contour_osm_id != null
      }));
    }

    const rows = await db.prepare(`
      ${BASE_USER_EDITS_SELECT}
      ${BASE_USER_EDITS_JOINS}
      ${whereSql}
      ${USER_EDITS_ORDER_BY_SQL}
      LIMIT ?
    `).all(...params, cap);

    const out = [];
    for (const row of rows) {
      out.push(mapDetailedUserEditRow(row).mapped);
    }
    return out;
  }

  async function getUserEditDetailsById(editId) {
    const id = Number(editId);
    if (!Number.isInteger(id) || id <= 0) return null;

    const row = await db.prepare(`
      ${BASE_USER_EDITS_SELECT}
      ${BASE_USER_EDITS_JOINS}
      WHERE ue.id = ?
      LIMIT 1
    `).get(id);

    if (!row) return null;

    const { mapped, tags, mergedInfoRow } = mapDetailedUserEditRow(row);
    mapped.tags = tags;
    mapped.currentTags = parseTagsJsonSafe(row.tags_json);
    mapped.sourceTags = parseTagsJsonSafe(row.source_tags_json);
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

  async function getUserPersonalEditsByKeys(actorKey, keys, statuses = ['pending', 'rejected']) {
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
      .map((f) => String(f?.id || f?.properties?.osm_key || ''))
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
    ARCHI_EDIT_FIELDS,
    ARCHI_FIELD_SET,
    getMergedInfoRow,
    getOsmContourRow,
    getLatestUserEditRow,
    supersedePendingUserEdits,
    getSessionEditActorKey,
    applyUserEditRowToInfo,
    getUserEditsList,
    getUserEditDetailsById,
    reassignUserEdit,
    deleteUserEdit,
    getUserPersonalEditsByKeys,
    mergePersonalEditsIntoFeatureInfo,
    applyPersonalEditsToFilterItems
  };
}

module.exports = {
  createBuildingEditsService
};
