export const FILTER_HIGHLIGHT_MODE = 'layer';
export const EMPTY_LAYER_FILTER = ['==', ['id'], -1];

function normalizeIds(values) {
  return Array.isArray(values)
    ? [...new Set(values.map((id) => Number(id)).filter((id) => Number.isInteger(id) && id >= 0))]
    : [];
}

export function buildFilterHighlightExpression(matched) {
  const encodedIds = normalizeIds(Array.isArray(matched) ? matched : matched?.encodedIds);
  const osmIds = normalizeIds(Array.isArray(matched) ? [] : matched?.osmIds);
  const clauses = [];

  if (encodedIds.length > 0) {
    clauses.push(['match', ['id'], ['literal', encodedIds], true, false]);
  }
  if (osmIds.length > 0) {
    clauses.push(['match', ['to-number', ['coalesce', ['get', 'osm_id'], -1]], ['literal', osmIds], true, false]);
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
