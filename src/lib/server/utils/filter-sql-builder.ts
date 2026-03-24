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
const ARCHI_RULE_KEYS = new Set(['name', 'style', 'design', 'design_ref', 'design_year', 'material', 'colour', 'levels', 'year_built', 'architect', 'address', 'description', 'archimap_description', 'design:ref', 'design:year']);
const ARCHI_RULE_COLUMN_ORDER = ['name', 'style', 'design', 'design_ref', 'design_year', 'material', 'colour', 'levels', 'year_built', 'architect', 'address', 'description', 'archimap_description'];

function normalizeArchiRuleKey(ruleKey) {
  const key = String(ruleKey || '').trim();
  if (key.startsWith('archi.')) {
    return `archi.${normalizeArchiRuleKey(key.slice(6))}`;
  }
  if (key === 'design:ref') return 'design_ref';
  if (key === 'design:year') return 'design_year';
  return key;
}

function getPostgresRuleTagKeys(ruleKey) {
  const key = normalizeArchiRuleKey(ruleKey);
  if (key === 'colour' || key === 'archi.colour') {
    return ['building:colour', 'colour'];
  }
  if (key === 'material' || key === 'archi.material') {
    return ['building:material', 'material'];
  }
  if (key === 'style' || key === 'archi.style') {
    return ['building:architecture', 'architecture', 'style'];
  }
  if (key === 'design_ref' || key === 'archi.design_ref') {
    return ['design:ref'];
  }
  if (key === 'design_year' || key === 'archi.design_year') {
    return ['design:year'];
  }
  return [key];
}

function buildPostgresTagValueSql(tagsAlias, tagKeys = []) {
  const normalizedKeys = Array.isArray(tagKeys) ? tagKeys.filter(Boolean) : [];
  if (normalizedKeys.length === 0) {
    return {
      sql: 'NULL::text',
      params: []
    };
  }
  const parts = normalizedKeys.map(() => `jsonb_extract_path_text(${tagsAlias}, ?)`);
  return {
    sql: parts.length === 1 ? parts[0] : `COALESCE(${parts.join(', ')})`,
    params: normalizedKeys
  };
}

function getPostgresArchiFallbackSql(key, rowAlias = 'src') {
  const alias = String(rowAlias || 'src').trim() || 'src';
  if (key === 'name') return `${alias}.name`;
  if (key === 'style') return `${alias}.style`;
  if (key === 'design') return `${alias}.design`;
  if (key === 'design_ref') return `${alias}.design_ref`;
  if (key === 'design_year') return `${alias}.design_year::text`;
  if (key === 'material') return `${alias}.material`;
  if (key === 'colour') return `${alias}.colour`;
  if (key === 'levels') return `${alias}.levels::text`;
  if (key === 'year_built') return `${alias}.year_built::text`;
  if (key === 'architect') return `${alias}.architect`;
  if (key === 'address') return `${alias}.address`;
  if (key === 'description') return `${alias}.description`;
  if (key === 'archimap_description') return `COALESCE(${alias}.archimap_description, ${alias}.description)`;
  return 'NULL::text';
}

function buildPostgresRuleValueSql(ruleKey, { rowAlias = 'src', tagsAlias = `${rowAlias}.tags_jsonb` } = {}) {
  const key = normalizeArchiRuleKey(ruleKey);
  let fallbackKey = null;
  if (key.startsWith('archi.')) {
    fallbackKey = normalizeArchiRuleKey(key.slice(6));
  } else if (ARCHI_RULE_KEYS.has(key)) {
    fallbackKey = key;
  }
  const tagValueSql = buildPostgresTagValueSql(tagsAlias, getPostgresRuleTagKeys(fallbackKey || key));
  if (!fallbackKey) {
    return {
      sql: `CASE WHEN COALESCE(length(btrim(${tagValueSql.sql})), 0) > 0 THEN ${tagValueSql.sql} ELSE NULL::text END`,
      params: [...tagValueSql.params, ...tagValueSql.params]
    };
  }
  const fallbackSql = getPostgresArchiFallbackSql(fallbackKey, rowAlias);
  return {
    sql: `CASE WHEN COALESCE(length(btrim(${fallbackSql})), 0) > 0 THEN ${fallbackSql} ELSE ${tagValueSql.sql} END`,
    params: [...tagValueSql.params]
  };
}

function buildPostgresNumericValueSql(valueSql, valueParams = []) {
  const normalizedSql = `replace(btrim(${valueSql}), ',', '.')`;
  return {
    sql: `CASE WHEN ${normalizedSql} ~ '^-{0,1}\\d+(\\.\\d+){0,1}$' THEN (${normalizedSql})::double precision ELSE NULL END`,
    params: [...valueParams, ...valueParams]
  };
}

function parseNumericFilterValue(rawValue) {
  const text = String(rawValue ?? '').trim().replace(',', '.');
  if (!/^-?\d+(?:\.\d+)?$/.test(text)) return null;
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
}

function usesArchiFallbackRuleKey(ruleKey) {
  const key = normalizeArchiRuleKey(ruleKey);
  if (!key) return false;
  return key.startsWith('archi.') || ARCHI_RULE_KEYS.has(key);
}

function splitPostgresPushdownRules(rules) {
  const tagOnlyRules = [];
  const fallbackRules = [];
  for (const rule of Array.isArray(rules) ? rules : []) {
    if (usesArchiFallbackRuleKey(rule?.key)) {
      fallbackRules.push(rule);
    } else {
      tagOnlyRules.push(rule);
    }
  }
  return { tagOnlyRules, fallbackRules };
}

function collectRequiredArchiColumns(rules) {
  const required = new Set();
  for (const rule of Array.isArray(rules) ? rules : []) {
    const key = normalizeArchiRuleKey(rule?.key);
    let fallbackKey = null;
    if (key.startsWith('archi.')) {
      fallbackKey = normalizeArchiRuleKey(key.slice(6));
    } else if (ARCHI_RULE_KEYS.has(key)) {
      fallbackKey = key;
    }

    if (!ARCHI_RULE_KEYS.has(fallbackKey)) continue;
    required.add(fallbackKey);
    if (fallbackKey === 'archimap_description') {
      required.add('description');
    }
  }
  return ARCHI_RULE_COLUMN_ORDER.filter((column) => required.has(column));
}

function compilePostgresFilterRulePredicate(rule, options = {}) {
  if (!rule?.key) return { sql: 'TRUE', params: [] };
  const op = String(rule.op || '').trim();
  if (!FILTER_RULE_OPS.has(op)) {
    throw new Error(`Unsupported filter rule operator: ${op}`);
  }

  const valueExpr = buildPostgresRuleValueSql(rule.key, options);
  const params = [...valueExpr.params];

  if (op === 'exists') {
    return {
      sql: `COALESCE(length(btrim(${valueExpr.sql})), 0) > 0`,
      params
    };
  }
  if (op === 'not_exists') {
    return {
      sql: `COALESCE(length(btrim(${valueExpr.sql})), 0) = 0`,
      params
    };
  }

  if (NUMERIC_FILTER_RULE_OPS.has(op)) {
    const numericExpr = buildPostgresNumericValueSql(valueExpr.sql, valueExpr.params);
    const right = Number.isFinite(rule.numericValue) ? rule.numericValue : parseNumericFilterValue(rule.value);
    const numericParams = [...numericExpr.params, right];
    if (op === 'greater_than') {
      return {
        sql: `${numericExpr.sql} > ?`,
        params: numericParams
      };
    }
    if (op === 'greater_or_equals') {
      return {
        sql: `${numericExpr.sql} >= ?`,
        params: numericParams
      };
    }
    if (op === 'less_than') {
      return {
        sql: `${numericExpr.sql} < ?`,
        params: numericParams
      };
    }
    return {
      sql: `${numericExpr.sql} <= ?`,
      params: numericParams
    };
  }

  const right = String(rule.valueNormalized || '').toLowerCase();
  params.push(right);

  if (op === 'equals') {
    return {
      sql: `lower(${valueExpr.sql}) = ?`,
      params
    };
  }
  if (op === 'not_equals') {
    return {
      sql: `lower(${valueExpr.sql}) <> ?`,
      params
    };
  }
  if (op === 'starts_with') {
    return {
      sql: `lower(${valueExpr.sql}) LIKE (? || '%')`,
      params
    };
  }
  return {
    sql: `strpos(lower(${valueExpr.sql}), ?) > 0`,
    params
  };
}

function compilePostgresFilterRulesPredicate(rules, options: LooseRecord = {}) {
  if (!Array.isArray(rules) || rules.length === 0) {
    return { sql: 'TRUE', params: [] };
  }

  const parts = [];
  const params = [];
  for (const rule of rules) {
    const compiled = compilePostgresFilterRulePredicate(rule, options);
    parts.push(`(${compiled.sql})`);
    params.push(...compiled.params);
  }
  return {
    sql: parts.join(' AND '),
    params
  };
}

function compilePostgresFilterRuleGuardPredicate(rule: LooseRecord = {}, options: LooseRecord = {}) {
  if (!rule?.key) return { sql: 'TRUE', params: [] };
  const op = String(rule.op || '').trim();
  if (!FILTER_RULE_OPS.has(op)) {
    throw new Error(`Unsupported filter rule operator: ${op}`);
  }

  const tagsAlias = String(options.tagsAlias || `${String(options.rowAlias || 'base')}.tags_jsonb`).trim();
  const key = String(rule.key || '');
  if (usesArchiFallbackRuleKey(key)) {
    return {
      sql: 'TRUE',
      params: []
    };
  }

  const right = String(rule.valueNormalized || '').toLowerCase();
  const tagKeys = getPostgresRuleTagKeys(key);
  const tagValueExpr = buildPostgresTagValueSql(tagsAlias, tagKeys);
  const tagNumericExpr = buildPostgresNumericValueSql(tagValueExpr.sql, tagKeys);

  if (op === 'exists') {
    return {
      sql: `COALESCE(length(btrim(${tagValueExpr.sql})), 0) > 0`,
      params: tagKeys
    };
  }
  if (op === 'not_exists') {
    return {
      sql: `COALESCE(length(btrim(${tagValueExpr.sql})), 0) = 0`,
      params: tagKeys
    };
  }
  if (op === 'equals') {
    return {
      sql: `lower(${tagValueExpr.sql}) = ?`,
      params: [...tagKeys, right]
    };
  }
  if (op === 'not_equals') {
    return {
      sql: `lower(${tagValueExpr.sql}) <> ?`,
      params: [...tagKeys, right]
    };
  }
  if (op === 'starts_with') {
    return {
      sql: `lower(${tagValueExpr.sql}) LIKE (? || '%')`,
      params: [...tagKeys, right]
    };
  }
  if (NUMERIC_FILTER_RULE_OPS.has(op)) {
    const numericValue = Number.isFinite(rule.numericValue) ? rule.numericValue : parseNumericFilterValue(rule.value);
    if (op === 'greater_than') {
      return {
        sql: `${tagNumericExpr.sql} > ?`,
        params: [...tagNumericExpr.params, numericValue]
      };
    }
    if (op === 'greater_or_equals') {
      return {
        sql: `${tagNumericExpr.sql} >= ?`,
        params: [...tagNumericExpr.params, numericValue]
      };
    }
    if (op === 'less_than') {
      return {
        sql: `${tagNumericExpr.sql} < ?`,
        params: [...tagNumericExpr.params, numericValue]
      };
    }
    return {
      sql: `${tagNumericExpr.sql} <= ?`,
      params: [...tagNumericExpr.params, numericValue]
    };
  }
  return {
    sql: `strpos(lower(${tagValueExpr.sql}), ?) > 0`,
    params: [...tagKeys, right]
  };
}

function compilePostgresFilterRulesGuardPredicate(rules, options = {}) {
  if (!Array.isArray(rules) || rules.length === 0) {
    return { sql: 'TRUE', params: [] };
  }

  const parts = [];
  const params = [];
  for (const rule of rules) {
    const compiled = compilePostgresFilterRuleGuardPredicate(rule, options);
    parts.push(`(${compiled.sql})`);
    params.push(...compiled.params);
  }
  return {
    sql: parts.join(' AND '),
    params
  };
}

module.exports = {
  ARCHI_RULE_KEYS,
  FILTER_RULE_OPS,
  NUMERIC_FILTER_RULE_OPS,
  collectRequiredArchiColumns,
  compilePostgresFilterRuleGuardPredicate,
  compilePostgresFilterRulePredicate,
  compilePostgresFilterRulesGuardPredicate,
  compilePostgresFilterRulesPredicate,
  parseNumericFilterValue,
  splitPostgresPushdownRules,
  usesArchiFallbackRuleKey
};
