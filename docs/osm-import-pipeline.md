# OSM Import Pipeline

This document describes the managed end-to-end region sync pipeline implemented by [`scripts/sync-osm-region.ts`](../scripts/sync-osm-region.ts) and helper modules under [`scripts/region-sync/`](../scripts/region-sync/).

It is the source of truth for the current managed architecture:

- PostgreSQL + PostGIS only for managed region sync.
- Curated extract metadata from repository-local manifest/catalog data.
- Aria2-backed upstream PBF download from stored URLs, with console progress mirrored into the sync status state.
- `osm2pgsql` flex import into PostgreSQL staging.
- Controlled merge/apply into canonical tables.
- `planetiler` as the only PMTiles build engine.

Old managed runtime dependencies such as SQLite region sync, QuackOSM, DuckDB, Python importer helpers, `osmium`, and `tippecanoe` are no longer part of this pipeline.

## Scope

The document covers managed region syncs where:

- region config is stored in `Admin -> Data`
- `sourceType=extract`
- sync is started by scheduler, queue, admin action, or CLI

Primary entrypoints:

- `npm run tiles:build -- --region-id=<id>`
- `node --import tsx scripts/sync-osm-region.ts --region-id=<id>`
- in-app scheduler/queue launching the same script per region

Maintenance-only rebuild:

- `node --import tsx scripts/sync-osm-region.ts --region-id=<id> --pmtiles-only`

`--pmtiles-only` rebuilds a region archive from already imported PostgreSQL rows and skips download/import/apply.

## Source of Truth

Managed region sync uses repository-local catalog data:

- visible admin map catalog: [`frontend/static/admin-regions.geojson`](../frontend/static/admin-regions.geojson)
- server manifest: [`src/lib/server/data/region-catalog.json`](../src/lib/server/data/region-catalog.json)
- generator: [`scripts/build-admin-regions-geojson.py`](../scripts/build-admin-regions-geojson.py)

Each manifest entry stores at least:

- `extractSource`
- `extractId`
- `downloadUrl`

For `osmfr`, entries also store upstream freshness metadata such as `stateUrl`.

The standard admin create flow is curated-only:

- the admin selects a region from the curated map/catalog
- the UI stores the curated extract identity
- the backend validates it against the local manifest
- there is no runtime extract-search/resolve step in the normal flow

## Prerequisites

- PostgreSQL + PostGIS (`DB_PROVIDER=postgres`)
- `aria2`
- `osm2pgsql`
- `planetiler`
- Java runtime for `planetiler`

The Docker runtime image contains these dependencies, including `aria2c` for managed extract downloads.

## End-to-end flow

1. Region definition lives in `data_sync_regions`.
2. Scheduler or manual trigger chooses a concrete `regionId`.
3. The in-app worker queue keeps a DB heartbeat for every owned `queued`/`running` run so restart recovery can distinguish a live sync from an abandoned one.
4. [`scripts/sync-osm-region.ts`](../scripts/sync-osm-region.ts) loads the region config and validates:
   - region exists
   - `sourceType=extract`
   - curated `extractSource` + `extractId` are present
   - `extractResolutionStatus=resolved`
   - managed sync is running with `DB_PROVIDER=postgres`
   - manual syncs, including first-time syncs, queue immediately and let the PBF download start without waiting for a freshness probe
   - scheduled/background runs may still probe upstream before queueing so they can skip a redundant rerun when the source is already up to date
5. The sync creates a temp workspace for the run.
6. [`scripts/region-sync/extract-download.ts`](../scripts/region-sync/extract-download.ts) looks up the manifest entry and downloads the PBF from its stored `downloadUrl`.
   - the downloader prefers `aria2c`, streams progress updates into the run stage state, and falls back to streamed fetch if `aria2c` is unavailable
7. [`scripts/region-sync/osm2pgsql-import.ts`](../scripts/region-sync/osm2pgsql-import.ts) creates a per-run PostgreSQL staging schema and runs `osm2pgsql` flex with [`scripts/region-sync/osm2pgsql-flex.lua`](../scripts/region-sync/osm2pgsql-flex.lua).
8. The flex config keeps only building geometry relevant to ArchiMap:
   - `building`
   - `building:part`
   - ways and multipolygon relations
   - tags needed for canonical storage and downstream render derivation
9. [`scripts/region-sync/import-applier.ts`](../scripts/region-sync/import-applier.ts) merges the staging rows into canonical tables inside one transaction:
   - upserts `osm.building_contours`
   - upserts `data_region_memberships`
   - removes memberships that disappeared from the import for the target region
   - deletes true orphans only for ids that actually became deletion candidates during this run
   - skips stale membership/orphan cleanup on the first sync for a region that has no prior memberships yet
   - builds a key index on the named stage table and applies rows in OSM key order so the large contour upsert stays as cache-friendly as possible
10. The overlap-safety model is preserved through `data_region_memberships`, so overlapping regions do not delete each other's objects.
11. The sync then exports the target region's active canonical rows from PostgreSQL into region NDJSON for PMTiles generation.
12. Derived render-only output such as synthetic `building_remainder` features stays in the export/build phase instead of being written into canonical contour tables. The current managed path materializes `building:part` rows into a temporary indexed PostgreSQL table and then streams separate base and remainder passes, so the Node process never buffers the full region in memory and PostgreSQL can use an indexed part lookup instead of a monolithic self-join.
13. [`scripts/region-sync/pmtiles-builder.ts`](../scripts/region-sync/pmtiles-builder.ts) runs `planetiler` to build `<workspace>/region.pmtiles`. The exported building GeoJSON preserves `osm_key` so runtime selection and highlight logic stay tied to stable OSM identity instead of Planetiler feature ids.
14. [`scripts/region-sync/import-applier.ts`](../scripts/region-sync/import-applier.ts) performs the protected PMTiles publish/swap into `data/regions/buildings-region-<slug>.pmtiles`.
15. On successful commit/publish, runtime follow-up jobs rebuild:

- search source/index state
- filter-tag cache state

16. Runtime clients receive region PMTiles metadata through `/app-config.js` and fetch the archive via `/api/data/regions/:regionId/pmtiles`.

## Runtime stages

Managed sync emits these high-level stages:

- `download`: `aria2`-backed PBF download from curated upstream URL with live progress
- `extract`: `osm2pgsql` flex import into PostgreSQL staging
- `apply`: controlled merge/apply into canonical tables
- `export`: export region members from PostgreSQL for PMTiles input
- `build`: `planetiler` PMTiles build
- `publish`: protected PMTiles swap/publish
- `followup`: search/filter maintenance

## Component responsibilities

### `scripts/sync-osm-region.ts`

- Thin orchestrator for managed region sync.
- Parses CLI args, creates runtime options/workspace, and runs either:
  - full import path
  - `--pmtiles-only` rebuild path

### `scripts/region-sync/extract-download.ts`

- Resolves the curated manifest entry.
- Downloads the upstream PBF from `downloadUrl` using `aria2c` when available, with progress logged to the console and emitted into sync stage state.
- Records source snapshot metadata (size, sha256, timestamps, source ids).

### `scripts/region-sync/osm2pgsql-flex.lua`

- Defines the managed import contract for `osm2pgsql`.
- Keeps only building/building-part rows needed by the canonical data path.
- Writes staging rows used later by merge/apply.

### `scripts/region-sync/osm2pgsql-import.ts`

- Creates/drops per-run PostgreSQL staging schemas.
- Runs `osm2pgsql` flex against the downloaded PBF.
- Is the only managed importer runtime path.

### `scripts/region-sync/import-applier.ts`

- Reads rows from PostgreSQL staging.
- Applies transactional contour/membership merge logic.
- Preserves overlap safety and orphan cleanup semantics.
- Publishes the generated PMTiles archive with rollback protection.

### `scripts/region-sync/region-db.ts`

- Loads region config from PostgreSQL.
- Exports active region members from canonical PostgreSQL tables with streamed GeoJSON/NDJSON output.
- Derives render-only rows such as `building_remainder` in the PostgreSQL export pipeline, using a temp parts table plus streamed base/remainder passes.
- Supports `--pmtiles-only` rebuilds without re-importing upstream data.

### `scripts/region-sync/pmtiles-builder.ts`

- Consumes exported region NDJSON.
- Keeps derived render features such as `building_remainder` in the export/build phase and avoids writing them into canonical contour tables.
- Writes `osm_key`/`osm_type` on exported building features before invoking `planetiler`, so the PMTiles contract for map selection/highlight stays stable across tile-engine changes.
- Runs `planetiler` only.

### `src/lib/server/services/data-settings/upstream.ts`

- Performs upstream freshness checks from manifest metadata.
- Uses stored upstream URLs/state endpoints from the local catalog.
- No longer depends on runtime extract resolver services.

## Data artifacts

Temporary workspace artifacts:

- downloaded `*.osm.pbf`
- per-run staging schema in PostgreSQL
- region export NDJSON for PMTiles input
- `region.pmtiles`

Persistent runtime outputs:

- `osm.building_contours`
- `data_region_memberships`
- `data_region_source_snapshots`
- `data/regions/buildings-region-<slug>.pmtiles`

Repository-managed catalog artifacts:

- `frontend/static/admin-regions.geojson`
- `src/lib/server/data/region-catalog.json`

## Safety and failure handling

- Syncs are serialized through one in-process queue.
- Duplicate `queued`/`running` runs for the same region are deduplicated.
- A `0`-feature import is treated as failure.
- PMTiles publish is protected by backup-and-rollback behavior.
- Cleanup deletes only contours that no longer have memberships in any region.
- Interrupted runs are recoverable because run history, region state, and source snapshots are stored in the DB.
- Manual cancel terminates the managed process tree and can also repair stale queued/running state when the original worker disappeared.

## Country aggregates and hidden subregions

The curated catalog preserves:

- standalone regions
- country aggregates
- hidden subregions for aggregate orchestration

Managed sync still supports:

- aggregate/subregion orchestration
- hidden subregion rows
- in-place upgrade of country-level `geofabrik` regions into aggregate/subregion topology

## Why `building_remainder` stays derived

`building_remainder` is a render concern, not canonical source data:

- canonical tables keep imported building/building-part geometry
- export/build phase derives the synthetic remainder only when needed for PMTiles/render output
- the managed runtime materializes a temporary indexed `building:part` table per region and then streams base/remainder exports separately, which keeps canonical SQL/apply simpler, avoids buffering the full region in Node, and gives PostgreSQL a cheap part lookup path instead of a giant CTE self-join
- this avoids persisting a second canonical contour class whose lifecycle would otherwise need extra merge/delete rules

Benchmark comparison should be used to judge the runtime cost of this choice; the pipeline intentionally keeps the canonical merge simpler and leaves the derived geometry in the PMTiles export path.

## Related docs

- [Data Flow](data-flow.md)
- [Architecture](architecture.md)
- [Docker](dev/docker.md)
- [Scripts](dev/scripts.md)
- [Runbook](runbook.md)
