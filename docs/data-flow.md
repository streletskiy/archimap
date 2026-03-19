# Data Flow

Detailed managed OSM import reference: [OSM Import Pipeline](osm-import-pipeline.md)

## Configuration flow

1. Master admin manages OSM data regions in `Admin -> Data`.
2. Region configs are stored in DB tables for:
   - region settings/status
   - sync run history
   - feature-to-region membership
3. Region source selection is DB-only; env no longer configures extract queries or a single legacy PMTiles file.

## Managed sync pipeline

1. Scheduler recalculates `nextSyncAt` per enabled region.
2. Each region can have its own schedule, but execution always goes through one in-process queue.
   - Queue requests are deduplicated per region (`queued`/`running`) to prevent duplicate run rows from concurrent startup/scheduler/manual triggers.
3. Queue launches [`scripts/sync-osm-region.js`](../scripts/sync-osm-region.js) for a concrete `regionId`.
4. The sync script acts as an orchestrator and delegates the real stages to `scripts/region-sync/**`:
   - `python-extractor.js`: Python detection/dependency checks + `sync-osm-buildings.py` invocation
   - `db-ingester.js`: facade for region loading/export and DB import publishing
   - `region-db.js`: region config loading + current-members export, including direct GeoJSON feature streaming for `--pmtiles-only`
   - `import-applier.js`: transactional DB apply + protected PMTiles swap
   - `pmtiles-builder.js`: `tippecanoe` wrapper plus NDJSON -> GeoJSON conversion when the importer does not already emit a dedicated build stream
5. The region sync script runs the full OSM import pipeline described in [OSM Import Pipeline](osm-import-pipeline.md):
   - extract resolution through `quackosm`
   - provider-specific transformation/export through `duckdb` (`WKB` + GeoJSON feature NDJSON + summary metadata in one pass for PostgreSQL DB import/PMTiles, `GeoJSON` for SQLite and PMTiles build)
   - transactional import into `osm.building_contours` and `data_region_memberships`
   - region-specific PMTiles build and protected swap
6. The result is:
   - a refreshed union dataset in the runtime DB
   - a refreshed PMTiles archive for the target region
   - updated region sync metadata and bounds for runtime clients
7. For managed in-app syncs, the runtime then runs post-sync maintenance through `ServerRuntime` boot modules:
   - `search-index.boot.js` rebuilds the search read-model (`building_search_source` in PostgreSQL, `building_search_source` + `building_search_fts` in SQLite)
   - `filter-tag-keys.boot.js` resets and schedules `filter_tag_keys_cache` refresh

## Safety invariants

- No parallel sync jobs.
- No duplicate active runs per region: enqueue checks return the existing `queued`/`running` run instead of creating a new one.
- Neighboring or overlapping extract bounds are allowed; shared OSM objects stay safe because membership is tracked per region and cleanup deletes only true orphans.
- If a region import produces `0` features, the sync fails and the previous successful PMTiles file is kept.
- If PMTiles build/swap fails, the previous successful PMTiles file is restored and region data cleanup is not silently committed.
- Interrupted `queued/running` runs are recovered on restart as failed/abandoned and `nextSyncAt` is recalculated.

## Runtime request flow

1. UI requests `/app-config.js`.
2. Runtime config includes:
   - `buildingRegionsPmtiles[]` with `id`, `bounds`, `url`, `sourceLayer`, zoom range, and last successful sync timestamp
3. Main map activates only region PMTiles whose bounds intersect the current viewport.
4. Admin/account maps can bind to all available region PMTiles at once.
5. `/api/data/regions/:regionId/pmtiles` serves region PMTiles with HTTP Range support.

## Search/filter/building APIs

- Existing building/search/filter APIs continue to read the union dataset from `osm.building_contours`.
- Search source rows are normalized in Node.js from raw `tags_json` plus `local.architectural_info` via `src/lib/server/services/search-index-source.service.js`, shared by incremental updates and full rebuild worker.
- This keeps `/api/building/*`, `/api/building-info/*`, `/api/search-buildings`, and filter endpoints backward-compatible in single-region and multi-region setups.

## Operational notes

- Region PMTiles are named by region slug on disk; runtime/API addressing still uses numeric `regionId`, and legacy id-based filenames are accepted as a fallback during migration.
- `server.js` is only a thin entrypoint; runtime orchestration is built by `ServerRuntime` and split across `src/lib/server/boot/server-runtime.boot.js` plus `server-runtime.{config,middleware,routes}.js`.
- Search index rebuild still runs after successful syncs so search/filter APIs stay aligned with the union dataset.
- Bounds-driven PMTiles activation is a v1 tradeoff: source activation is rectangle-based, not polygon-precise by extract shape.
