export const FILTER_HIGHLIGHT_MODE = 'layer';
export const EMPTY_LAYER_FILTER = ['==', ['id'], -1];
export const FILTER_TRANSPARENT_COLOR = 'transparent';
export const FILTER_HIGHLIGHT_FILL_OPACITY = 1;
export const FILTER_HIGHLIGHT_LINE_WIDTH = 1.8;
export const FILTER_HIGHLIGHT_LINE_OPACITY = 1;

function normalizeIds(values) {
  return Array.isArray(values)
    ? [...new Set(values.map((id) => Number(id)).filter((id) => Number.isInteger(id) && id >= 0))]
    : [];
}

function normalizeColor(rawColor, fallbackColor = FILTER_TRANSPARENT_COLOR) {
  const color = String(rawColor || '').trim();
  return color || fallbackColor;
}

export function normalizeFilterPaintColorGroups(colorGroups) {
  const groupedIds = new Map();
  const seenIds = new Set();

  for (const group of Array.isArray(colorGroups) ? colorGroups : []) {
    const color = normalizeColor(group?.color);
    if (color === FILTER_TRANSPARENT_COLOR) continue;
    const ids = normalizeIds(group?.ids).filter((id) => id > 0 && !seenIds.has(id));
    if (ids.length === 0) continue;
    const bucket = groupedIds.get(color) || [];
    for (const id of ids) {
      seenIds.add(id);
      bucket.push(id);
    }
    groupedIds.set(color, bucket);
  }

  return [...groupedIds.entries()].map(([color, ids]) => ({
    color,
    ids: [...ids].sort((left, right) => left - right)
  }));
}

function buildFilterPaintExpressionFromNormalizedGroups(normalizedGroups, fallbackColor = FILTER_TRANSPARENT_COLOR) {
  if (normalizedGroups.length === 0) {
    return {
      expr: fallbackColor,
      count: 0
    };
  }

  const expr = ['match', ['id']];
  let count = 0;
  for (const group of normalizedGroups) {
    expr.push(group.ids, group.color);
    count += group.ids.length;
  }
  expr.push(fallbackColor);

  return {
    expr,
    count
  };
}

export function buildFilterPaintExpression(colorGroups, fallbackColor = FILTER_TRANSPARENT_COLOR) {
  const normalizedGroups = normalizeFilterPaintColorGroups(colorGroups);
  return buildFilterPaintExpressionFromNormalizedGroups(normalizedGroups, fallbackColor);
}

export function buildFilterActiveValueExpression(colorGroups, activeValue, inactiveValue = 0) {
  const normalizedGroups = normalizeFilterPaintColorGroups(colorGroups);
  const activeIds = normalizedGroups.flatMap((group) => group.ids);

  if (activeIds.length === 0) {
    return {
      expr: inactiveValue,
      count: 0
    };
  }

  return {
    expr: ['match', ['id'], activeIds, activeValue, inactiveValue],
    count: activeIds.length
  };
}

function buildFilterMembershipExpressionFromNormalizedGroups(normalizedGroups) {
  if (normalizedGroups.length === 0) {
    return {
      expr: EMPTY_LAYER_FILTER,
      count: 0
    };
  }

  if (normalizedGroups.length === 1) {
    const ids = normalizedGroups[0]?.ids || [];
    return {
      expr: ['in', ['id'], ['literal', ids]],
      count: ids.length
    };
  }

  const activeIds = [];
  let count = 0;
  for (const group of normalizedGroups) {
    const ids = Array.isArray(group?.ids) ? group.ids : [];
    if (ids.length === 0) continue;
    activeIds.push(...ids);
    count += ids.length;
  }

  if (activeIds.length === 0) {
    return {
      expr: EMPTY_LAYER_FILTER,
      count: 0
    };
  }

  return {
    expr: ['in', ['id'], ['literal', activeIds]],
    count
  };
}

function combineFilterExpressions(expressions = []) {
  const normalized = expressions.filter(Boolean);
  if (normalized.length === 0) return EMPTY_LAYER_FILTER;
  if (normalized.length === 1) return normalized[0];
  return ['all', ...normalized];
}

export function applyFilterPaintHighlight({
  map,
  colorGroups,
  normalizedColorGroups,
  previousActive = false,
  forceStaticPaintProperties = false,
  fillLayerIds = [],
  lineLayerIds = [],
  additionalFilterExpression = null,
  onLayerPaintApplied
}) {
  if (!map) {
    return {
      active: false,
      count: 0,
      colorExpression: FILTER_TRANSPARENT_COLOR,
      filterExpression: EMPTY_LAYER_FILTER,
      fillOpacityExpression: 0,
      lineWidthExpression: 0,
      lineOpacityExpression: 0,
      paintPropertyCalls: 0
    };
  }

  const normalizedGroups = Array.isArray(normalizedColorGroups)
    ? normalizedColorGroups
    : normalizeFilterPaintColorGroups(colorGroups);
  const { expr: filterExpression, count } = buildFilterMembershipExpressionFromNormalizedGroups(normalizedGroups);
  const combinedFilterExpression = combineFilterExpressions([
    additionalFilterExpression,
    filterExpression
  ]);
  const active = count > 0;
  const colorExpression = !active
    ? FILTER_TRANSPARENT_COLOR
    : normalizedGroups.length === 1
      ? normalizedGroups[0].color
      : buildFilterPaintExpressionFromNormalizedGroups(normalizedGroups).expr;
  const fillOpacityExpression = active ? FILTER_HIGHLIGHT_FILL_OPACITY : 0;
  const lineWidthExpression = active ? FILTER_HIGHLIGHT_LINE_WIDTH : 0;
  const lineOpacityExpression = active ? FILTER_HIGHLIGHT_LINE_OPACITY : 0;
  const shouldApplyStaticPaintProperties = forceStaticPaintProperties || !active || !previousActive;
  let paintPropertyCalls = 0;

  for (const layerId of fillLayerIds) {
    if (!map.getLayer(layerId)) continue;
    map.setFilter(layerId, combinedFilterExpression);
    map.setPaintProperty(layerId, 'fill-color', colorExpression);
    paintPropertyCalls += 1;
    if (typeof onLayerPaintApplied === 'function') {
      onLayerPaintApplied(layerId, 'fill-color', colorExpression);
    }
    if (shouldApplyStaticPaintProperties) {
      map.setPaintProperty(layerId, 'fill-opacity', fillOpacityExpression);
      paintPropertyCalls += 1;
      if (typeof onLayerPaintApplied === 'function') {
        onLayerPaintApplied(layerId, 'fill-opacity', fillOpacityExpression);
      }
    }
  }

  for (const layerId of lineLayerIds) {
    if (!map.getLayer(layerId)) continue;
    map.setFilter(layerId, combinedFilterExpression);
    map.setPaintProperty(layerId, 'line-color', colorExpression);
    paintPropertyCalls += 1;
    if (typeof onLayerPaintApplied === 'function') {
      onLayerPaintApplied(layerId, 'line-color', colorExpression);
    }
    if (shouldApplyStaticPaintProperties) {
      map.setPaintProperty(layerId, 'line-width', lineWidthExpression);
      map.setPaintProperty(layerId, 'line-opacity', lineOpacityExpression);
      paintPropertyCalls += 2;
      if (typeof onLayerPaintApplied === 'function') {
        onLayerPaintApplied(layerId, 'line-width', lineWidthExpression);
        onLayerPaintApplied(layerId, 'line-opacity', lineOpacityExpression);
      }
    }
  }

  return {
    active,
    count,
    colorExpression,
    filterExpression: combinedFilterExpression,
    fillOpacityExpression,
    lineWidthExpression,
    lineOpacityExpression,
    paintPropertyCalls
  };
}

export function buildFilterHighlightExpression(matched) {
  const encodedIds = normalizeIds(Array.isArray(matched) ? matched : matched?.encodedIds);
  const osmIds = normalizeIds(Array.isArray(matched) ? [] : matched?.osmIds);
  const clauses = [];

  if (encodedIds.length > 0) {
    clauses.push(['in', ['id'], ['literal', encodedIds]]);
  }
  if (osmIds.length > 0) {
    clauses.push(['in', ['to-number', ['coalesce', ['get', 'osm_id'], -1]], ['literal', osmIds]]);
  }

  if (clauses.length === 0) return { expr: EMPTY_LAYER_FILTER, count: 0 };
  if (clauses.length === 1) {
    return { expr: clauses[0], count: Math.max(encodedIds.length, osmIds.length) };
  }
  return { expr: ['any', ...clauses], count: Math.max(encodedIds.length, osmIds.length) };
}

export function applyFilterHighlight({
  map,
  matched,
  fillLayerId,
  lineLayerId,
  onLayerFilterApplied
}) {
  if (!map) return { active: false, expr: EMPTY_LAYER_FILTER, count: 0 };
  const { expr, count } = buildFilterHighlightExpression(matched);
  const active = count > 0;
  const visibility = active ? 'visible' : 'none';
  const targets = [fillLayerId, lineLayerId].filter(Boolean);

  for (const layerId of targets) {
    if (!map.getLayer(layerId)) continue;
    map.setFilter(layerId, expr);
    map.setLayoutProperty(layerId, 'visibility', visibility);
    if (typeof onLayerFilterApplied === 'function') {
      onLayerFilterApplied(layerId, expr, count);
    }
  }

  return { active, expr, count };
}

export function hashFilterExpression(expr) {
  const raw = JSON.stringify(expr || EMPTY_LAYER_FILTER);
  let hash = 2166136261;
  for (let i = 0; i < raw.length; i += 1) {
    hash ^= raw.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `fnv1a-${(hash >>> 0).toString(16)}`;
}
