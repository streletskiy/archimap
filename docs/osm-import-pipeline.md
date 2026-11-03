# OSM Import Pipeline

This document describes the managed end-to-end region sync pipeline implemented by [`scripts/sync-osm-region.ts`](../scripts/sync-osm-region.ts) and helper modules under [`scripts/region-sync/`](../scripts/region-sync/).

It is the source of truth for the current managed architecture:

- PostgreSQL + PostGIS only for managed region sync.
- Curated extract metadata from repository-local manifest/catalog data.
- Aria2-backed upstream PBF download from stored URLs, with console progress mirrored into the sync status state.
- `osm2pgsql` flex import into PostgreSQL staging.
- Controlled merge/apply of changed objects into canonical tables.
- Durable changed-object search maintenance and exact filter-tag key counts.
- Reuse of validated unchanged PMTiles archives; `planetiler` as the only build engine when rebuilding is required.

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

`--pmtiles-only` explicitly rebuilds a region archive from already imported PostgreSQL rows and skips download/import/apply. It uses the same publication validation and locking as a normal sync.

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

The Docker deployment provides `aria2c` in the application image and runs `osm2pgsql` and Java/Planetiler in separate service containers. Native executables are also supported. Managed downloads expect `aria2c` and only use streamed fetch if `REGION_SYNC_ALLOW_FETCH_FALLBACK=true` is set intentionally.

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
   - the downloader uses `aria2c`, streams progress updates into the run stage state, and fails fast if `aria2c` is unavailable unless `REGION_SYNC_ALLOW_FETCH_FALLBACK=true` is set intentionally
   - this is the full selected regional extract; changed-object detection happens after import and does not replace the download with OSM replication diffs
7. [`scripts/region-sync/osm2pgsql-import.ts`](../scripts/region-sync/osm2pgsql-import.ts) creates a per-run PostgreSQL staging schema and runs `osm2pgsql` flex with [`scripts/region-sync/osm2pgsql-flex.lua`](../scripts/region-sync/osm2pgsql-flex.lua).
8. The flex config keeps only building geometry relevant to ArchiMap:
   - `building`
   - `building:part`
   - ways and multipolygon relations
   - all tags of each retained building object, including unknown/custom keys
   - after successful extraction, the source PBF is removed early; source fingerprint metadata remains available
9. [`scripts/region-sync/import-applier.ts`](../scripts/region-sync/import-applier.ts) merges the staging rows into canonical tables inside one transaction:
   - rejects an empty import before changing memberships
   - compares staged tags, geometry and bounds with canonical rows and creates a temporary changed-ID set
   - upserts only inserted/changed `osm.building_contours` rows and inserts only missing `data_region_memberships`
   - removes memberships that disappeared from the import for the target region
   - deletes true orphans only for ids that actually became deletion candidates during this run
   - skips stale membership/orphan cleanup on the first sync for a region that has no prior memberships yet
   - builds a key index on the named stage table and applies rows in OSM key order so the large contour upsert stays as cache-friendly as possible
   - PostgreSQL triggers enqueue changed/deleted IDs with generation numbers, update filter-tag key counts and invalidate affected region tile revisions in the same transaction
   - an import with no canonical changes leaves the contour summary timestamp unchanged
10. The overlap-safety model is preserved through `data_region_memberships`, so overlapping regions do not delete each other's objects. After the apply transaction commits, the staging schema is dropped before tile work starts.
11. [`scripts/region-sync/tile-state.ts`](../scripts/region-sync/tile-state.ts) checks the region's persisted rendering revision, publication revision, export-code/configuration signature and archive size/modification time. A matching nonempty archive is reused without export or build. Metadata-only changes can still update search/filter data while retaining the same map archive.
12. When rebuilding is necessary, the sync exports the region's active canonical rows into NDJSON. It materializes `building:part` rows into an indexed temporary PostgreSQL table, then streams separate base and remainder passes. Synthetic `building_remainder` features remain derived output, and Node never buffers the full region.
13. [`scripts/region-sync/pmtiles-builder.ts`](../scripts/region-sync/pmtiles-builder.ts) runs `planetiler` to build `<workspace>/region.pmtiles`. The exported GeoJSON preserves stable `osm_key` identity and includes only the ID/render/filter attributes needed by the map.
14. `tile-state.ts` publishes into `data/regions/buildings-region-<slug>.pmtiles`. A short row lock validates the captured rendering revision before swapping the file and recording publication metadata. A per-region session advisory lock remains held through commit and backup cleanup, including when separate CLI rebuilds overlap.
15. Runtime follow-ups consume the durable search change queue. Initial projection upgrades or explicit full rebuilds use a shadow search table with atomic publication; ordinary refreshes update changed IDs. Filter-tag keys are maintained transactionally from counts instead of rescanning every contour. The managed runtime coalesces follow-ups until its sync queue drains; standalone sync requests incremental search maintenance directly.
16. Runtime clients receive region PMTiles metadata through `/app-config.js` and fetch byte ranges via `/api/data/regions/:regionId/pmtiles`.

## Runtime stages

Managed sync emits these high-level stages:

- `download`: `aria2`-backed PBF download from curated upstream URL with live progress
- `extract`: `osm2pgsql` flex import into PostgreSQL staging
- `apply`: controlled merge/apply into canonical tables
- `export`: export region members from PostgreSQL for PMTiles input
- `build`: `planetiler` PMTiles build
- `publish`: protected PMTiles swap/publish
- `followup`: search/filter maintenance

Validated archive reuse omits `export` and `build` and reports reuse during `publish`.

## Component responsibilities

### `scripts/sync-osm-region.ts`

- Thin orchestrator for managed region sync.
- Parses CLI args, creates runtime options/workspace, and runs either:
  - full import path
  - `--pmtiles-only` rebuild path

### `scripts/region-sync/extract-download.ts`

- Resolves the curated manifest entry.
- Downloads the upstream PBF from `downloadUrl` using `aria2c`, with progress logged to the console and emitted into sync stage state.
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
- Builds the temporary changed-ID set and applies transactional contour/membership merge logic.
- Preserves overlap safety and orphan cleanup semantics.
- Reports inserted/changed/deleted counts without sending large ID arrays through process output.

### `scripts/region-sync/tile-state.ts`

- Validates archive reuse against durable region revisions, export code/configuration and file metadata.
- Rejects publication if rendering data changed during export/build.
- Serializes publication and backup cleanup across processes, with file rollback on database failure before commit.

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
- `building_data_changes` (pending object IDs and generations)
- `data_region_tile_state` (rendering/publication state per region)
- `filter_tag_key_counts` and `filter_tag_keys_cache`
- `data/regions/buildings-region-<slug>.pmtiles`

The PBF and staging schema are released at successful extraction/apply boundaries. The final workspace cleanup remains a fallback if early release fails. Source snapshot rows record fingerprints and history; their local source paths do not imply that PBF files are retained.

Repository-managed catalog artifacts:

- `frontend/static/admin-regions.geojson`
- `src/lib/server/data/region-catalog.json`

## Safety and failure handling

- Syncs are serialized through one in-process queue.
- Duplicate `queued`/`running` runs for the same region are deduplicated.
- A `0`-feature import is treated as failure.
- PMTiles publication is protected by revision checks, per-region locks and backup/rollback behavior. Expensive export/build work does not hold publication locks.
- A failure after database apply but before archive publication leaves the region dirty. A later import with no additional data changes still rebuilds its archive.
- Missing/replaced archives and changed export signatures force rebuilding. New installations/upgrades without publication state also build once before reuse is possible.
- Geometry, building-kind, height/floor inputs and membership changes invalidate affected regions. Shared building-part changes invalidate every member region, covering parent remainder geometry as well.
- Rollback restores the previous archive before releasing the publication locks. If commit outcome is unknown, the archive is left in place; persisted revision/file metadata determines whether it can be reused. An interrupted file swap can recover its `.bak` on the next publication attempt.
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
