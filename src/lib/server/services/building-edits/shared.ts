import type {
  BuildingEdit,
  BuildingEditFieldChange,
  BuildingEditMergedInfo
} from '$shared/types';

const { sanitizeEditedFields } = require('../edits.service');
const READ_ONLY_SYNC_STATUSES = new Set(['synced', 'cleaned']);

function assertMutableSyncStatus(syncStatusRaw) {
  const syncStatus = String(syncStatusRaw || 'unsynced').trim().toLowerCase();
  if (syncStatus === 'syncing') {
    const error = new Error('This edit is currently being synchronized and cannot be changed right now.');
    error.status = 409;
    error.code = 'EDIT_SYNC_IN_PROGRESS';
    throw error;
  }
  if (READ_ONLY_SYNC_STATUSES.has(syncStatus)) {
    const error = new Error('This edit has already been synchronized and can only be viewed.');
    error.status = 409;
    error.code = 'EDIT_SYNC_LOCKED';
    throw error;
  }
}

function createBuildingEditsContext({ db, normalizeUserEditStatus }) {
  if (!db) {
    throw new Error('createBuildingEditsContext: db is required');
  }
  if (typeof normalizeUserEditStatus !== 'function') {
    throw new Error('createBuildingEditsContext: normalizeUserEditStatus is required');
  }

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
        ue.sync_status,
        ue.sync_attempted_at,
        ue.sync_succeeded_at,
        ue.sync_cleaned_at,
        ue.sync_changeset_id,
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
        ai.design AS merged_design,
        ai.design_ref AS merged_design_ref,
        ai.design_year AS merged_design_year,
        ai.material AS merged_material,
        ai.material_concrete AS merged_material_concrete,
        ai.colour AS merged_colour,
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

  function normalizeMaterialSelection(material, materialConcrete = null) {
    const normalizedMaterial = normalizeInfoForDiff(material);
    const normalizedConcrete = normalizeInfoForDiff(materialConcrete);
    if (normalizedMaterial === 'concrete' && normalizedConcrete) {
      return `concrete_${String(normalizedConcrete)}`;
    }
    if (normalizedMaterial != null) return String(normalizedMaterial);
    return null;
  }

  function normalizeComparableForField(fieldKey, value) {
    const normalized = normalizeInfoForDiff(value);
    if (normalized == null) return null;

    const key = String(fieldKey || '').trim();
    if (key === 'levels' || key === 'year_built' || key === 'design_year') {
      const text = String(normalized).trim();
      if (/^-?\d+(?:\.\d+)?$/.test(text)) {
        const num = Number(text);
        if (Number.isFinite(num)) return String(num);
      }
      return text;
    }
    if (key === 'colour') {
      return String(normalized).trim().toLowerCase();
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
    if (full != null) return String(full);
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
    { key: 'levels', label: 'Этажей', osmTag: 'building:levels' },
    { key: 'year_built', label: 'Год постройки', osmTag: 'building:year | start_date | construction_date | year_built' },
    { key: 'architect', label: 'Архитектор', osmTag: 'architect' },
    { key: 'style', label: 'Архитектурный стиль', osmTag: 'building:architecture' },
    { key: 'design', label: 'Типовой проект', osmTag: 'design' },
    { key: 'design_ref', label: 'Номер проекта', osmTag: 'design:ref' },
    { key: 'design_year', label: 'Год проекта', osmTag: 'design:year' },
    { key: 'material', label: 'Материал', osmTag: 'building:material | material' },
    { key: 'colour', label: 'Цвет', osmTag: 'building:colour' },
    { key: 'archimap_description', label: 'Доп. информация', osmTag: null }
  ]);

  const ARCHI_FIELD_SET = new Set(ARCHI_EDIT_FIELDS.map((field) => field.key));

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
      if (field === 'material') {
        next.material = row.material ?? null;
        next.material_concrete = row.material_concrete ?? null;
        continue;
      }
      next[field] = row[field] ?? null;
    }

    return next;
  }

  async function getMergedInfoRow(osmType, osmId) {
    return await db.prepare(`
      SELECT osm_type, osm_id, name, style, design, design_ref, design_year, material, material_concrete, colour, levels, year_built, architect, address, description, archimap_description, updated_by, updated_at
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

  function buildChangesFromRows(editRow, tags): BuildingEditFieldChange[] {
    const osmBaseline = {
      name: pickTagValue(tags, ['name', 'name:ru', 'official_name']),
      style: pickTagValue(tags, ['building:architecture', 'architecture', 'style']),
      design: pickTagValue(tags, ['design']),
      design_ref: pickTagValue(tags, ['design:ref', 'design_ref']),
      design_year: pickTagValue(tags, ['design:year', 'design_year']),
      material: normalizeMaterialSelection(
        pickTagValue(tags, ['building:material', 'material']),
        pickTagValue(tags, ['building:material:concrete', 'material_concrete'])
      ),
      colour: pickTagValue(tags, ['building:colour', 'colour']),
      levels: pickTagValue(tags, ['building:levels', 'levels']),
      year_built: pickTagValue(tags, ['building:year', 'start_date', 'construction_date', 'year_built']),
      architect: pickTagValue(tags, ['architect', 'architect_name']),
      address: osmAddressFromTags(tags),
      archimap_description: null
    };

    const explicitEditedFields = getEditedFieldsFromRow(editRow);
    const fieldsToCompare = explicitEditedFields
      ? ARCHI_EDIT_FIELDS.filter((field) => explicitEditedFields.includes(field.key))
      : ARCHI_EDIT_FIELDS;

    const changes = [];
    for (const field of fieldsToCompare) {
      const baselineValue = osmBaseline[field.key] ?? null;
      const localValue = field.key === 'material'
        ? normalizeMaterialSelection(editRow.material, editRow.material_concrete)
        : normalizeInfoForDiff(editRow[field.key]);
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

  function normalizeMergedInfoRow(row): BuildingEditMergedInfo | null {
    if (!row) return null;
    const hasMergedValue = row.name != null
      || row.style != null
      || row.design != null
      || row.design_ref != null
      || row.design_year != null
      || row.material != null
      || row.material_concrete != null
      || row.colour != null
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
      design: row.design ?? null,
      design_ref: row.design_ref ?? null,
      design_year: row.design_year ?? null,
      material: row.material ?? null,
      material_concrete: row.material_concrete ?? null,
      colour: row.colour ?? null,
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

  function resolveDisplayAddressForRow(row, mergedInfoRow = null): string | null {
    const mergedAddress = normalizeInfoForDiff(mergedInfoRow?.address);
    if (mergedAddress != null) return String(mergedAddress);

    const rowAddress = normalizeInfoForDiff(row?.address);
    if (rowAddress != null) return String(rowAddress);

    const currentContourAddress = osmAddressFromTags(parseTagsJsonSafe(row?.tags_json));
    if (currentContourAddress != null) return String(currentContourAddress);

    const sourceContourAddress = osmAddressFromTags(parseTagsJsonSafe(row?.source_tags_json));
    if (sourceContourAddress != null) return String(sourceContourAddress);

    return null;
  }

  function getMergedInfoRowFromUserEditRow(row): BuildingEditMergedInfo | null {
    return normalizeMergedInfoRow({
      name: row?.merged_name,
      style: row?.merged_style,
      design: row?.merged_design,
      design_ref: row?.merged_design_ref,
      design_year: row?.merged_design_year,
      material: row?.merged_material,
      material_concrete: row?.merged_material_concrete,
      colour: row?.merged_colour,
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

  function buildEditRuntimeState(row, mergedInfoRow = null) {
    const status = normalizeUserEditStatus(row?.status);
    const syncStatus = String(row?.sync_status || 'unsynced').trim().toLowerCase();
    const syncReadOnly = READ_ONLY_SYNC_STATUSES.has(syncStatus);
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
      syncStatus,
      syncReadOnly,
      osmPresent,
      orphaned,
      hasMergedLocal,
      sourceOsmChanged,
      canReassign: REASSIGNABLE_EDIT_STATUSES.has(status) && !syncReadOnly,
      canHardDelete: !syncReadOnly && canHardDelete,
      hardDeleteBlockedReason,
      mergedEditsForTarget
    };
  }

  function mapUserEditRow(row, tags, mergedInfoRow): BuildingEdit {
    const runtimeState = buildEditRuntimeState(row, mergedInfoRow);
    const changes = buildChangesFromRows(row, tags);
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
      sourceOsmVersion: row.source_osm_version ?? null,
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
      syncStatus: runtimeState.syncStatus,
      syncReadOnly: runtimeState.syncReadOnly,
      syncAttemptedAt: row.sync_attempted_at ?? null,
      syncSucceededAt: row.sync_succeeded_at ?? null,
      syncCleanedAt: row.sync_cleaned_at ?? null,
      syncChangesetId: row.sync_changeset_id ?? null,
      syncSummary: row.sync_summary_json ? (() => {
        try {
          return JSON.parse(row.sync_summary_json);
        } catch {
          return null;
        }
      })() : null,
      syncError: row.sync_error_text ?? null,
      displayAddress: resolveDisplayAddressForRow(row, mergedInfoRow),
      editedFields,
      mergedFields,
      latestMerged: mergedInfoRow,
      values: {
        name: row.name ?? null,
        style: row.style ?? null,
        design: row.design ?? null,
        design_ref: row.design_ref ?? null,
        design_year: row.design_year ?? null,
        material: normalizeMaterialSelection(row.material, row.material_concrete),
        material_raw: row.material ?? null,
        material_concrete: row.material_concrete ?? null,
        colour: row.colour ?? null,
        levels: row.levels ?? null,
        year_built: row.year_built ?? null,
        architect: row.architect ?? null,
        address: row.address ?? null,
        archimap_description: row.archimap_description ?? null
      },
      changes
    };
  }

  function mapDetailedUserEditRow(row): {
    tags: Record<string, string>;
    mergedInfoRow: BuildingEditMergedInfo | null;
    mapped: BuildingEdit;
  } {
    const tags = parseTagsJsonSafe(row?.source_tags_json || row?.tags_json);
    const mergedInfoRow = getMergedInfoRowFromUserEditRow(row);
    return {
      tags,
      mergedInfoRow,
      mapped: mapUserEditRow(row, tags, mergedInfoRow)
    };
  }

  return {
    ARCHI_EDIT_FIELDS,
    ARCHI_FIELD_SET,
    BASE_USER_EDITS_JOINS,
    BASE_USER_EDITS_SELECT,
    BASE_USER_EDITS_SUMMARY_JOINS,
    BASE_USER_EDITS_SUMMARY_SELECT,
    MERGED_EDIT_STATUSES,
    REASSIGNABLE_EDIT_STATUSES,
    READ_ONLY_SYNC_STATUSES,
    USER_EDITS_ORDER_BY_SQL,
    assertMutableSyncStatus,
    applyUserEditRowToInfo,
    buildChangesFromRows,
    countMergedEditsForTarget,
    db,
    getEditedFieldsFromRow,
    getLatestUserEditRow,
    getMergedInfoRow,
    getOsmContourRow,
    getSessionEditActorKey,
    isPostgres,
    mapDetailedUserEditRow,
    normalizeComparableForField,
    normalizeInfoForDiff,
    normalizeMergedInfoRow,
    normalizeTagsFingerprint,
    normalizeUserEditStatus,
    parseTagsJsonSafe,
    supersedePendingUserEdits
  };
}

module.exports = {
  assertMutableSyncStatus,
  createBuildingEditsContext
};
