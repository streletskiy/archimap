const USER_EDIT_STATUS_VALUES = new Set(['pending', 'accepted', 'rejected', 'partially_accepted', 'superseded']);
const ARCHI_EDITED_FIELD_ALIASES = new Map([
  ['name', 'name'],
  ['style', 'style'],
  ['levels', 'levels'],
  ['yearbuilt', 'year_built'],
  ['year_built', 'year_built'],
  ['architect', 'architect'],
  ['address', 'address'],
  ['colour', 'colour'],
  ['color', 'colour'],
  ['archimapdescription', 'archimap_description'],
  ['archimap_description', 'archimap_description'],
  ['description', 'archimap_description']
]);

function normalizeUserEditStatus(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (USER_EDIT_STATUS_VALUES.has(normalized)) return normalized;
  return 'pending';
}

function sanitizeFieldText(value, maxLen = 500) {
  if (value == null) return null;
  const text = String(value).trim();
  if (!text) return null;
  return text.slice(0, maxLen);
}

function sanitizeYearBuilt(value) {
  if (value === null || value === undefined || String(value).trim() === '') return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1000 || parsed > 2100) return null;
  return parsed;
}

function sanitizeLevels(value) {
  if (value === null || value === undefined || String(value).trim() === '') return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 300) return null;
  return parsed;
}

function sanitizeArchiPayload(body) {
  const yearRaw = body?.yearBuilt ?? body?.year_built;
  const levelsRaw = body?.levels;
  const yearBuilt = sanitizeYearBuilt(yearRaw);
  const levels = sanitizeLevels(levelsRaw);
  if ((yearRaw !== null && yearRaw !== undefined && String(yearRaw).trim() !== '') && yearBuilt == null) {
    return { code: 'ERR_INVALID_YEAR_BUILT', error: 'Year built must be an integer between 1000 and 2100' };
  }
  if ((levelsRaw !== null && levelsRaw !== undefined && String(levelsRaw).trim() !== '') && levels == null) {
    return { code: 'ERR_INVALID_LEVELS', error: 'Levels must be an integer between 0 and 300' };
  }
  return {
    value: {
      name: sanitizeFieldText(body?.name, 250),
      style: sanitizeFieldText(body?.style, 200),
      colour: sanitizeFieldText(body?.colour ?? body?.color, 120),
      levels,
      year_built: yearBuilt,
      architect: sanitizeFieldText(body?.architect, 200),
      address: sanitizeFieldText(body?.address, 300),
      archimap_description: sanitizeFieldText(body?.archimapDescription ?? body?.archimap_description ?? body?.description, 1000)
    }
  };
}

function normalizeEditedFieldKey(value) {
  const key = String(value || '').trim().toLowerCase();
  if (!key) return null;
  return ARCHI_EDITED_FIELD_ALIASES.get(key) || null;
}

function sanitizeEditedFields(value) {
  const input = Array.isArray(value)
    ? value
    : (() => {
      if (typeof value !== 'string' || !value.trim()) return [];
      try {
        const parsed = JSON.parse(value);
        return Array.isArray(parsed) ? parsed : [];
      } catch {
        return [];
      }
    })();

  const out = [];
  const seen = new Set();
  for (const item of input) {
    const normalized = normalizeEditedFieldKey(item);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

module.exports = {
  normalizeUserEditStatus,
  sanitizeFieldText,
  sanitizeYearBuilt,
  sanitizeLevels,
  sanitizeArchiPayload,
  sanitizeEditedFields,
  USER_EDIT_STATUS_VALUES
};
