const FILTER_RULE_OPS = new Set([
  'contains',
  'equals',
  'not_equals',
  'starts_with',
  'exists',
  'not_exists',
  'greater_than',
  'greater_or_equals',
  'less_than',
  'less_or_equals'
]);
const NUMERIC_FILTER_RULE_OPS = new Set(['greater_than', 'greater_or_equals', 'less_than', 'less_or_equals']);
const ARCHI_RULE_KEYS = new Set([
  'name',
  'style',
  'design',
  'design_ref',
  'design_year',
  'material',
  'material_concrete',
  'roof_shape',
  'colour',
  'levels',
  'year_built',
  'architect',
  'address',
  'description',
  'archimap_description',
  'design:ref',
  'design:year'
]);
const ARCHI_RULE_COLUMN_ORDER = [
  'name',
  'style',
  'design',
  'design_ref',
  'design_year',
  'material',
  'material_concrete',
  'roof_shape',
  'colour',
  'levels',
  'year_built',
  'architect',
  'address',
  'description',
  'archimap_description'
];
// String.trim whitespace; PostgreSQL's default btrim removes only ASCII space.
const TRIM_CHARACTERS =
  ' \t\n\r\f\v\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff';
function trimSql(sql) {
  return `btrim(${sql}, '${TRIM_CHARACTERS}')`;
}
function meaningfulSql(sql) {
  return `COALESCE(length(${trimSql(sql)}), 0) > 0`;
}
function unwrapArchiKey(value) {
  let key = String(value || '').trim();
  while (key.startsWith('archi.')) key = key.slice(6);
  return key;
}
function getArchiOverrideColumn(rawKey) {
  const key = unwrapArchiKey(rawKey);
  const columns = {
    'building:levels': 'levels',
    'building:colour': 'colour',
    'building:material': 'material',
    'building:material:concrete': 'material_concrete',
    'building:architecture': 'style',
    architecture: 'style',
    'building:year': 'year_built',
    start_date: 'year_built',
    architect_name: 'architect',
    'name:ru': 'name',
    'name:en': 'name',
    'roof:shape': 'roof_shape',
    'building:roof:shape': 'roof_shape',
    'design:ref': 'design_ref',
    'design:year': 'design_year'
  };
  return Object.prototype.hasOwnProperty.call(columns, key) ? columns[key] : ARCHI_RULE_KEYS.has(key) ? key : null;
}
function usesArchiFallbackRuleKey(key) {
  return Boolean(getArchiOverrideColumn(key));
}
function splitPostgresPushdownRules(rules) {
  const tagOnlyRules = [];
  const fallbackRules = [];
  for (const rule of Array.isArray(rules) ? rules : []) {
    (usesArchiFallbackRuleKey(rule?.key) ? fallbackRules : tagOnlyRules).push(rule);
  }
  return { tagOnlyRules, fallbackRules };
}
function collectRequiredArchiColumns(rules) {
  const required = new Set();
  for (const rule of Array.isArray(rules) ? rules : []) {
    const column = getArchiOverrideColumn(rule?.key);
    if (column) required.add(column);
    if (column === 'description' || column === 'archimap_description') {
      required.add('description');
      required.add('archimap_description');
    }
    if (column === 'material_concrete') required.add('material');
  }
  return ARCHI_RULE_COLUMN_ORDER.filter((column) => required.has(column));
}
function getPostgresRuleTagKeys(rawKey) {
  const key = unwrapArchiKey(rawKey);
  if (key === 'colour' || key === 'building:colour') return ['building:colour', 'colour'];
  if (key === 'material' || key === 'building:material') return ['building:material', 'material'];
  if (key === 'material_concrete' || key === 'building:material:concrete')
    return ['building:material:concrete', 'material_concrete'];
  if (['roof_shape', 'roof:shape', 'building:roof:shape'].includes(key))
    return ['roof:shape', 'roof_shape', 'building:roof:shape'];
  if (key === 'design_ref' || key === 'design:ref') return ['design:ref', 'design_ref'];
  if (key === 'design_year' || key === 'design:year') return ['design:year', 'design_year'];
  return [key];
}
function buildPostgresTagValueSql(tagsAlias, tagKeys, fallbackSql = null) {
  const paths = tagKeys.map(() => `jsonb_extract_path(${tagsAlias}, ?)`);
  if (fallbackSql) paths.push(`to_jsonb(${fallbackSql})`);
  const value = paths.length === 1 ? paths[0] : `COALESCE(${paths.join(', ')})`;
  // A present JSON null blocks later aliases, matching hasOwnProperty in getRuleValue.
  // OFFSET 0 prevents repeated evaluation when the value is used by CASE branches.
  return {
    sql: `(SELECT CASE jsonb_typeof(tag_value)
      WHEN 'array' THEN osm.filter_json_text(tag_value, ';')
      WHEN 'object' THEN '[object Object]' ELSE tag_value #>> '{}' END
      FROM (SELECT ${value} AS tag_value OFFSET 0) tag_input)`,
    params: tagKeys
  };
}
function buildPostgresRuleValueSql(
  rawKey,
  { rowAlias = 'src', tagsAlias = `${rowAlias}.tags_jsonb`, itemLevelsSql = `${rowAlias}.item_levels` } = {}
) {
  const key = unwrapArchiKey(rawKey);
  const column = getArchiOverrideColumn(key);
  const tag = buildPostgresTagValueSql(
    tagsAlias,
    getPostgresRuleTagKeys(key),
    column === key && ARCHI_RULE_KEYS.has(key) ? `${rowAlias}.${column}::text` : null
  );
  if (!column) return tag;
  const field = `${rowAlias}.${column}::text`;
  let fallback = tag.sql;
  // A personal clear falls back to the mapped base level, as in the JS mapper.
  if (column === 'levels')
    fallback = `CASE WHEN ${meaningfulSql(itemLevelsSql)} THEN ${itemLevelsSql} ELSE ${fallback} END`;
  if (column === 'description' || column === 'archimap_description') {
    return {
      sql: `CASE WHEN ${meaningfulSql(`${rowAlias}.archimap_description`)} THEN ${rowAlias}.archimap_description WHEN ${meaningfulSql(`${rowAlias}.description`)} THEN ${rowAlias}.description ELSE ${fallback} END`,
      params: tag.params
    };
  }
  return { sql: `CASE WHEN ${meaningfulSql(field)} THEN ${field} ELSE ${fallback} END`, params: tag.params };
}
function buildPostgresNumericValueSql(valueSql, valueParams = []) {
  const normalized = `replace(${trimSql(valueSql)}, ',', '.')`;
  return {
    // Avoid a float overflow exception for arbitrary long tag values; JS rejects infinities.
    // Normalize once: without this barrier PostgreSQL repeats the entire fallback
    // expression for the regex, range check and numeric conversion.
    sql: `(SELECT CASE WHEN n ~ '^-?[0-9]+([.][0-9]+)?$' THEN CASE WHEN abs(n::numeric) <= 1.7976931348623157e308::numeric THEN n::double precision ELSE NULL END ELSE NULL END FROM (SELECT ${normalized} AS n OFFSET 0) numeric_input)`,
    params: valueParams
  };
}
function parseNumericFilterValue(rawValue) {
  const text = String(rawValue ?? '')
    .trim()
    .replace(',', '.');
  if (!/^-?\d+(?:\.\d+)?$/.test(text)) return null;
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
}
function compilePostgresFilterRulePredicate(rule, options: LooseRecord = {}) {
  if (!rule?.key) return { sql: 'TRUE', params: [] };
  const op = String(rule.op || '').trim();
  if (!FILTER_RULE_OPS.has(op)) throw new Error(`Unsupported filter rule operator: ${op}`);
  const value = options.valueSql ? { sql: options.valueSql, params: [] } : buildPostgresRuleValueSql(rule.key, options);
  if (op === 'exists' || op === 'not_exists')
    return { sql: `${op === 'not_exists' ? 'NOT ' : ''}(${meaningfulSql(value.sql)})`, params: value.params };
  if (NUMERIC_FILTER_RULE_OPS.has(op)) {
    const number = buildPostgresNumericValueSql(value.sql, value.params);
    const operator = { greater_than: '>', greater_or_equals: '>=', less_than: '<', less_or_equals: '<=' }[op];
    const right = Number.isFinite(rule.numericValue) ? rule.numericValue : parseNumericFilterValue(rule.value);
    return { sql: `${number.sql} ${operator} ?`, params: [...number.params, right] };
  }
  const right = String(rule.valueNormalized ?? rule.value ?? '').toLowerCase();
  const left = `lower(${value.sql})`;
  if (op === 'equals' || op === 'not_equals')
    return { sql: `${left} ${op === 'equals' ? '=' : '<>'} ?`, params: [...value.params, right] };
  // %, _ and backslash are literal prefixes, not SQL LIKE patterns.
  return { sql: `strpos(${left}, ?) ${op === 'starts_with' ? '= 1' : '> 0'}`, params: [...value.params, right] };
}
function compilePostgresFilterRulesPredicate(rules, options: LooseRecord = {}) {
  const compiled = (Array.isArray(rules) ? rules : []).map((rule) => compilePostgresFilterRulePredicate(rule, options));
  return {
    sql: compiled.map((part) => `(${part.sql})`).join(' AND ') || 'TRUE',
    params: compiled.flatMap((part) => part.params)
  };
}
function compilePostgresFilterRuleGuardPredicate(rule: LooseRecord = {}, options: LooseRecord = {}) {
  if (rule?.key && !FILTER_RULE_OPS.has(String(rule.op || '').trim())) {
    throw new Error(`Unsupported filter rule operator: ${String(rule.op || '').trim()}`);
  }
  if (usesArchiFallbackRuleKey(rule.key)) return { sql: 'TRUE', params: [] };
  return compilePostgresFilterRulePredicate(rule, { rowAlias: 'base', ...options });
}
function compilePostgresFilterRulesGuardPredicate(rules, options = {}) {
  const compiled = (Array.isArray(rules) ? rules : []).map((rule) =>
    compilePostgresFilterRuleGuardPredicate(rule, options)
  );
  return {
    sql: compiled.map((part) => `(${part.sql})`).join(' AND ') || 'TRUE',
    params: compiled.flatMap((part) => part.params)
  };
}
module.exports = {
  ARCHI_RULE_KEYS,
  ARCHI_RULE_COLUMN_ORDER,
  FILTER_RULE_OPS,
  NUMERIC_FILTER_RULE_OPS,
  buildPostgresRuleValueSql,
  collectRequiredArchiColumns,
  compilePostgresFilterRuleGuardPredicate,
  compilePostgresFilterRulePredicate,
  compilePostgresFilterRulesGuardPredicate,
  compilePostgresFilterRulesPredicate,
  parseNumericFilterValue,
  splitPostgresPushdownRules,
  usesArchiFallbackRuleKey,
  trimSql
};
