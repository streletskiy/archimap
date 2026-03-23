import { clampText } from '$lib/utils/text';

export function normalizeSearchViewport(viewport) {
  const west = Number(viewport?.west);
  const south = Number(viewport?.south);
  const east = Number(viewport?.east);
  const north = Number(viewport?.north);
  if (![west, south, east, north].every(Number.isFinite) || west >= east || south >= north) {
    return null;
  }
  return { west, south, east, north };
}

export function buildSearchViewportHash(viewport) {
  if (!viewport) return '';
  return [
    Number(viewport.west).toFixed(4),
    Number(viewport.south).toFixed(4),
    Number(viewport.east).toFixed(4),
    Number(viewport.north).toFixed(4)
  ].join(':');
}

export function appendSearchViewportParams(params, viewport) {
  if (!viewport) return;
  params.set('west', String(viewport.west));
  params.set('south', String(viewport.south));
  params.set('east', String(viewport.east));
  params.set('north', String(viewport.north));
}

export function buildSearchRequestParams({ query, center, viewport, limit, cursor = null }: LooseRecord = {}) {
  const params = new URLSearchParams({
    q: clampText(query),
    limit: String(limit)
  });

  if (Number.isFinite(Number(center?.lng)) && Number.isFinite(Number(center?.lat))) {
    params.set('lon', String(center.lng));
    params.set('lat', String(center.lat));
  }

  appendSearchViewportParams(params, viewport);

  if (Number.isFinite(Number(cursor)) && Number(cursor) > 0) {
    params.set('cursor', String(Number(cursor)));
  }

  return params;
}

export function mergeChunkedSearchResults(chunks) {
  const merged = [];
  const seen = new Set();

  for (const chunk of Array.isArray(chunks) ? chunks : []) {
    const items = Array.isArray(chunk) ? chunk : Array.isArray(chunk?.items) ? chunk.items : [];
    for (const item of items) {
      const key = `${String(item?.osmType || '')}/${String(item?.osmId || '')}`;
      if (!key || seen.has(key)) continue;
      seen.add(key);
      merged.push(item);
    }
  }

  return merged;
}
