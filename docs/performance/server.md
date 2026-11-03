# Server Performance

## Implemented

- Prepared statements promoted to module scope in hot handlers:
  - `src/lib/server/http/contours-status.route.ts`
  - `src/lib/server/http/buildings.route.ts`
- Conditional caching helper:
  - `src/lib/server/infra/http-cache.infra.ts`
  - Adds `ETag`, optional `Last-Modified`, `304` support.
- JSON compression for cached responses:
  - `br` preferred, fallback `gzip` when payload is large.
- In-process LRU (`src/lib/server/infra/lru-cache.infra.ts`):
  - search results
  - bbox filter payloads
- Rate limiting:
  - `POST /api/buildings/filter-data` has a dedicated limiter tuned for interactive map filtering (`src/lib/server/boot/rate-limiters.boot.ts`, `filterDataRateLimiter`).
  - `POST /api/buildings/filter-matches` has its own limiter for bbox+rules interactive workloads (`src/lib/server/boot/rate-limiters.boot.ts`, `filterMatchesRateLimiter`).
- PostgreSQL single and batch filter matching use `building-filter-postgres.ts`:
  - the spatial bbox uses `ST_MakeEnvelope`, the GiST bbox check, and `ST_Intersects`;
  - complete text/existence/numeric predicates run against effective values before each request's match limit, including architectural aliases and derived levels;
  - only referenced architectural columns are selected; authenticated requests fetch the latest relevant personal edits once, sanitize their field masks, and join those overrides as a JSONB relation before filtering;
  - both added and removed personal matches are respected, without a preliminary 50,000-candidate cutoff or per-candidate overlay requests;
  - batch rule sets share a materialized spatial/effective-value projection; matching results contain identities and bbox coordinates, not full tags or geometry;
  - level filters parse tags and derive levels once per feature; evaluation barriers prevent repeated fallback calculations while preserving complete predicates before result limits;
  - below zoom `5`, marker aggregation counts every matching building in SQL and returns bounded grid cells rather than a capped building sample;
  - response limits still apply to individual buildings or cells, and `meta.truncated` remains meaningful. This does not remove the client highlight budget.
- PostGIS bbox paths use a single envelope CTE:
  - `GET /api/buildings/filter-data-bbox`
  - single and batch `POST /api/buildings/filter-matches` queries.
- Long `(a=? AND b=?) OR ...` chains replaced with `VALUES + JOIN` in PostgreSQL paths:
  - `POST /api/buildings/filter-data`
  - `getUserPersonalEditsByKeys` (`building-edits.service`)
- `/api/contours-status` fast path reads from `osm.building_contours_summary` (1 row), with aggregate fallback if summary is empty/unavailable.
- OSM sync for PostgreSQL updates `osm.building_contours_summary` in the same import transaction.
- PostgreSQL search projection is built in SQL by `search-index-postgres.service.ts`.
  - One weighted `search_tsv` stores named fields with higher relevance and effective OSM tag keys/values with lower relevance. Public local architectural overrides replace their corresponding source values; private personal drafts stay outside the shared index.
  - Transactional `building_data_changes` entries identify inserted, changed, and deleted contours and public local edits. Incremental refresh replaces only those search rows and acknowledges the exact consumed generations after successful writes.
  - After draining, an empty queue larger than 16 MiB gets a nonblocking storage-reclamation attempt. Under the search advisory lock, `ACCESS EXCLUSIVE NOWAIT` skips active writers; a fresh emptiness check precedes `TRUNCATE`. Pending changes are never truncated and the generation sequence is not reset. Writers arriving after the lock resume after the short transaction commits.
  - Save/moderation/cleanup requests enqueue background work rather than rebuilding the full index. Failed/unconsumed entries remain durable for recovery.
  - A full rebuild creates and indexes a separate table while readers keep using the published index, then swaps tables transactionally. Changes committed after the rebuild snapshot remain queued.
  - Startup checks projection version, index presence, and queued changes; a current projection consumes changes instead of rescanning all source rows.
  - SQLite retains Node-side normalization in `search-index-source.service.ts`, `building_search_source`, and `building_search_fts`.
- PostgreSQL tag-key suggestions use transactional `filter_tag_key_counts` maintained by statement-level transition-table triggers. New keys and removal of the final occurrence update `filter_tag_keys_cache` without transferring all contours to Node after every sync. Routine maintenance reads the compact dictionary; `FILTER_TAG_KEYS_REBUILD_FULL=true` explicitly repairs counts and cache with a source scan under a write-blocking source-table lock.

## DB and indexes

- Search and bbox rely on existing indexes and RTree, initialized in:
  - `src/lib/server/infra/db-bootstrap.infra.ts`
- Search query path already uses FTS and ordered ranking in:
  - `src/lib/server/services/search.service.ts`
- PostgreSQL migration `003_contours_summary.sql`:
  - adds `osm.building_contours_summary` and initial backfill;
  - drops redundant `local.idx_architectural_info_osm` (duplicated by `UNIQUE (osm_type, osm_id)`);
  - keeps spatial GIST index unchanged (`idx_building_contours_geom_gist`).

## Remaining heavy query

- Full aggregate fallback in `/api/contours-status` (`COUNT(*)`, `MAX(updated_at)`) is available for safety.
- For very complex `contains` filters in huge bboxes, planner/index selectivity can dominate p95 and should be monitored with `EXPLAIN ANALYZE`.
- Batch materialization and complete low-zoom counts must inspect all relevant matches. Compare result completeness as well as latency with older candidate-capped queries; a faster incomplete count is not an equivalent workload.
- Full search publication temporarily requires both old and new tables/indexes. Incremental maintenance reduces repeated rebuild work but does not eliminate this peak space requirement.
