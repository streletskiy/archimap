function createStyleRegionOverrideError(status, message, options = {}) {
  const error = new Error(String(message || 'Style region override request failed'));
  error.status = Number(status) || 400;
  const fallbackCode = error.status === 404 ? 'ERR_STYLE_OVERRIDE_NOT_FOUND' : 'ERR_INVALID_INPUT';
  error.code = String(options.code || fallbackCode);
  return error;
}

function parseOverrideId(value) {
  const numeric = Number(value);
  if (!Number.isInteger(numeric) || numeric <= 0) return null;
  return numeric;
}

function normalizeRegionPattern(value) {
  const text = String(value || '').trim().toLowerCase();
  if (!text) {
    throw createStyleRegionOverrideError(400, 'Region pattern is required');
  }
  if (text.length > 160) {
    throw createStyleRegionOverrideError(400, 'Region pattern is too long');
  }
  if (!/^[a-z0-9*][a-z0-9*_-]*$/.test(text)) {
    throw createStyleRegionOverrideError(400, 'Region pattern may contain only latin letters, digits, "-", "_" and "*"');
  }
  return text;
}

function normalizeStyleKey(value) {
  const text = String(value || '').trim().toLowerCase();
  if (!text) {
    throw createStyleRegionOverrideError(400, 'Architecture style key is required');
  }
  if (text.length > 120) {
    throw createStyleRegionOverrideError(400, 'Architecture style key is too long');
  }
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(text)) {
    throw createStyleRegionOverrideError(400, 'Architecture style key has an invalid format');
  }
  return text;
}

function normalizeIsAllowed(value) {
  if (typeof value === 'boolean') return value;
  if (value === 1 || value === '1' || value === 'true') return true;
  if (value === 0 || value === '0' || value === 'false') return false;
  throw createStyleRegionOverrideError(400, 'Rule action must be either allow or deny');
}

function mapOverrideRow(row, { publicOnly = false } = {}) {
  if (!row || typeof row !== 'object') return null;
  const mapped = {
    id: Number(row.id || 0),
    region_pattern: String(row.region_pattern || '').trim(),
    style_key: String(row.style_key || '').trim(),
    is_allowed: Boolean(row.is_allowed)
  };
  if (!publicOnly) {
    mapped.created_at = row.created_at ? String(row.created_at) : null;
    mapped.updated_by = row.updated_by ? String(row.updated_by) : null;
  }
  return mapped;
}

function createStyleRegionOverridesService(options = {}) {
  const { db } = options;

  if (!db) {
    throw new Error('createStyleRegionOverridesService: db is required');
  }

  const selectAllOverrides = db.prepare(`
    SELECT id, region_pattern, style_key, is_allowed, created_at, updated_by
    FROM data_style_region_overrides
    ORDER BY style_key ASC, LENGTH(region_pattern) DESC, region_pattern ASC, id DESC
  `);

  const selectOverrideById = db.prepare(`
    SELECT id, region_pattern, style_key, is_allowed, created_at, updated_by
    FROM data_style_region_overrides
    WHERE id = ?
    LIMIT 1
  `);

  const selectOverrideByPatternAndStyle = db.prepare(`
    SELECT id
    FROM data_style_region_overrides
    WHERE region_pattern = ? AND style_key = ?
    LIMIT 1
  `);

  const insertOverride = db.prepare(`
    INSERT INTO data_style_region_overrides (
      region_pattern,
      style_key,
      is_allowed,
      created_at,
      updated_by
    )
    VALUES (?, ?, ?, datetime('now'), ?)
  `);

  const updateOverride = db.prepare(`
    UPDATE data_style_region_overrides
    SET
      is_allowed = ?,
      updated_by = ?
    WHERE id = ?
  `);

  const deleteOverrideById = db.prepare(`
    DELETE FROM data_style_region_overrides
    WHERE id = ?
  `);

  async function listOverridesForAdmin() {
    const rows = await selectAllOverrides.all();
    return (Array.isArray(rows) ? rows : []).map((row) => mapOverrideRow(row)).filter(Boolean);
  }

  async function listPublicOverrides() {
    const rows = await selectAllOverrides.all();
    return (Array.isArray(rows) ? rows : []).map((row) => mapOverrideRow(row, { publicOnly: true })).filter(Boolean);
  }

  async function saveOverride(input = {}, actor = null) {
    const normalized = {
      region_pattern: normalizeRegionPattern(input.region_pattern),
      style_key: normalizeStyleKey(input.style_key),
      is_allowed: normalizeIsAllowed(input.is_allowed),
      updated_by: String(actor || '').trim().toLowerCase() || null
    };
    const storedAllowedValue = db.provider === 'postgres'
      ? normalized.is_allowed
      : (normalized.is_allowed ? 1 : 0);

    const tx = db.transaction(async () => {
      const existing = await selectOverrideByPatternAndStyle.get(normalized.region_pattern, normalized.style_key);
      if (existing?.id) {
        await updateOverride.run(storedAllowedValue, normalized.updated_by, existing.id);
        return Number(existing.id);
      }

      const inserted = await insertOverride.run(
        normalized.region_pattern,
        normalized.style_key,
        storedAllowedValue,
        normalized.updated_by
      );
      return Number(inserted?.lastInsertRowid || 0);
    });

    const overrideId = await tx();
    const saved = await selectOverrideById.get(overrideId);
    return mapOverrideRow(saved);
  }

  async function deleteOverride(idRaw) {
    const overrideId = parseOverrideId(idRaw);
    if (!overrideId) {
      throw createStyleRegionOverrideError(400, 'Invalid override id');
    }

    const existing = await selectOverrideById.get(overrideId);
    if (!existing) {
      throw createStyleRegionOverrideError(404, 'Style region override not found');
    }

    await deleteOverrideById.run(overrideId);
    return mapOverrideRow(existing);
  }

  return {
    listOverridesForAdmin,
    listPublicOverrides,
    saveOverride,
    deleteOverride
  };
}

module.exports = {
  createStyleRegionOverridesService,
  createStyleRegionOverrideError
};
