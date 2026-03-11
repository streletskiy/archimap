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
const ARCHI_RULE_KEYS = new Set(['name', 'style', 'levels', 'year_built', 'architect', 'address', 'description', 'archimap_description']);
const ARCHI_RULE_COLUMN_ORDER = ['name', 'style', 'levels', 'year_built', 'architect', 'address', 'description', 'archimap_description'];

function getPostgresArchiFallbackSql(key, rowAlias = 'src') {
  const alias = String(rowAlias || 'src').trim() || 'src';
  if (key === 'name') return `${alias}.name`;
  if (key === 'style') return `${alias}.style`;
  if (key === 'levels') return `${alias}.levels::text`;
  if (key === 'year_built') return `${alias}.year_built::text`;
  if (key === 'architect') return `${alias}.architect`;
  if (key === 'address') return `${alias}.address`;
  if (key === 'description') return `${alias}.description`;
  if (key === 'archimap_description') return `COALESCE(${alias}.archimap_description, ${alias}.description)`;
  return 'NULL::text';
}

function buildPostgresRuleValueSql(ruleKey, { rowAlias = 'src', tagsAlias = `${rowAlias}.tags_jsonb` } = {}) {
  const key = String(ruleKey || '');
  let fallbackKey = null;
  if (key.startsWith('archi.')) {
    fallbackKey = key.slice(6);
  } else if (ARCHI_RULE_KEYS.has(key)) {
    fallbackKey = key;
  }
  const fallbackSql = fallbackKey ? getPostgresArchiFallbackSql(fallbackKey, rowAlias) : 'NULL::text';
  return {
    sql: `CASE WHEN jsonb_exists(${tagsAlias}, ?) THEN jsonb_extract_path_text(${tagsAlias}, ?) ELSE ${fallbackSql} END`,
    params: [key, key]
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
  const key = String(ruleKey || '');
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
    const key = String(rule?.key || '');
    let fallbackKey = null;
    if (key.startsWith('archi.')) {
      fallbackKey = key.slice(6);
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

function compilePostgresFilterRulesPredicate(rules, options = {}) {
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

function compilePostgresFilterRuleGuardPredicate(rule, options = {}) {
  if (!rule?.key) return { sql: 'TRUE', params: [] };
  const op = String(rule.op || '').trim();
  if (!FILTER_RULE_OPS.has(op)) {
    throw new Error(`Unsupported filter rule operator: ${op}`);
  }

  const tagsAlias = String(options.tagsAlias || `${String(options.rowAlias || 'base')}.tags_jsonb`).trim();
  const key = String(rule.key || '');
  const right = String(rule.valueNormalized || '').toLowerCase();
  const tagExistsSql = `jsonb_exists(${tagsAlias}, ?)`;
  const tagValueSql = `jsonb_extract_path_text(${tagsAlias}, ?)`;
  const tagNumericExpr = buildPostgresNumericValueSql(tagValueSql, [key]);

  if (!usesArchiFallbackRuleKey(key)) {
    if (op === 'exists') {
      return {
        sql: `COALESCE(length(btrim(${tagValueSql})), 0) > 0`,
        params: [key]
      };
    }
    if (op === 'not_exists') {
      return {
        sql: `COALESCE(length(btrim(${tagValueSql})), 0) = 0`,
        params: [key]
      };
    }
    if (op === 'equals') {
      return {
        sql: `lower(${tagValueSql}) = ?`,
        params: [key, right]
      };
    }
    if (op === 'not_equals') {
      return {
        sql: `lower(${tagValueSql}) <> ?`,
        params: [key, right]
      };
    }
    if (op === 'starts_with') {
      return {
        sql: `lower(${tagValueSql}) LIKE (? || '%')`,
        params: [key, right]
      };
    }
    if (NUMERIC_FILTER_RULE_OPS.has(op)) {
      const numericValue = Number.isFinite(rule.numericValue) ? rule.numericValue : parseNumericFilterValue(rule.value);
      const numericParams = [...tagNumericExpr.params, numericValue];
      if (op === 'greater_than') {
        return {
          sql: `${tagNumericExpr.sql} > ?`,
          params: numericParams
        };
      }
      if (op === 'greater_or_equals') {
        return {
          sql: `${tagNumericExpr.sql} >= ?`,
          params: numericParams
        };
      }
      if (op === 'less_than') {
        return {
          sql: `${tagNumericExpr.sql} < ?`,
          params: numericParams
        };
      }
      return {
        sql: `${tagNumericExpr.sql} <= ?`,
        params: numericParams
      };
    }
    return {
      sql: `strpos(lower(${tagValueSql}), ?) > 0`,
      params: [key, right]
    };
  }

  if (op === 'exists') {
    return {
      sql: `NOT (${tagExistsSql} AND COALESCE(length(btrim(${tagValueSql})), 0) = 0)`,
      params: [key, key]
    };
  }
  if (op === 'not_exists') {
    return {
      sql: `NOT (${tagExistsSql} AND COALESCE(length(btrim(${tagValueSql})), 0) > 0)`,
      params: [key, key]
    };
  }
  if (op === 'equals') {
    return {
      sql: `NOT (${tagExistsSql} AND (${tagValueSql} IS NULL OR lower(${tagValueSql}) <> ?))`,
      params: [key, key, key, right]
    };
  }
  if (op === 'not_equals') {
    return {
      sql: `NOT (${tagExistsSql} AND (${tagValueSql} IS NULL OR lower(${tagValueSql}) = ?))`,
      params: [key, key, key, right]
    };
  }
  if (op === 'starts_with') {
    return {
      sql: `NOT (${tagExistsSql} AND (${tagValueSql} IS NULL OR lower(${tagValueSql}) NOT LIKE (? || '%')))`,
      params: [key, key, key, right]
    };
  }
  if (NUMERIC_FILTER_RULE_OPS.has(op)) {
    const numericValue = Number.isFinite(rule.numericValue) ? rule.numericValue : parseNumericFilterValue(rule.value);
    const leftSql = tagNumericExpr.sql;
    const leftParams = tagNumericExpr.params;
    if (op === 'greater_than') {
      return {
        sql: `NOT (${tagExistsSql} AND (${leftSql} IS NULL OR ${leftSql} <= ?))`,
        params: [key, ...leftParams, ...leftParams, numericValue]
      };
    }
    if (op === 'greater_or_equals') {
      return {
        sql: `NOT (${tagExistsSql} AND (${leftSql} IS NULL OR ${leftSql} < ?))`,
        params: [key, ...leftParams, ...leftParams, numericValue]
      };
    }
    if (op === 'less_than') {
      return {
        sql: `NOT (${tagExistsSql} AND (${leftSql} IS NULL OR ${leftSql} >= ?))`,
        params: [key, ...leftParams, ...leftParams, numericValue]
      };
    }
    return {
      sql: `NOT (${tagExistsSql} AND (${leftSql} IS NULL OR ${leftSql} > ?))`,
      params: [key, ...leftParams, ...leftParams, numericValue]
    };
  }
  return {
    sql: `NOT (${tagExistsSql} AND (${tagValueSql} IS NULL OR strpos(lower(${tagValueSql}), ?) = 0))`,
    params: [key, key, key, right]
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
