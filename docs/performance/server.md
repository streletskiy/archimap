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

## DB and indexes
- Search and bbox rely on existing indexes and RTree, initialized in:
  - `src/lib/server/infra/db-bootstrap.infra.js`
- Search query path already uses FTS and ordered ranking in:
  - `src/lib/server/services/search.service.js`

## Remaining heavy query
- `/api/contours-status` uses aggregate:
  - `COUNT(*)`, `MAX(updated_at)` over `osm.building_contours`
- This remains the main p95 outlier and candidate for precomputed summary table.
