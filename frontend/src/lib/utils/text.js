const EMPTY_OPTIONAL_TEXT_TOKENS = new Set(['-', '--', '—', 'n/a', 'na', 'null']);

export const BUILDING_EDITABLE_FIELDS = Object.freeze([
  'name',
  'style',
  'levels',
  'yearBuilt',
  'architect',
  'address',
  'archimapDescription'
]);

export function sanitizeOptionalText(value) {
  if (value == null) return '';
  const text = String(value).trim();
  if (!text) return '';
  if (EMPTY_OPTIONAL_TEXT_TOKENS.has(text.toLowerCase())) return '';
  return text;
}

export function coerceNullableText(value) {
  return sanitizeOptionalText(value) || null;
}

export function pickFirstText(...values) {
  for (const value of values) {
    const text = sanitizeOptionalText(value);
    if (text) return text;
  }
  return '';
}

export function pickNullableText(...values) {
  for (const value of values) {
    const text = coerceNullableText(value);
    if (text) return text;
  }
  return null;
}

export function formatDisplayText(...values) {
  return pickFirstText(...values) || '-';
}

export function normalizeIntegerField(value, min, max) {
  const text = sanitizeOptionalText(value);
  if (!text) return '';
  const parsed = Number(text);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) return '';
  return String(parsed);
}

export function coerceNullableIntegerText(value, min, max) {
  const text = coerceNullableText(value);
  if (!text) return null;
  const parsed = Number(text);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) return null;
  return String(parsed);
}

export function normalizeEditedBuildingFields(value, allowedFields = BUILDING_EDITABLE_FIELDS) {
  if (!Array.isArray(value)) return [];
  const allowed = new Set(allowedFields);
  const out = [];
  const seen = new Set();
  for (const item of value) {
    const key = String(item || '').trim();
    if (!allowed.has(key) || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}
