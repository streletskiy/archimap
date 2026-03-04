const USER_EDIT_STATUS_VALUES = new Set(['pending', 'accepted', 'rejected', 'partially_accepted', 'superseded']);

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
    return { error: 'Год постройки должен быть целым числом от 1000 до 2100' };
  }
  if ((levelsRaw !== null && levelsRaw !== undefined && String(levelsRaw).trim() !== '') && levels == null) {
    return { error: 'Этажность должна быть целым числом от 0 до 300' };
  }
  return {
    value: {
      name: sanitizeFieldText(body?.name, 250),
      style: sanitizeFieldText(body?.style, 200),
      levels,
      year_built: yearBuilt,
      architect: sanitizeFieldText(body?.architect, 200),
      address: sanitizeFieldText(body?.address, 300),
      archimap_description: sanitizeFieldText(body?.archimapDescription ?? body?.archimap_description ?? body?.description, 1000)
    }
  };
}

module.exports = {
  normalizeUserEditStatus,
  sanitizeFieldText,
  sanitizeYearBuilt,
  sanitizeLevels,
  sanitizeArchiPayload,
  USER_EDIT_STATUS_VALUES
};
