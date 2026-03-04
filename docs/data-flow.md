# Data Flow

## Primary ingest pipeline

1. OSM source (`OSM_EXTRACT_QUERY|OSM_EXTRACT_QUERIES|OSM_PBF_PATH`) is processed by [`scripts/sync-osm-buildings.js`](../scripts/sync-osm-buildings.js).
2. Geometry/metadata are upserted into `osm.building_contours` (+ RTree mirrors).
3. Tippecanoe builds `data/buildings.pmtiles` (or `BUILDINGS_PMTILES_FILE`).
4. Search index rebuild worker materializes FTS source/index for `/api/search-buildings`.

## Runtime request flow

1. UI requests map config from `/app-config.js`.
2. MapLibre loads style JSON from `/styles/*.json`.
3. PMTiles protocol reads `/api/buildings.pmtiles` using HTTP Range requests.
4. Side panels/modals query `/api/building/*`, `/api/building-info/*`, `/api/search-buildings`, `/api/buildings/filter-data-bbox`.

## Potential bottlenecks

- `COUNT/MAX` on large `osm.building_contours` for `/api/contours-status`.
- Wide bbox requests with large `limit`.
- Search fallback path during index rebuild.
- PMTiles random reads under high concurrency if cache is cold.

## Cache layers

- Browser cache via `Cache-Control`, `ETag`, `Last-Modified`.
- Server in-memory LRU for:
  - search query results (`/api/search-buildings`)
  - bbox filter payloads (`/api/buildings/filter-data-bbox`)
- Client in-memory cache:
  - search responses (`apiJsonCached`).
