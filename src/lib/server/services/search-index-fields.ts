export const SEARCH_INDEX_RELEVANT_FIELDS: readonly string[] = Object.freeze([
  'name',
  'address',
  'style',
  'architect',
  'design_ref'
] as const);

export const SEARCH_INDEX_RELEVANT_FIELD_SET = new Set<string>(SEARCH_INDEX_RELEVANT_FIELDS);

function normalizeSearchIndexFieldKey(value) {
  if (value && typeof value === 'object' && !Array.isArray(value) && Object.prototype.hasOwnProperty.call(value, 'field')) {
    return String(value.field ?? '').trim();
  }
  return String(value ?? '').trim();
}

function normalizeSearchIndexText(value) {
  const text = String(value ?? '').trim();
  return text ? text : null;
}

function isSearchIndexRelevantField(field) {
  return SEARCH_INDEX_RELEVANT_FIELD_SET.has(normalizeSearchIndexFieldKey(field));
}

export function hasSearchIndexRelevantFieldChange(fields = []) {
  return Array.isArray(fields) && fields.some((field) => isSearchIndexRelevantField(field));
}

export function hasSearchIndexRelevantValues(values = {}) {
  if (!values || typeof values !== 'object') return false;
  for (const field of SEARCH_INDEX_RELEVANT_FIELDS) {
    if (normalizeSearchIndexText(values[field])) {
      return true;
    }
  }
  return false;
}

export { isSearchIndexRelevantField };
