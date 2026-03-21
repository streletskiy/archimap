function createBuildingEditHistoryService(context) {
  const {
    BASE_USER_EDITS_JOINS,
    BASE_USER_EDITS_SELECT,
    BASE_USER_EDITS_SUMMARY_JOINS,
    BASE_USER_EDITS_SUMMARY_SELECT,
    USER_EDITS_ORDER_BY_SQL,
    db,
    mapDetailedUserEditRow,
    normalizeUserEditStatus,
    parseTagsJsonSafe
  } = context;

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
        osmPresent: row.contour_osm_id != null,
        syncStatus: row.sync_status ?? 'unsynced',
        syncAttemptedAt: row.sync_attempted_at ?? null,
        syncSucceededAt: row.sync_succeeded_at ?? null,
        syncCleanedAt: row.sync_cleaned_at ?? null,
        syncChangesetId: row.sync_changeset_id ?? null
      }));
    }

    const rows = await db.prepare(`
      ${BASE_USER_EDITS_SELECT}
      ${BASE_USER_EDITS_JOINS}
      ${whereSql}
      ${USER_EDITS_ORDER_BY_SQL}
      LIMIT ?
    `).all(...params, cap);

    return rows.map((row) => mapDetailedUserEditRow(row).mapped);
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
        material: mergedInfoRow.material === 'concrete' && mergedInfoRow.material_concrete
          ? `concrete_${mergedInfoRow.material_concrete}`
          : (mergedInfoRow.material ?? null),
        material_raw: mergedInfoRow.material ?? null,
        material_concrete: mergedInfoRow.material_concrete ?? null,
        colour: mergedInfoRow.colour ?? null,
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

  return {
    getUserEditDetailsById,
    getUserEditsList
  };
}

module.exports = {
  createBuildingEditHistoryService
};
