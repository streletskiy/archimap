function normalizeNullable(value) {
  return value === undefined ? null : value;
}

function normalizeOsmTypeId(osmType, osmId) {
  const type = String(osmType || '').trim();
  const id = Number(osmId);
  if (!['way', 'relation'].includes(type) || !Number.isInteger(id) || id <= 0) {
    return null;
  }
  return { osmType: type, osmId: id };
}

function normalizeOsmKey(rawKey) {
  if (typeof rawKey === 'string') {
    const [osmType, osmId] = rawKey.split('/');
    return normalizeOsmTypeId(osmType, osmId);
  }
  if (rawKey && typeof rawKey === 'object') {
    return normalizeOsmTypeId(rawKey.osmType ?? rawKey.osm_type, rawKey.osmId ?? rawKey.osm_id);
  }
  return null;
}

function createBuildingsRepository({ db }: LooseRecord = {}) {
  if (!db) {
    throw new Error('createBuildingsRepository: db is required');
  }

  const isPostgres = db.provider === 'postgres';
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

  const selectBuildingRegionSlugsById = db.prepare(`
    SELECT region.slug
    FROM data_region_memberships membership
    INNER JOIN data_sync_regions region
      ON region.id = membership.region_id
    WHERE membership.osm_type = ? AND membership.osm_id = ?
    ORDER BY LENGTH(region.slug) DESC, region.slug ASC
  `);

  const updatePendingUserEditSql = `
    UPDATE user_edits.building_user_edits
    SET
      source_osm_version = @source_osm_version,
      name = @name,
      style = @style,
      design = @design,
      design_ref = @design_ref,
      design_year = @design_year,
      material = @material,
      material_concrete = @material_concrete,
      colour = @colour,
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
      sync_status = 'unsynced',
      sync_attempted_at = NULL,
      sync_succeeded_at = NULL,
      sync_cleaned_at = NULL,
      sync_changeset_id = NULL,
      sync_summary_json = NULL,
      sync_error_text = NULL,
      updated_at = datetime('now')
    WHERE id = @id
  `;

  const insertPendingUserEditSql = isPostgres
    ? `
      INSERT INTO user_edits.building_user_edits (
        osm_type, osm_id, created_by, source_osm_version,
        name, style, design, design_ref, design_year, material, material_concrete, colour, levels, year_built, architect, address, archimap_description, edited_fields_json, source_tags_json, source_osm_updated_at,
        status, sync_status, created_at, updated_at
      )
      VALUES (
        @osm_type, @osm_id, @created_by, @source_osm_version,
        @name, @style, @design, @design_ref, @design_year, @material, @material_concrete, @colour, @levels, @year_built, @architect, @address, @archimap_description, @edited_fields_json, @source_tags_json, @source_osm_updated_at,
        'pending', 'unsynced', datetime('now'), datetime('now')
      )
      RETURNING id
    `
    : `
      INSERT INTO user_edits.building_user_edits (
        osm_type, osm_id, created_by, source_osm_version,
        name, style, design, design_ref, design_year, material, material_concrete, colour, levels, year_built, architect, address, archimap_description, edited_fields_json, source_tags_json, source_osm_updated_at,
        status, sync_status, created_at, updated_at
      )
      VALUES (
        @osm_type, @osm_id, @created_by, @source_osm_version,
        @name, @style, @design, @design_ref, @design_year, @material, @material_concrete, @colour, @levels, @year_built, @architect, @address, @archimap_description, @edited_fields_json, @source_tags_json, @source_osm_updated_at,
        'pending', 'unsynced', datetime('now'), datetime('now')
      )
    `;

  function buildPendingUserEditParams(values: LooseRecord = {}) {
    return {
      id: normalizeNullable(values.id),
      osm_type: normalizeNullable(values.osm_type),
      osm_id: normalizeNullable(values.osm_id),
      created_by: normalizeNullable(values.created_by),
      source_osm_version: normalizeNullable(values.source_osm_version),
      name: normalizeNullable(values.name),
      style: normalizeNullable(values.style),
      design: normalizeNullable(values.design),
      design_ref: normalizeNullable(values.design_ref),
      design_year: normalizeNullable(values.design_year),
      material: normalizeNullable(values.material),
      material_concrete: normalizeNullable(values.material_concrete),
      colour: normalizeNullable(values.colour),
      levels: normalizeNullable(values.levels),
      year_built: normalizeNullable(values.year_built),
      architect: normalizeNullable(values.architect),
      address: normalizeNullable(values.address),
      archimap_description: normalizeNullable(values.archimap_description),
      edited_fields_json: normalizeNullable(values.edited_fields_json),
      source_tags_json: normalizeNullable(values.source_tags_json),
      source_osm_updated_at: normalizeNullable(values.source_osm_updated_at)
    };
  }

  async function getBuildingById(osmType, osmId) {
    const normalized = normalizeOsmTypeId(osmType, osmId);
    if (!normalized) return null;
    return await selectBuildingById.get(normalized.osmType, normalized.osmId) || null;
  }

  async function getBuildingRegionSlugsById(osmType, osmId) {
    const normalized = normalizeOsmTypeId(osmType, osmId);
    if (!normalized) return [];
    return await selectBuildingRegionSlugsById.all(normalized.osmType, normalized.osmId);
  }

  async function getLocalArchitecturalInfoRowsByKeys(keys = [], chunkSize = 300) {
    const normalizedKeys = [];
    for (const rawKey of Array.isArray(keys) ? keys : []) {
      const normalized = normalizeOsmKey(rawKey);
      if (normalized) {
        normalizedKeys.push(normalized);
      }
    }

    if (normalizedKeys.length === 0) return [];

    const rows = [];
    const cap = Math.max(1, Math.min(1000, Number(chunkSize) || 300));
    for (let index = 0; index < normalizedKeys.length; index += cap) {
      const chunk = normalizedKeys.slice(index, index + cap);
      const clauses = chunk.map(() => '(osm_type = ? AND osm_id = ?)').join(' OR ');
      const params = [];
      for (const key of chunk) {
        params.push(key.osmType, key.osmId);
      }
      const chunkRows = await db.prepare(`
        SELECT osm_type, osm_id, name, style, design, design_ref, design_year, material, material_concrete, colour, levels, year_built, architect, address, description, archimap_description, updated_by, updated_at
        FROM local.architectural_info
        WHERE ${clauses}
      `).all(...params);
      rows.push(...chunkRows);
    }

    return rows;
  }

  async function updatePendingUserEditById(editId, values = {}) {
    const id = Number(editId);
    if (!Number.isInteger(id) || id <= 0) {
      throw new Error('updatePendingUserEditById: editId must be a positive integer');
    }

    await db.prepare(updatePendingUserEditSql).run({
      ...buildPendingUserEditParams(values),
      id
    });
  }

  async function insertPendingUserEdit(values = {}) {
    const preparedValues = buildPendingUserEditParams(values);
    const statement = db.prepare(insertPendingUserEditSql);
    const result = isPostgres
      ? await statement.get(preparedValues)
      : await statement.run(preparedValues);
    return Number(result?.id || result?.lastInsertRowid || 0);
  }

  return {
    getBuildingById,
    getBuildingRegionSlugsById,
    getLocalArchitecturalInfoRowsByKeys,
    insertPendingUserEdit,
    updatePendingUserEditById
  };
}

module.exports = {
  createBuildingsRepository
};
