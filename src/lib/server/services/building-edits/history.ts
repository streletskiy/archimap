import type { BuildingEdit, BuildingEditSummary } from '$shared/types';

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

  function normalizeDateInput(raw) {
    const text = String(raw || '').trim();
    if (!text) return '';
    const match = text.match(/^\d{4}-\d{2}-\d{2}/);
    return match ? match[0] : '';
  }

  function buildUserEditsWhereParts({
    createdBy = null,
    status = null,
    sync = '',
    q = '',
    createdFrom = '',
    createdTo = ''
  } = {}) {
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

    const normalizedSync = String(sync || '')
      .trim()
      .toLowerCase();
    if (normalizedSync === 'active') {
      clauses.push("COALESCE(lower(trim(ue.sync_status)), 'unsynced') NOT IN ('synced', 'cleaned')");
    } else if (normalizedSync === 'archived') {
      clauses.push("COALESCE(lower(trim(ue.sync_status)), 'unsynced') IN ('synced', 'cleaned')");
    }

    const query = String(q || '').trim().toLowerCase();
    if (query) {
      const pattern = `%${query}%`;
      clauses.push(`(
        lower(ue.osm_type || '/' || CAST(ue.osm_id AS TEXT)) LIKE ?
        OR lower(COALESCE(trim(ai.address), trim(ue.address), '')) LIKE ?
      )`);
      params.push(pattern, pattern);
    }

    const from = normalizeDateInput(createdFrom);
    if (from) {
      clauses.push('date(ue.created_at) >= ?');
      params.push(from);
    }

    const to = normalizeDateInput(createdTo);
    if (to) {
      clauses.push('date(ue.created_at) <= ?');
      params.push(to);
    }

    return {
      whereSql: clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '',
      params
    };
  }

  function buildFilteredUserEditsSql(whereSql) {
    return `
      ${BASE_USER_EDITS_SELECT}
      ${BASE_USER_EDITS_JOINS}
      ${whereSql}
    `;
  }

  async function listFilteredUserEditAuthors({
    status = null,
    sync = '',
    q = '',
    createdFrom = '',
    createdTo = ''
  } = {}) {
    const { whereSql, params } = buildUserEditsWhereParts({
      status,
      sync,
      q,
      createdFrom,
      createdTo
    });
    const rows = await db.prepare(`
      WITH filtered AS (
        ${buildFilteredUserEditsSql(whereSql)}
      )
      SELECT DISTINCT lower(trim(created_by)) AS created_by
      FROM filtered
      WHERE trim(created_by) <> ''
      ORDER BY created_by ASC
    `).all(...params);

    return rows
      .map((row) => String(row.created_by || '').trim())
      .filter(Boolean);
  }

  async function getUserEditsList(
    { createdBy = null, status = null, limit = 2000, summary = false }: {
      createdBy?: string | null;
      status?: string | null;
      limit?: number;
      summary?: boolean;
    } = {}
  ): Promise<Array<BuildingEditSummary | BuildingEdit>> {
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

  async function getUserEditsPage(
    {
      createdBy = null,
      status = null,
      sync = '',
      q = '',
      createdFrom = '',
      createdTo = '',
      limit = 20,
      offset = 0
    }: {
      createdBy?: string | null;
      status?: string | null;
      sync?: string | null;
      q?: string | null;
      createdFrom?: string | null;
      createdTo?: string | null;
      limit?: number;
      offset?: number;
    } = {}
  ): Promise<{ total: number; items: BuildingEdit[] }> {
    const cap = Math.max(1, Math.min(100, Number(limit) || 20));
    const off = Math.max(0, Math.trunc(Number(offset) || 0));
    const { whereSql, params } = buildUserEditsWhereParts({
      createdBy,
      status,
      sync,
      q,
      createdFrom,
      createdTo
    });

    const filteredSql = buildFilteredUserEditsSql(whereSql);
    const countRow = await db.prepare(`
      WITH filtered AS (
        ${filteredSql}
      )
      SELECT COUNT(*) AS total
      FROM (
        SELECT 1
        FROM filtered
        GROUP BY osm_type, osm_id
      ) grouped
    `).get(...params);

    const rows = await db.prepare(`
      WITH filtered AS (
        ${filteredSql}
      ),
      page_groups AS (
        SELECT
          osm_type,
          osm_id,
          MAX(created_at) AS latest_created_at,
          MAX(id) AS latest_edit_id
        FROM filtered
        GROUP BY osm_type, osm_id
        ORDER BY latest_created_at DESC, latest_edit_id DESC, osm_type ASC, osm_id ASC
        LIMIT ? OFFSET ?
      )
      SELECT filtered.*
      FROM filtered
      INNER JOIN page_groups
        ON page_groups.osm_type = filtered.osm_type
       AND page_groups.osm_id = filtered.osm_id
      ORDER BY page_groups.latest_created_at DESC, filtered.created_at DESC, filtered.id DESC
    `).all(...params, cap, off);

    return {
      total: Math.max(0, Number(countRow?.total || 0)),
      items: rows.map((row) => mapDetailedUserEditRow(row).mapped)
    };
  }

  async function getUserEditsPageRaw(
    {
      createdBy = null,
      status = null,
      sync = '',
      q = '',
      createdFrom = '',
      createdTo = '',
      limit = 20,
      page = 1
    } = {}
  ): Promise<{ total: number; page: number; pageSize: number; pageCount: number; items: BuildingEdit[]; authors: string[] }> {
    const cap = Math.max(1, Math.min(100, Number(limit) || 20));
    const currentPage = Math.max(1, Math.trunc(Number(page) || 1));
    const offset = (currentPage - 1) * cap;
    const { whereSql, params } = buildUserEditsWhereParts({
      createdBy,
      status,
      sync,
      q,
      createdFrom,
      createdTo
    });

    const filteredSql = buildFilteredUserEditsSql(whereSql);
    const countRow = await db.prepare(`
      WITH filtered AS (
        ${filteredSql}
      )
      SELECT COUNT(*) AS total
      FROM filtered
    `).get(...params);

    const rows = await db.prepare(`
      ${filteredSql}
      ${USER_EDITS_ORDER_BY_SQL}
      LIMIT ? OFFSET ?
    `).all(...params, cap, offset);

    const total = Math.max(0, Number(countRow?.total || 0));
    const pageCount = total > 0 ? Math.ceil(total / cap) : 0;
    const authors = await listFilteredUserEditAuthors({
      status,
      q,
      createdFrom,
      createdTo
    });

    return {
      total,
      page: currentPage,
      pageSize: cap,
      pageCount,
      items: rows.map((row) => mapDetailedUserEditRow(row).mapped),
      authors
    };
  }

  async function getUserEditDetailsById(editId): Promise<BuildingEdit | null> {
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
        design: mergedInfoRow.design ?? null,
        design_ref: mergedInfoRow.design_ref ?? null,
        design_year: mergedInfoRow.design_year ?? null,
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
    getUserEditsPage,
    getUserEditsPageRaw,
    getUserEditsList
  };
}

module.exports = {
  createBuildingEditHistoryService
};
