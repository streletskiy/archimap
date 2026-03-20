const { createLruCache } = require('../infra/lru-cache.infra');
const { createBuildingFilterQueryService } = require('./building-filter-query.service');
const {
  ARCHI_RULE_KEYS,
  FILTER_RULE_OPS,
  NUMERIC_FILTER_RULE_OPS,
  parseNumericFilterValue,
  splitPostgresPushdownRules
} = require('../utils/filter-sql-builder');

const FILTER_MATCH_MAX_RULES = 30;
const FILTER_MATCH_MAX_KEY_LEN = 80;
const FILTER_MATCH_MAX_VALUE_LEN = 240;
const FILTER_MATCH_MAX_RESULTS = 20000;
const FILTER_MATCH_DEFAULT_RESULTS = 12000;
const FILTER_MATCH_BATCH_MAX_REQUESTS = 16;
const FILTER_MATCH_CANDIDATE_CAP = 50000;
const FILTER_DATA_MAX_KEYS = 5000;
const FILTER_DATA_BBOX_MAX_LIMIT = 50000;
const FILTER_DATA_BBOX_DEFAULT_LIMIT = 12000;

function parseOsmKey(value) {
  const text = String(value || '').trim();
  const match = text.match(/^(way|relation)\/(\d+)$/);
  if (!match) return null;
  const osmId = Number(match[2]);
  if (!Number.isInteger(osmId)) return null;
  return { osmType: match[1], osmId };
}

function encodeOsmFeatureId(osmType, osmId) {
  const typeBit = osmType === 'relation' ? 1 : 0;
  return (Number(osmId) * 2) + typeBit;
}

function normalizeFilterRule(rule, _options = {}) {
  const key = String(rule?.key || '').trim();
  const op = String(rule?.op || 'contains').trim();
  const value = String(rule?.value || '').trim();
  if (!key) return { error: 'Rule key is required' };
  if (key.length > FILTER_MATCH_MAX_KEY_LEN) return { error: 'Rule key is too long' };
  if (!FILTER_RULE_OPS.has(op)) return { error: `Invalid rule operator: ${op}` };
  if (value.length > FILTER_MATCH_MAX_VALUE_LEN) return { error: 'Rule value is too long' };
  const numericValue = NUMERIC_FILTER_RULE_OPS.has(op) ? parseNumericFilterValue(value) : null;
  if (NUMERIC_FILTER_RULE_OPS.has(op) && !Number.isFinite(numericValue)) {
    return { error: 'Rule value must be numeric' };
  }
  return {
    value: {
      key,
      op,
      value,
      valueNormalized: value.toLowerCase(),
      numericValue
    }
  };
}

function normalizeTagValue(value) {
  if (value == null) return null;
  if (Array.isArray(value)) return value.join(';');
  return String(value);
}

function hasMeaningfulValue(value) {
  const normalized = normalizeTagValue(value);
  return normalized != null && String(normalized).trim().length > 0;
}

function getRuleValue(item, key) {
  const archiInfo = item?.archiInfo && typeof item.archiInfo === 'object' ? item.archiInfo : {};
  if (key.startsWith('archi.')) {
    return archiInfo[key.slice(6)];
  }
  const sourceTags = item?.sourceTags && typeof item.sourceTags === 'object' ? item.sourceTags : {};
  
  // Apply archiInfo overrides for common OSM tags
  if (key === 'building:colour' || key === 'colour') {
    if (hasMeaningfulValue(archiInfo.colour)) return archiInfo.colour;
    if (Object.prototype.hasOwnProperty.call(sourceTags, 'building:colour')) return sourceTags['building:colour'];
    if (Object.prototype.hasOwnProperty.call(sourceTags, 'colour')) return sourceTags.colour;
  }
  if (key === 'building:material' || key === 'material') {
    if (hasMeaningfulValue(archiInfo.material)) return archiInfo.material;
    if (Object.prototype.hasOwnProperty.call(sourceTags, 'building:material')) return sourceTags['building:material'];
    if (Object.prototype.hasOwnProperty.call(sourceTags, 'material')) return sourceTags.material;
  }
  if (key === 'building:material:concrete' || key === 'material_concrete') {
    if (hasMeaningfulValue(archiInfo.material_concrete)) return archiInfo.material_concrete;
    if (Object.prototype.hasOwnProperty.call(sourceTags, 'building:material:concrete')) return sourceTags['building:material:concrete'];
    if (Object.prototype.hasOwnProperty.call(sourceTags, 'material_concrete')) return sourceTags.material_concrete;
  }
  if (key === 'building:architecture' || key === 'architecture' || key === 'style') {
     if (hasMeaningfulValue(archiInfo.style)) return archiInfo.style;
  }
  if (key === 'building:levels' || key === 'levels') {
     if (hasMeaningfulValue(archiInfo.levels)) return archiInfo.levels;
  }
  if (key === 'building:year' || key === 'year_built' || key === 'start_date') {
     if (hasMeaningfulValue(archiInfo.year_built)) return archiInfo.year_built;
  }
  if (key === 'architect' || key === 'architect_name') {
     if (hasMeaningfulValue(archiInfo.architect)) return archiInfo.architect;
  }
  if (key === 'name' || key === 'name:ru' || key === 'name:en') {
     if (hasMeaningfulValue(archiInfo.name)) return archiInfo.name;
  }
  if (key === 'description' || key === 'archimap_description') {
     if (hasMeaningfulValue(archiInfo.archimap_description)) return archiInfo.archimap_description;
     if (hasMeaningfulValue(archiInfo.description)) return archiInfo.description;
  }

  if (ARCHI_RULE_KEYS.has(key) && hasMeaningfulValue(archiInfo[key])) return archiInfo[key];
  if (Object.prototype.hasOwnProperty.call(sourceTags, key)) return sourceTags[key];
  if (ARCHI_RULE_KEYS.has(key)) {
    return archiInfo[key];
  }
  return undefined;
}

function matchesFilterRule(item, rule) {
  if (!rule?.key) return true;
  const actualRaw = getRuleValue(item, rule.key);
  const actual = normalizeTagValue(actualRaw);
  const hasValue = actual != null && String(actual).trim().length > 0;
  if (rule.op === 'exists') return hasValue;
  if (rule.op === 'not_exists') return !hasValue;
  if (actual == null) return false;
  if (NUMERIC_FILTER_RULE_OPS.has(rule.op)) {
    const leftNumber = parseNumericFilterValue(actual);
    const rightNumber = Number.isFinite(rule.numericValue) ? rule.numericValue : parseNumericFilterValue(rule.value);
    if (!Number.isFinite(leftNumber) || !Number.isFinite(rightNumber)) return false;
    if (rule.op === 'greater_than') return leftNumber > rightNumber;
    if (rule.op === 'greater_or_equals') return leftNumber >= rightNumber;
    if (rule.op === 'less_than') return leftNumber < rightNumber;
    return leftNumber <= rightNumber;
  }

  const left = String(actual).toLowerCase();
  if (rule.op === 'equals') return left === rule.valueNormalized;
  if (rule.op === 'not_equals') return left !== rule.valueNormalized;
  if (rule.op === 'starts_with') return left.startsWith(rule.valueNormalized);
  return left.includes(rule.valueNormalized);
}

function stableRulesHash(rules) {
  const raw = JSON.stringify(Array.isArray(rules) ? rules : []);
  let hash = 2166136261;
  for (let index = 0; index < raw.length; index += 1) {
    hash ^= raw.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `fnv1a-${(hash >>> 0).toString(16)}`;
}

function buildBboxHash(minLon, minLat, maxLon, maxLat) {
  return `${minLon.toFixed(5)}:${minLat.toFixed(5)}:${maxLon.toFixed(5)}:${maxLat.toFixed(5)}`;
}

function buildFilterMatchPayload({
  id = '',
  matchedKeys = [],
  matchedFeatureIds = [],
  rulesHash = 'fnv1a-0',
  bboxHash = '',
  truncated = false,
  elapsedMs = 0,
  cacheHit = false
} = {}) {
  const payload = {
    matchedKeys,
    matchedFeatureIds,
    meta: {
      rulesHash,
      bboxHash,
      truncated: Boolean(truncated),
      elapsedMs: Number(elapsedMs) || 0,
      cacheHit: Boolean(cacheHit)
    }
  };
  if (!id) return payload;
  return {
    id,
    ...payload
  };
}

function normalizeFilterMatchRequest(request, { isFilterTagAllowed } = {}) {
  const normalizedRules = [];
  const rulesRaw = request?.rules;
  if (!Array.isArray(rulesRaw)) {
    return { code: 'ERR_RULES_ARRAY_REQUIRED', error: 'rules must be an array' };
  }
  if (rulesRaw.length > FILTER_MATCH_MAX_RULES) {
    return { code: 'ERR_TOO_MANY_RULES', error: `Too many rules (maximum ${FILTER_MATCH_MAX_RULES})` };
  }
  for (const entry of rulesRaw) {
    const parsed = normalizeFilterRule(entry, { isFilterTagAllowed });
    if (parsed.error) {
      return { error: parsed.error };
    }
    normalizedRules.push(parsed.value);
  }

  const maxResultsRaw = Number(request?.maxResults ?? request?.limit);
  const maxResults = Math.max(
    1,
    Math.min(FILTER_MATCH_MAX_RESULTS, Number.isFinite(maxResultsRaw) ? maxResultsRaw : FILTER_MATCH_DEFAULT_RESULTS)
  );

  return {
    value: {
      id: String(request?.id || '').trim() || stableRulesHash(normalizedRules),
      rules: normalizedRules,
      maxResults,
      rulesHash: String(request?.rulesHash || '').trim() || stableRulesHash(normalizedRules)
    }
  };
}

function getFilterMatchCandidateLimit(rules, maxResults) {
  const isHeavy = Array.isArray(rules) && rules.some((rule) => rule.op === 'contains');
  return Math.max(
    maxResults,
    Math.min(FILTER_MATCH_CANDIDATE_CAP, Math.max(maxResults * (isHeavy ? 8 : 6), 5000))
  );
}

function getBatchFilterMatchCandidateLimit(requests) {
  const normalizedRequests = Array.isArray(requests) ? requests : [];
  const maxPerRequest = normalizedRequests.reduce(
    (best, request) => Math.max(best, getFilterMatchCandidateLimit(request?.rules, request?.maxResults)),
    0
  );
  const totalRequested = normalizedRequests.reduce((sum, request) => sum + Math.max(0, Number(request?.maxResults || 0)), 0);
  return Math.max(
    5000,
    Math.min(FILTER_MATCH_CANDIDATE_CAP, Math.max(maxPerRequest, totalRequested))
  );
}

function buildFilterMatchResultForRules(items, rules, maxResults) {
  const matchedKeys = [];
  const matchedFeatureIds = [];
  let truncated = false;

  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    const ok = rules.every((rule) => matchesFilterRule(item, rule));
    if (!ok) continue;
    matchedKeys.push(item.osmKey);
    const parsed = parseOsmKey(item.osmKey);
    if (parsed) {
      matchedFeatureIds.push(encodeOsmFeatureId(parsed.osmType, parsed.osmId));
    }
    if (matchedKeys.length >= maxResults) {
      truncated = true;
      break;
    }
  }

  return {
    matchedKeys,
    matchedFeatureIds,
    truncated
  };
}

function buildFilterMatchBatchResults(items, requests, {
  bboxHash = '',
  elapsedMs = 0,
  cacheHit = false,
  forceTruncated = false
} = {}) {
  return (Array.isArray(requests) ? requests : []).map((request) => {
    const result = buildFilterMatchResultForRules(
      Array.isArray(items) ? items : [],
      Array.isArray(request?.rules) ? request.rules : [],
      Number(request?.maxResults || FILTER_MATCH_DEFAULT_RESULTS)
    );
    return buildFilterMatchPayload({
      id: request?.id,
      matchedKeys: result.matchedKeys,
      matchedFeatureIds: result.matchedFeatureIds,
      rulesHash: request?.rulesHash,
      bboxHash,
      truncated: forceTruncated || result.truncated,
      elapsedMs,
      cacheHit
    });
  });
}

function normalizeActorKey(actorKeyRaw) {
  return String(actorKeyRaw || '').trim().toLowerCase();
}

function resolveZoomBucket(body = {}) {
  const zoom = Number(body?.zoom);
  return Number.isFinite(Number(body?.zoomBucket))
    ? Number(body.zoomBucket)
    : (Number.isFinite(zoom) ? Math.round(zoom * 2) / 2 : 0);
}

async function applyPersonalEditsToRows(rows, actorKey, applyPersonalEditsToFilterItems, mapFilterDataRow) {
  const items = rows.map(mapFilterDataRow);
  return applyPersonalEditsToFilterItems(items, actorKey);
}

function createBuildingFiltersService({
  db,
  rtreeState,
  isFilterTagAllowed,
  applyPersonalEditsToFilterItems
}) {
  if (!db) {
    throw new Error('createBuildingFiltersService: db is required');
  }
  if (typeof applyPersonalEditsToFilterItems !== 'function') {
    throw new Error('createBuildingFiltersService: applyPersonalEditsToFilterItems is required');
  }

  // Centralize filter cache/query orchestration so the route only wires HTTP handlers.
  const queryService = createBuildingFilterQueryService({ db, rtreeState });
  const bboxCache = createLruCache({ max: 100, ttlMs: 10 * 1000 });
  const filterMatchesCache = createLruCache({ max: 220, ttlMs: 4000 });

  async function getFilterDataByKeys(rawKeys, actorKey) {
    if (!Array.isArray(rawKeys)) {
      return { status: 400, code: 'ERR_KEYS_ARRAY_REQUIRED', error: 'keys must be an array' };
    }

    const unique = [];
    const seen = new Set();
    for (const raw of rawKeys) {
      const parsed = parseOsmKey(raw);
      if (!parsed) continue;
      const key = `${parsed.osmType}/${parsed.osmId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      unique.push(parsed);
      if (unique.length >= FILTER_DATA_MAX_KEYS) break;
    }

    if (unique.length === 0) {
      return { items: [] };
    }

    const rows = await queryService.selectFilterDataRowsByKeys(unique);
    const outByKey = new Map();
    for (const row of rows) {
      const item = queryService.mapFilterDataRow(row);
      outByKey.set(item.osmKey, item);
    }

    return {
      items: await applyPersonalEditsToFilterItems([...outByKey.values()], actorKey)
    };
  }

  async function getFilterDataByBbox(query, actorKey) {
    const { bbox, error } = queryService.parseBboxInput(query, {
      minLon: 'minLon',
      minLat: 'minLat',
      maxLon: 'maxLon',
      maxLat: 'maxLat'
    });
    if (error) {
      return { status: 400, error };
    }

    const limit = Math.max(1, Math.min(FILTER_DATA_BBOX_MAX_LIMIT, Number(query?.limit) || FILTER_DATA_BBOX_DEFAULT_LIMIT));
    const { minLon, minLat, maxLon, maxLat } = bbox;
    const queryMode = queryService.getBboxQueryMode();
    const cacheKey = `${actorKey || 'anon'}:${minLon.toFixed(5)}:${minLat.toFixed(5)}:${maxLon.toFixed(5)}:${maxLat.toFixed(5)}:${limit}:${queryMode}`;
    const cached = bboxCache.get(cacheKey);
    if (cached) {
      return { payload: cached };
    }

    const rows = await queryService.selectFilterRowsByBbox(minLon, minLat, maxLon, maxLat, limit);
    const items = await applyPersonalEditsToRows(rows, actorKey, applyPersonalEditsToFilterItems, queryService.mapFilterDataRow);
    const payload = { items, truncated: rows.length >= limit };
    bboxCache.set(cacheKey, payload);
    return { payload };
  }

  async function getBatchFilterMatches(body = {}, actorKeyRaw = null) {
    const startedAt = Date.now();
    const { bbox, error } = queryService.parseBboxInput(
      body?.bbox && typeof body.bbox === 'object' ? body.bbox : body,
      { minLon: 'west', minLat: 'south', maxLon: 'east', maxLat: 'north' }
    );
    if (error) {
      return { status: 400, error };
    }

    const requestsRaw = body?.requests;
    if (!Array.isArray(requestsRaw)) {
      return { status: 400, code: 'ERR_REQUESTS_ARRAY_REQUIRED', error: 'requests must be an array' };
    }
    if (requestsRaw.length > FILTER_MATCH_BATCH_MAX_REQUESTS) {
      return { status: 400, code: 'ERR_TOO_MANY_REQUESTS', error: `Too many requests (maximum ${FILTER_MATCH_BATCH_MAX_REQUESTS})` };
    }

    const normalizedRequests = [];
    for (const request of requestsRaw) {
      const parsed = normalizeFilterMatchRequest(request, { isFilterTagAllowed });
      if (parsed.error) {
        return { status: 400, error: parsed.error };
      }
      normalizedRequests.push(parsed.value);
    }

    const { minLon, minLat, maxLon, maxLat } = bbox;
    const zoomBucket = resolveZoomBucket(body);
    const bboxHash = buildBboxHash(minLon, minLat, maxLon, maxLat);
    const actorKey = normalizeActorKey(actorKeyRaw) || 'anon';
    const queryMode = queryService.getBboxQueryMode();
    const cacheKey = `${actorKey}:batch:${bboxHash}:${zoomBucket}:${queryMode}:${normalizedRequests.map((request) => `${request.id}:${request.rulesHash}:${request.maxResults}`).join('|')}`;
    const cached = filterMatchesCache.get(cacheKey);
    if (cached) {
      return {
        payload: {
          items: (Array.isArray(cached?.items) ? cached.items : []).map((item) => ({
            ...item,
            meta: {
              ...(item?.meta || {}),
              cacheHit: true,
              elapsedMs: Date.now() - startedAt
            }
          })),
          meta: {
            elapsedMs: Date.now() - startedAt,
            cacheHit: true
          }
        }
      };
    }

    if (normalizedRequests.length === 0) {
      return {
        payload: {
          items: [],
          meta: {
            elapsedMs: Date.now() - startedAt,
            cacheHit: false
          }
        }
      };
    }

    const allTagOnly = normalizedRequests.every((request) => splitPostgresPushdownRules(request.rules).fallbackRules.length === 0);
    const candidateLimit = getBatchFilterMatchCandidateLimit(normalizedRequests);
    const candidateRows = await queryService.selectFilterRowsByBbox(
      minLon,
      minLat,
      maxLon,
      maxLat,
      candidateLimit,
      { tagsOnly: actorKey === 'anon' && allTagOnly }
    );
    const candidateItems = actorKey === 'anon'
      ? candidateRows.map(queryService.mapFilterDataRow)
      : await applyPersonalEditsToRows(candidateRows, actorKeyRaw, applyPersonalEditsToFilterItems, queryService.mapFilterDataRow);
    const elapsedMs = Date.now() - startedAt;
    const items = buildFilterMatchBatchResults(candidateItems, normalizedRequests, {
      bboxHash,
      elapsedMs,
      cacheHit: false,
      forceTruncated: candidateRows.length >= candidateLimit
    });
    const payload = {
      items,
      meta: {
        elapsedMs,
        cacheHit: false
      }
    };
    filterMatchesCache.set(cacheKey, payload);
    return { payload };
  }

  async function getFilterMatches(body = {}, actorKeyRaw = null) {
    const startedAt = Date.now();
    const { bbox, error } = queryService.parseBboxInput(
      body?.bbox && typeof body.bbox === 'object' ? body.bbox : body,
      { minLon: 'west', minLat: 'south', maxLon: 'east', maxLat: 'north' }
    );
    if (error) {
      return { status: 400, error };
    }

    const rulesRaw = body?.rules;
    if (!Array.isArray(rulesRaw)) {
      return { status: 400, code: 'ERR_RULES_ARRAY_REQUIRED', error: 'rules must be an array' };
    }
    if (rulesRaw.length > FILTER_MATCH_MAX_RULES) {
      return { status: 400, code: 'ERR_TOO_MANY_RULES', error: `Too many rules (maximum ${FILTER_MATCH_MAX_RULES})` };
    }

    const normalizedRules = [];
    for (const entry of rulesRaw) {
      const parsed = normalizeFilterRule(entry, { isFilterTagAllowed });
      if (parsed.error) {
        return { status: 400, error: parsed.error };
      }
      normalizedRules.push(parsed.value);
    }

    const maxResultsRaw = Number(body?.maxResults ?? body?.limit);
    const maxResults = Math.max(
      1,
      Math.min(FILTER_MATCH_MAX_RESULTS, Number.isFinite(maxResultsRaw) ? maxResultsRaw : FILTER_MATCH_DEFAULT_RESULTS)
    );
    const { minLon, minLat, maxLon, maxLat } = bbox;
    const rulesHash = String(body?.rulesHash || '').trim() || stableRulesHash(normalizedRules);
    const bboxHash = buildBboxHash(minLon, minLat, maxLon, maxLat);
    const zoomBucket = resolveZoomBucket(body);
    const actorKey = normalizeActorKey(actorKeyRaw) || 'anon';
    const queryMode = queryService.getBboxQueryMode();
    const cacheKey = `${actorKey}:${rulesHash}:${bboxHash}:${zoomBucket}:${maxResults}:${queryMode}`;
    const cached = filterMatchesCache.get(cacheKey);
    if (cached) {
      return {
        payload: {
          ...cached,
          meta: {
            ...cached.meta,
            cacheHit: true,
            elapsedMs: Date.now() - startedAt
          }
        }
      };
    }

    if (normalizedRules.length === 0) {
      const payload = {
        matchedKeys: [],
        matchedFeatureIds: [],
        meta: {
          rulesHash,
          bboxHash,
          truncated: false,
          elapsedMs: Date.now() - startedAt,
          cacheHit: false
        }
      };
      filterMatchesCache.set(cacheKey, payload);
      return { payload };
    }

    const matchedKeys = [];
    const matchedFeatureIds = [];
    let truncated = false;

    if (queryService.isPostgres && actorKey === 'anon') {
      const splitRules = splitPostgresPushdownRules(normalizedRules);
      const rows = splitRules.fallbackRules.length === 0
        ? await queryService.selectTagOnlyPostgresMatchRowsByBbox({
          minLon,
          minLat,
          maxLon,
          maxLat,
          rules: splitRules.tagOnlyRules,
          maxResults
        })
        : null;

      if (rows) {
        const limitedRows = rows.length > maxResults ? rows.slice(0, maxResults) : rows;
        truncated = rows.length > maxResults;
        for (const row of limitedRows) {
          const osmType = String(row.osm_type || '');
          const osmId = Number(row.osm_id);
          if (!['way', 'relation'].includes(osmType) || !Number.isInteger(osmId)) continue;
          matchedKeys.push(`${osmType}/${osmId}`);
          matchedFeatureIds.push(encodeOsmFeatureId(osmType, osmId));
        }
      } else {
        const candidateLimit = getFilterMatchCandidateLimit(normalizedRules, maxResults);
        const candidateRows = await queryService.selectGuardedPostgresCandidateRowsByBbox({
          minLon,
          minLat,
          maxLon,
          maxLat,
          rules: normalizedRules,
          archiRules: splitRules.fallbackRules,
          candidateLimit
        });
        const candidateItems = candidateRows.map(queryService.mapFilterDataRow);
        for (let index = 0; index < candidateItems.length; index += 1) {
          const item = candidateItems[index];
          const ok = normalizedRules.every((rule) => matchesFilterRule(item, rule));
          if (!ok) continue;
          matchedKeys.push(item.osmKey);
          const parsed = parseOsmKey(item.osmKey);
          if (parsed) {
            matchedFeatureIds.push(encodeOsmFeatureId(parsed.osmType, parsed.osmId));
          }
          if (matchedKeys.length >= maxResults) {
            truncated = true;
            break;
          }
        }
        if (!truncated && candidateRows.length >= candidateLimit) {
          truncated = true;
        }
      }
    } else {
      const candidateLimit = getFilterMatchCandidateLimit(normalizedRules, maxResults);
      const candidateRows = await queryService.selectFilterRowsByBbox(minLon, minLat, maxLon, maxLat, candidateLimit);
      const candidateItems = await applyPersonalEditsToRows(
        candidateRows,
        actorKeyRaw,
        applyPersonalEditsToFilterItems,
        queryService.mapFilterDataRow
      );
      for (let index = 0; index < candidateItems.length; index += 1) {
        const item = candidateItems[index];
        const ok = normalizedRules.every((rule) => matchesFilterRule(item, rule));
        if (!ok) continue;
        matchedKeys.push(item.osmKey);
        const parsed = parseOsmKey(item.osmKey);
        if (parsed) {
          matchedFeatureIds.push(encodeOsmFeatureId(parsed.osmType, parsed.osmId));
        }
        if (matchedKeys.length >= maxResults) {
          truncated = true;
          break;
        }
      }
      if (!truncated && candidateRows.length >= candidateLimit) {
        truncated = true;
      }
    }

    const payload = {
      matchedKeys,
      matchedFeatureIds,
      meta: {
        rulesHash,
        bboxHash,
        truncated,
        elapsedMs: Date.now() - startedAt,
        cacheHit: false
      }
    };
    filterMatchesCache.set(cacheKey, payload);
    return { payload };
  }

  return {
    getBatchFilterMatches,
    getFilterDataByBbox,
    getFilterDataByKeys,
    getFilterMatches
  };
}

module.exports = {
  buildFilterMatchBatchResults,
  createBuildingFiltersService,
  matchesFilterRule,
  normalizeFilterMatchRequest,
  normalizeFilterRule
};
