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
3. Queue launches [`scripts/sync-osm-region.js`](../scripts/sync-osm-region.js) for a concrete `regionId`.
4. The region sync script runs the full OSM import pipeline described in [OSM Import Pipeline](osm-import-pipeline.md):
   - extract resolution through `quackosm`
   - transformation/export through `duckdb`
   - transactional import into `osm.building_contours` and `data_region_memberships`
   - region-specific PMTiles build and protected swap
5. The result is:
   - a refreshed union dataset in the runtime DB
   - a refreshed PMTiles archive for the target region
   - updated region sync metadata and bounds for runtime clients

## Safety invariants

- No parallel sync jobs.
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
- This keeps `/api/building/*`, `/api/building-info/*`, `/api/search-buildings`, and filter endpoints backward-compatible in single-region and multi-region setups.

## Operational notes

- Region PMTiles are named by region slug on disk; runtime/API addressing still uses numeric `regionId`, and legacy id-based filenames are accepted as a fallback during migration.
- Search index rebuild still runs after successful syncs so search/filter APIs stay aligned with the union dataset.
- Bounds-driven PMTiles activation is a v1 tradeoff: source activation is rectangle-based, not polygon-precise by extract shape.
