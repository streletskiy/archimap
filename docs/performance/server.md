# Server Performance

## Implemented

- Prepared statements promoted to module scope in hot handlers:
  - `src/lib/server/http/contours-status.route.js`
  - `src/lib/server/http/buildings.route.js`
- Conditional caching helper:
  - `src/lib/server/infra/http-cache.infra.js`
  - Adds `ETag`, optional `Last-Modified`, `304` support.
- JSON compression for cached responses:
  - `br` preferred, fallback `gzip` when payload is large.
- In-process LRU (`src/lib/server/infra/lru-cache.infra.js`):
  - search results
  - bbox filter payloads
- Rate limiting:
  - `POST /api/buildings/filter-data` has a dedicated limiter tuned for interactive map filtering (`src/lib/server/boot/rate-limiters.boot.js`, `filterDataRateLimiter`).
  - `POST /api/buildings/filter-matches` has its own limiter for bbox+rules interactive workloads (`src/lib/server/boot/rate-limiters.boot.js`, `filterMatchesRateLimiter`).
- `POST /api/buildings/filter-matches` uses adaptive PostgreSQL strategy for anonymous users:
  - tag-only rules (`contains|equals|not_equals|starts_with|exists|not_exists`) are compiled to SQL predicates;
  - spatial bbox is compiled once via `env` CTE (`ST_MakeEnvelope` + `ST_Intersects`);
  - for tag-only rule sets, query returns only `(osm_type, osm_id)` and builds `matchedKeys/matchedFeatureIds` in Node;
  - for rule sets that need `architectural_info` fallback (`archi.*` and known archi keys), route keeps the JS filtering path but prefilters candidates with SQL guard predicates to drop impossible rows before JS;
  - fallback branch selects only the `architectural_info` columns referenced by active rules (plus `osm_id`) to reduce join payload;
  - authenticated users keep JS fallback path (personal edits merge semantics unchanged).
- PostGIS bbox paths use a single envelope CTE:
  - `GET /api/buildings/filter-data-bbox`
  - filter candidates for `POST /api/buildings/filter-matches` fallback path.
- Long `(a=? AND b=?) OR ...` chains replaced with `VALUES + JOIN` in PostgreSQL paths:
  - `POST /api/buildings/filter-data`
  - `getUserPersonalEditsByKeys` (`building-edits.service`)
- `/api/contours-status` fast path reads from `osm.building_contours_summary` (1 row), with aggregate fallback if summary is empty/unavailable.
- OSM sync for PostgreSQL updates `osm.building_contours_summary` in the same import transaction.
- Search source normalization uses raw DB rows plus Node-side JSON parsing in `src/lib/server/services/search-index-source.service.js`, shared by incremental refresh and full rebuild worker.
  - PostgreSQL stores searchable rows in `building_search_source` with generated `search_tsv`.
  - SQLite keeps `building_search_source` plus `building_search_fts`.
- `rebuild-filter-tag-keys-cache.worker` (PostgreSQL) switched from row-by-row insert to set-based `INSERT ... SELECT DISTINCT`.

## DB and indexes

- Search and bbox rely on existing indexes and RTree, initialized in:
  - `src/lib/server/infra/db-bootstrap.infra.js`
- Search query path already uses FTS and ordered ranking in:
  - `src/lib/server/services/search.service.js`
- PostgreSQL migration `003_contours_summary.sql`:
  - adds `osm.building_contours_summary` and initial backfill;
  - drops redundant `local.idx_architectural_info_osm` (duplicated by `UNIQUE (osm_type, osm_id)`);
  - keeps spatial GIST index unchanged (`idx_building_contours_geom_gist`).

## Remaining heavy query

- Full aggregate fallback in `/api/contours-status` (`COUNT(*)`, `MAX(updated_at)`) is available for safety.
- For very complex `contains` filters in huge bboxes, planner/index selectivity can dominate p95 and should be monitored with `EXPLAIN ANALYZE`.
