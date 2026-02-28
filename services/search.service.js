function createSearchService(options = {}) {
  const db = options.db;
  const isRebuildInProgress = typeof options.isRebuildInProgress === 'function'
    ? options.isRebuildInProgress
    : () => false;
  const defaultLon = Number.isFinite(options.defaultLon) ? Number(options.defaultLon) : 44.0059;
  const defaultLat = Number.isFinite(options.defaultLat) ? Number(options.defaultLat) : 56.3269;

  function normalizeSearchTokens(queryText) {
    return [...new Set(
      String(queryText || '')
        .trim()
        .split(/\s+/)
        .map((token) => token.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ''))
        .filter(Boolean)
    )].slice(0, 8);
  }

  function buildFtsMatchQuery(tokens) {
    return tokens
      .map((token) => {
        const safe = token.replace(/"/g, '""');
        return `"${safe}"*`;
      })
      .join(' AND ');
  }

  function getLocalEditsSearchResults(tokens, centerLon, centerLat, limit = 30, cursor = 0) {
    const cappedLimit = Math.max(1, Math.min(60, Number(limit) || 30));
    const offset = Math.max(0, Math.min(10000, Number(cursor) || 0));
    const lon = Number.isFinite(centerLon) ? centerLon : defaultLon;
    const lat = Number.isFinite(centerLat) ? centerLat : defaultLat;

    const whereTokenClauses = [];
    const whereParams = [];
    for (const token of tokens) {
      const pattern = `%${token}%`;
      whereTokenClauses.push(`(
        coalesce(ai.name, '') LIKE ? OR
        coalesce(ai.address, '') LIKE ? OR
        coalesce(ai.style, '') LIKE ? OR
        coalesce(ai.architect, '') LIKE ?
      )`);
      whereParams.push(pattern, pattern, pattern, pattern);
    }

    const whereSql = whereTokenClauses.length > 0 ? whereTokenClauses.join(' AND ') : '1=1';
    const rows = db.prepare(`
      WITH src AS (
        SELECT
          ai.osm_type,
          ai.osm_id,
          ai.name,
          ai.address,
          ai.style,
          ai.architect,
          ai.updated_at,
          ((bc.min_lon + bc.max_lon) / 2.0) AS center_lon,
          ((bc.min_lat + bc.max_lat) / 2.0) AS center_lat
        FROM local.architectural_info ai
        LEFT JOIN building_contours bc
          ON bc.osm_type = ai.osm_type AND bc.osm_id = ai.osm_id
        WHERE bc.osm_id IS NOT NULL AND (${whereSql})
      )
      SELECT
        osm_type,
        osm_id,
        name,
        address,
        style,
        architect,
        center_lon,
        center_lat,
        ((center_lon - ?) * (center_lon - ?) + (center_lat - ?) * (center_lat - ?)) AS distance2
      FROM src
      ORDER BY distance2 ASC, updated_at DESC
      LIMIT ? OFFSET ?
    `).all(...whereParams, lon, lon, lat, lat, cappedLimit + 1, offset);

    const hasMore = rows.length > cappedLimit;
    const sliced = hasMore ? rows.slice(0, cappedLimit) : rows;
    const nextCursor = hasMore ? offset + cappedLimit : null;
    return {
      items: sliced.map((row) => ({
        osmType: row.osm_type,
        osmId: row.osm_id,
        name: row.name || null,
        address: row.address || null,
        style: row.style || null,
        architect: row.architect || null,
        lon: Number.isFinite(Number(row.center_lon)) ? Number(row.center_lon) : null,
        lat: Number.isFinite(Number(row.center_lat)) ? Number(row.center_lat) : null,
        score: 0
      })),
      nextCursor,
      hasMore
    };
  }

  function getBuildingSearchResults(queryText, centerLon, centerLat, limit = 30, cursor = 0) {
    const tokens = normalizeSearchTokens(queryText);
    if (tokens.length === 0) {
      return { items: [], nextCursor: null, hasMore: false };
    }

    if (isRebuildInProgress()) {
      return getLocalEditsSearchResults(tokens, centerLon, centerLat, limit, cursor);
    }

    const matchQuery = buildFtsMatchQuery(tokens);
    const cappedLimit = Math.max(1, Math.min(60, Number(limit) || 30));
    const offset = Math.max(0, Math.min(10000, Number(cursor) || 0));
    const lon = Number.isFinite(centerLon) ? centerLon : defaultLon;
    const lat = Number.isFinite(centerLat) ? centerLat : defaultLat;

    const rows = db.prepare(`
      WITH matched AS (
        SELECT osm_key, bm25(building_search_fts) AS rank
        FROM building_search_fts
        WHERE building_search_fts MATCH ?
      )
      SELECT
        s.osm_type,
        s.osm_id,
        s.name,
        s.address,
        s.style,
        s.architect,
        s.center_lon,
        s.center_lat,
        s.local_priority,
        m.rank,
        ((s.center_lon - ?) * (s.center_lon - ?) + (s.center_lat - ?) * (s.center_lat - ?)) AS distance2
      FROM matched m
      JOIN building_search_source s ON s.osm_key = m.osm_key
      ORDER BY s.local_priority DESC, m.rank ASC, distance2 ASC, s.osm_type ASC, s.osm_id ASC
      LIMIT ? OFFSET ?
    `).all(matchQuery, lon, lon, lat, lat, cappedLimit + 1, offset);

    const hasMore = rows.length > cappedLimit;
    const sliced = hasMore ? rows.slice(0, cappedLimit) : rows;
    const nextCursor = hasMore ? offset + cappedLimit : null;

    return {
      items: sliced.map((row) => ({
        osmType: row.osm_type,
        osmId: row.osm_id,
        name: row.name || null,
        address: row.address || null,
        style: row.style || null,
        architect: row.architect || null,
        lon: Number.isFinite(Number(row.center_lon)) ? Number(row.center_lon) : null,
        lat: Number.isFinite(Number(row.center_lat)) ? Number(row.center_lat) : null,
        score: Number(row.rank || 0)
      })),
      nextCursor,
      hasMore
    };
  }

  return {
    normalizeSearchTokens,
    buildFtsMatchQuery,
    getLocalEditsSearchResults,
    getBuildingSearchResults
  };
}

module.exports = {
  createSearchService
};
