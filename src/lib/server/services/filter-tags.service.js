const DEFAULT_FILTER_TAG_ALLOWLIST = Object.freeze([
  'architect',
  'building',
  'building:architecture',
  'building:colour',
  'building:levels',
  'building:material',
  'building:prefabricated',
  'height',
  'heritage',
  'historic',
  'name',
  'roof:colour',
  'roof:material',
  'roof:shape',
  'start_date',
  'wikidata'
]);

function normalizeFilterTagKey(value) {
  const key = String(value || '').trim();
  if (!key) return '';
  return key.slice(0, 120);
}

function normalizeFilterTagKeyList(values) {
  const seen = new Set();
  const out = [];
  for (const raw of Array.isArray(values) ? values : []) {
    const key = normalizeFilterTagKey(raw);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out.sort((left, right) => left.localeCompare(right, 'en', { sensitivity: 'base' }));
}

module.exports = {
  DEFAULT_FILTER_TAG_ALLOWLIST,
  normalizeFilterTagKey,
  normalizeFilterTagKeyList
};
