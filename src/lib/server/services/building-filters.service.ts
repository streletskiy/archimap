const { createLruCache } = require('../infra/lru-cache.infra');
const { createBuildingFilterQueryService } = require('./building-filter-query.service');
const {
  normalizeRenderMode,
  shouldAggregateMarkerMatches,
  getMarkerAggregationLegacyCellSize,
  getMarkerAggregationGridShape,
  buildMarkerAggregationCellKey,
  buildMarkerAggregationCellId
} = require('./building-filter-marker-aggregation');
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

function normalizeFilterRule(rule: LooseRecord, _options: LooseRecord = {}) {
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
    return getRuleValue(item, key.slice(6));
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
  if (key === 'roof:shape' || key === 'roof_shape' || key === 'building:roof:shape') {
    if (hasMeaningfulValue(archiInfo.roof_shape)) return archiInfo.roof_shape;
    if (Object.prototype.hasOwnProperty.call(sourceTags, 'roof:shape')) return sourceTags['roof:shape'];
    if (Object.prototype.hasOwnProperty.call(sourceTags, 'roof_shape')) return sourceTags.roof_shape;
    if (Object.prototype.hasOwnProperty.call(sourceTags, 'building:roof:shape')) return sourceTags['building:roof:shape'];
  }
  if (key === 'building:architecture' || key === 'architecture' || key === 'style') {
     if (hasMeaningfulValue(archiInfo.style)) return archiInfo.style;
  }
  if (key === 'building:levels' || key === 'levels') {
     if (hasMeaningfulValue(archiInfo.levels)) return archiInfo.levels;
     if (hasMeaningfulValue(item?.levels)) return item.levels;
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
  if (key === 'design') {
     if (hasMeaningfulValue(archiInfo.design)) return archiInfo.design;
  }
  if (key === 'design:ref' || key === 'design_ref') {
     if (hasMeaningfulValue(archiInfo.design_ref)) return archiInfo.design_ref;
     if (Object.prototype.hasOwnProperty.call(sourceTags, 'design:ref')) return sourceTags['design:ref'];
     if (Object.prototype.hasOwnProperty.call(sourceTags, 'design_ref')) return sourceTags.design_ref;
  }
  if (key === 'design:year' || key === 'design_year') {
     if (hasMeaningfulValue(archiInfo.design_year)) return archiInfo.design_year;
     if (Object.prototype.hasOwnProperty.call(sourceTags, 'design:year')) return sourceTags['design:year'];
     if (Object.prototype.hasOwnProperty.call(sourceTags, 'design_year')) return sourceTags.design_year;
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
  matchedLocations = [],
  matchedCount = null,
  rulesHash = 'fnv1a-0',
  bboxHash = '',
  truncated = false,
  elapsedMs = 0,
  cacheHit = false
} = {}) {
  const payload = {
    matchedKeys,
    matchedFeatureIds,
    matchedLocations,
    ...(matchedCount != null ? { matchedCount: Number(matchedCount) || 0 } : {}),
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

function normalizeFilterMatchRequest(request: LooseRecord, { isFilterTagAllowed }: LooseRecord = {}) {
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

function buildFilterMatchResultForRules(items, rules, maxResults, {
  bbox = null,
  renderMode = 'contours',
  zoomBucket = 0
} = {}) {
  const matchedKeys = [];
  const matchedFeatureIds = [];
  const matchedLocations = [];
  const aggregateMarkers = shouldAggregateMarkerMatches(renderMode, zoomBucket);
  const safeMaxResults = aggregateMarkers
    ? FILTER_MATCH_CANDIDATE_CAP
    : Math.max(1, Math.trunc(Number(maxResults) || FILTER_MATCH_DEFAULT_RESULTS));
  let truncated = false;
  let matchedCount = 0;

  if (aggregateMarkers) {
    const markerGrid = getMarkerAggregationGridShape(zoomBucket, bbox);
    const markerBBox = markerGrid.bbox;
    const gridKey = markerBBox
      ? `${markerGrid.columns}x${markerGrid.rows}`
      : `${getMarkerAggregationLegacyCellSize(zoomBucket)}`;
    const cells = new Map();

    for (let index = 0; index < items.length; index += 1) {
      const item = items[index];
      const ok = rules.every((rule) => matchesFilterRule(item, rule));
      if (!ok) continue;
      matchedCount += 1;
      const lon = Number(item.centerLon);
      const lat = Number(item.centerLat);
      if (!Number.isFinite(lon) || !Number.isFinite(lat)) {
        continue;
      }
      let cellX = 0;
      let cellY = 0;
      let centerLon = lon;
      let centerLat = lat;
      if (markerBBox) {
        const cellWidth = markerBBox.width / markerGrid.columns;
        const cellHeight = markerBBox.height / markerGrid.rows;
        if (cellWidth > 0 && cellHeight > 0) {
          cellX = Math.max(0, Math.min(markerGrid.columns - 1, Math.floor((lon - markerBBox.west) / cellWidth)));
          cellY = Math.max(0, Math.min(markerGrid.rows - 1, Math.floor((lat - markerBBox.south) / cellHeight)));
          centerLon = markerBBox.west + ((cellX + 0.5) * cellWidth);
          centerLat = markerBBox.south + ((cellY + 0.5) * cellHeight);
        }
      } else {
        const cellSize = getMarkerAggregationLegacyCellSize(zoomBucket);
        cellX = Math.floor((lon + 180) / cellSize);
        cellY = Math.floor((lat + 90) / cellSize);
        centerLon = ((cellX + 0.5) * cellSize) - 180;
        centerLat = ((cellY + 0.5) * cellSize) - 90;
      }
      const key = buildMarkerAggregationCellKey(zoomBucket, gridKey, cellX, cellY);
      let cell = cells.get(key);
      if (!cell) {
        cell = {
          id: buildMarkerAggregationCellId(key),
          key,
          cellX,
          cellY,
          lonSum: 0,
          latSum: 0,
          count: 0
        };
        cells.set(key, cell);
      }
      cell.lonSum += centerLon;
      cell.latSum += centerLat;
      cell.count += 1;
    }

    const limitedCells = [...cells.values()]
      .sort((left, right) => left.id - right.id)
      .slice(0, safeMaxResults);
    truncated = cells.size > limitedCells.length;
    for (const cell of limitedCells) {
      matchedKeys.push(cell.key);
      matchedFeatureIds.push(cell.id);
      matchedLocations.push({
        id: cell.id,
        lon: cell.lonSum / cell.count,
        lat: cell.latSum / cell.count,
        count: cell.count,
        osmKey: cell.key
      });
    }

    return {
      matchedKeys,
      matchedFeatureIds,
      matchedLocations,
      matchedCount,
      truncated
    };
  }

  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    const ok = rules.every((rule) => matchesFilterRule(item, rule));
    if (!ok) continue;
    matchedCount += 1;
    matchedKeys.push(item.osmKey);
    const parsed = parseOsmKey(item.osmKey);
    if (parsed) {
      const featureId = encodeOsmFeatureId(parsed.osmType, parsed.osmId);
      matchedFeatureIds.push(featureId);
      const lon = Number(item.centerLon);
      const lat = Number(item.centerLat);
      if (Number.isFinite(lon) && Number.isFinite(lat)) {
        matchedLocations.push({
          id: featureId,
          lon,
          lat,
          count: 1,
          osmKey: item.osmKey
        });
      }
    }
    if (matchedCount >= safeMaxResults) {
      truncated = true;
      break;
    }
  }

  return {
    matchedKeys,
    matchedFeatureIds,
    matchedLocations,
    matchedCount,
    truncated
  };
}

function buildFilterMatchBatchResults(items, requests, {
  bbox = null,
  bboxHash = '',
  elapsedMs = 0,
  cacheHit = false,
  forceTruncated = false,
  renderMode = 'contours',
  zoomBucket = 0
} = {}) {
  return (Array.isArray(requests) ? requests : []).map((request) => {
    const result = buildFilterMatchResultForRules(
      Array.isArray(items) ? items : [],
      Array.isArray(request?.rules) ? request.rules : [],
      Number(request?.maxResults || FILTER_MATCH_DEFAULT_RESULTS),
      {
        bbox,
        renderMode,
        zoomBucket
      }
    );
    return buildFilterMatchPayload({
      id: request?.id,
      matchedKeys: result.matchedKeys,
      matchedFeatureIds: result.matchedFeatureIds,
      matchedLocations: result.matchedLocations,
      matchedCount: result.matchedCount,
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

function resolveZoomBucket(body: LooseRecord = {}) {
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
}: LooseRecord) {
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

  async function getFilterDataByBbox(query: LooseRecord, actorKey) {
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

  async function getBatchFilterMatches(body: LooseRecord = {}, actorKeyRaw = null) {
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
    const renderMode = normalizeRenderMode(body?.renderMode);
    const bboxHash = buildBboxHash(minLon, minLat, maxLon, maxLat);
    const actorKey = normalizeActorKey(actorKeyRaw) || 'anon';
    const queryMode = queryService.getBboxQueryMode();
    const cacheKey = `${actorKey}:batch:${bboxHash}:${zoomBucket}:${renderMode}:${queryMode}:${normalizedRequests.map((request) => `${request.id}:${request.rulesHash}:${request.maxResults}`).join('|')}`;
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
      bbox,
      bboxHash,
      elapsedMs,
      cacheHit: false,
      forceTruncated: candidateRows.length >= candidateLimit,
      renderMode,
      zoomBucket
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

  async function getFilterMatches(body: LooseRecord = {}, actorKeyRaw = null) {
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
    const renderMode = normalizeRenderMode(body?.renderMode);
    const bboxHash = buildBboxHash(minLon, minLat, maxLon, maxLat);
    const zoomBucket = resolveZoomBucket(body);
    const actorKey = normalizeActorKey(actorKeyRaw) || 'anon';
    const queryMode = queryService.getBboxQueryMode();
    const cacheKey = `${actorKey}:${rulesHash}:${bboxHash}:${zoomBucket}:${renderMode}:${maxResults}:${queryMode}`;
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
        matchedLocations: [],
        matchedCount: 0,
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

    let matchedResult;
    if (queryService.isPostgres && actorKey === 'anon') {
      const splitRules = splitPostgresPushdownRules(normalizedRules);
      const aggregateMarkers = shouldAggregateMarkerMatches(renderMode, zoomBucket);
      const tagOnlyMaxResults = aggregateMarkers ? FILTER_MATCH_CANDIDATE_CAP : maxResults;
      const rows = splitRules.fallbackRules.length === 0
        ? await queryService.selectTagOnlyPostgresMatchRowsByBbox({
          minLon,
          minLat,
          maxLon,
          maxLat,
          rules: splitRules.tagOnlyRules,
          maxResults: tagOnlyMaxResults
        })
        : null;

      if (rows) {
        const candidateItems = rows.map(queryService.mapFilterDataRow);
        matchedResult = buildFilterMatchResultForRules(candidateItems, normalizedRules, maxResults, {
          bbox,
          renderMode,
          zoomBucket
        });
        matchedResult.truncated = rows.length > tagOnlyMaxResults || matchedResult.truncated;
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
        matchedResult = buildFilterMatchResultForRules(candidateItems, normalizedRules, maxResults, {
          bbox,
          renderMode,
          zoomBucket
        });
        matchedResult.truncated = candidateRows.length >= candidateLimit || matchedResult.truncated;
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
      matchedResult = buildFilterMatchResultForRules(candidateItems, normalizedRules, maxResults, {
        bbox,
        renderMode,
        zoomBucket
      });
      matchedResult.truncated = candidateRows.length >= candidateLimit || matchedResult.truncated;
    }

    const payload = {
      matchedKeys: matchedResult.matchedKeys,
      matchedFeatureIds: matchedResult.matchedFeatureIds,
      matchedLocations: matchedResult.matchedLocations,
      matchedCount: matchedResult.matchedCount,
      meta: {
        rulesHash,
        bboxHash,
        truncated: matchedResult.truncated,
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
