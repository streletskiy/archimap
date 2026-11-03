# OSM Import Pipeline

This document describes the managed end-to-end region sync pipeline implemented by [`scripts/sync-osm-region.ts`](../scripts/sync-osm-region.ts) and helper modules under [`scripts/region-sync/`](../scripts/region-sync/).

It is the source of truth for the current managed architecture:

- PostgreSQL + PostGIS only for managed region sync.
- Curated extract metadata from repository-local manifest/catalog data.
- An immutable regional source cache with bounded replication updates; a complete regional PBF download initializes or repairs the cache.
- `osmium` keeps the complete source current and selects buildings with their existing source dependencies before `osm2pgsql` staging.
- Controlled merge/apply of changed objects into canonical tables.
- Durable changed-object search maintenance and exact filter-tag key counts.
- Reuse of validated unchanged PMTiles archives; `planetiler` as the only build engine when rebuilding is required.

SQLite region sync, QuackOSM, DuckDB, Python importer helpers and `tippecanoe` are not part of this pipeline.

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

`--force-import` bypasses the unchanged-building import shortcut. It still validates and updates the source cache normally; it does not force another full PBF download.

## Source of Truth

Managed region sync uses repository-local catalog data:

- visible admin map catalog: [`frontend/static/admin-regions.geojson`](../frontend/static/admin-regions.geojson)
- server manifest: [`src/lib/server/data/region-catalog.json`](../src/lib/server/data/region-catalog.json)
- generator: [`scripts/build-admin-regions-geojson.py`](../scripts/build-admin-regions-geojson.py)

Each manifest entry stores at least:

- `extractSource`
- `extractId`
- `downloadUrl`

For `osmfr`, entries also store upstream freshness metadata such as `stateUrl`. Current source updates and freshness checks derive a trusted regional replication endpoint from the curated identity and URL: OSM France regional minute feeds or Geofabrik regional update feeds. A PBF header cannot redirect replication to an arbitrary endpoint.

The standard admin create flow is curated-only:

- the admin selects a region from the curated map/catalog
- the UI stores the curated extract identity
- the backend validates it against the local manifest
- there is no runtime extract-search/resolve step in the normal flow

## Prerequisites

- PostgreSQL + PostGIS (`DB_PROVIDER=postgres`)
- `aria2`
- `osmium`
- `osm2pgsql`
- `planetiler`
- Java runtime for `planetiler`

The Docker deployment provides `aria2c` and `osmium` in the application image and runs `osm2pgsql` and Java/Planetiler in separate service containers. Native executables are also supported. Full downloads normally use `aria2c`; source preparation can fall back to streamed fetch. Optional Osmium container execution supports local development.

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
   - manual and scheduled runs queue without treating an upstream timestamp as proof that local tiles and indexes are healthy
5. The sync creates a temp workspace and acquires a per-region PostgreSQL session lock. A cancelled waiter closes its connection instead of acquiring the lock after the run has stopped.
6. [`scripts/region-sync/source-cache.ts`](../scripts/region-sync/source-cache.ts) validates the committed cache path, file size, SHA-256 and extract identity.
   - first load, a missing/corrupt cache, an excessive replication gap or periodic rebasing downloads the full selected regional PBF through [`extract-download.ts`](../scripts/region-sync/extract-download.ts)
   - ordinary updates fetch the latest regional state, the chosen target state and `N` contiguous regional diff files (`N + 2` requests), with bounded parallelism and size limits; there is no separate state request for every diff. Osmium applies the diffs in sequence to a new PBF; the old cache stays intact until database commit
   - a current replication cursor reuses the verified PBF without downloading its body; sources without supported replication metadata can use a strong ETag captured from the same GET as the cached bytes
   - incomplete changes, invalid state, mismatched headers and backward source cuts are rejected; a full-source fallback must also preserve source ordering
7. Source preparation can prove unchanged input from the verified current source or an incremental batch in which every complete decoded diff fits the bounded inspection buffer and contains only a strictly empty `osmChange` document. Native Osmium still validates and applies every diff and writes the new source cursor. Unrecognized empty syntax and any object change require the normal local import.
8. When this proof and the import contract match the active source snapshot, [`source-state.ts`](../scripts/region-sync/source-state.ts) checks membership/contour coverage and subsequent canonical changes under the shared apply lock. It can advance source metadata without staging or rewriting unchanged buildings. Otherwise [`osm2pgsql-import.ts`](../scripts/region-sync/osm2pgsql-import.ts) reads the complete local cached PBF, creates a per-run staging schema and runs [`osm2pgsql-flex.lua`](../scripts/region-sync/osm2pgsql-flex.lua), keeping:
   - `building`
   - `building:part`
   - ways and multipolygon relations
   - all tags of each retained building object, including unknown/custom keys
   - the complete source remains cached for subsequent diffs; only building rows enter the canonical database
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
   - the immutable cache pointer, source cut, validators and import contract become active in the same transaction; failure to record a managed source rolls back canonical changes
10. The overlap-safety model is preserved through `data_region_memberships`, so overlapping regions do not delete each other's objects. Source-cut checks prevent an older overlapping extract from rolling back newer shared contours. After the apply transaction commits, the staging schema is dropped before tile work starts.
11. [`scripts/region-sync/tile-state.ts`](../scripts/region-sync/tile-state.ts) checks the region's persisted rendering revision, publication revision, export-code/configuration signature and archive size/modification time. A matching nonempty archive is reused without export or build. Metadata-only changes can still update search/filter data while retaining the same map archive.
12. When rebuilding is necessary, the sync exports the region's active canonical rows into NDJSON. It materializes `building:part` rows into an indexed temporary PostgreSQL table, then streams separate base and remainder passes. Synthetic `building_remainder` features remain derived output, and Node never buffers the full region.
13. [`scripts/region-sync/pmtiles-builder.ts`](../scripts/region-sync/pmtiles-builder.ts) runs `planetiler` to build `<workspace>/region.pmtiles`. The exported GeoJSON preserves stable `osm_key` identity and includes only the ID/render/filter attributes needed by the map.
14. `tile-state.ts` publishes into `data/regions/buildings-region-<slug>.pmtiles`. A short row lock validates the captured rendering revision before swapping the file and recording publication metadata. A per-region session advisory lock remains held through commit and backup cleanup, including when separate CLI rebuilds overlap.
15. Runtime follow-ups consume the durable search change queue, including when source/import/tile work was reused. Initial projection upgrades or explicit full rebuilds use a shadow search table with atomic publication; ordinary refreshes update changed IDs. Filter-tag keys are maintained transactionally from counts instead of rescanning every contour. The managed runtime coalesces follow-ups until its sync queue drains; standalone sync requests incremental search maintenance directly. Source cache cleanup retains the database's committed active file and removes superseded cache files while the per-region lock is still held.
16. Runtime clients receive region PMTiles metadata through `/app-config.js` and fetch byte ranges via `/api/data/regions/:regionId/pmtiles`.

Deleting a region also triggers [`source-cache-lifecycle.ts`](../scripts/region-sync/source-cache-lifecycle.ts): it finds cache directories whose region rows no longer exist, including cascaded descendants, acquires their source locks and waits for canonical import transactions before removing managed PBF files. It rechecks that each region and active source pointer are absent; cleanup failures are logged and retried on later region deletions.

The importer reads the local complete PBF directly. In measurements on Nizhny Novgorod, a separate Osmium building/dependency prefilter added substantial memory use and processing time before staging. Keeping the existing import path avoids that extra pass while preserving all building tags and geometry dependencies. Changed replication batches therefore save network transfer but still scan the local source during import.

## Runtime stages

Managed sync emits these high-level stages:

- `download`: source validation, regional replication updates, cache reuse or full PBF download
- `extract`: when necessary, `osm2pgsql` staging from the complete local source
- `apply`: controlled merge/apply into canonical tables
- `export`: export region members from PostgreSQL for PMTiles input
- `build`: `planetiler` PMTiles build
- `publish`: protected PMTiles swap/publish
- `followup`: search/filter maintenance

Validated archive reuse omits `export` and `build` and reports reuse during `publish`.

Sync summaries include `sourceMode` (`full`, `incremental`, `cached`, `unchanged`), transferred source bytes/requests/diff count, retained cache bytes and `buildingImportSkipped`. Transfer counters describe attempted transfers, so a full fallback can also report diffs downloaded before the fallback.

## Component responsibilities

### `scripts/sync-osm-region.ts`

- Thin orchestrator for managed region sync.
- Parses CLI args, creates runtime options/workspace, and runs either:
  - source-update/import path, with independent source, building-import and tile reuse checks
  - `--pmtiles-only` rebuild path

### `scripts/region-sync/extract-download.ts`

- Resolves the curated manifest entry.
- Downloads the upstream PBF from `downloadUrl` using `aria2c`, with progress logged to the console and emitted into sync stage state.
- Records source snapshot metadata (size, sha256, timestamps, source ids).

### `scripts/region-sync/source-cache.ts` and `source-state.ts`

- Validate the complete cached PBF and update it from trusted, contiguous regional replication files.
- Publish source files immutably and keep the active pointer and replication cut in PostgreSQL.
- Serialize source preparation per region and canonical/source-state changes through the shared apply lock.
- Fingerprint the import contract, including building selection and Osmium commands, separately from the tile export contract.
- Skip unchanged building imports only when the committed source state and current canonical coverage agree.

### `scripts/region-sync/osmium-tool.ts`

- Preserve full source topology for replication, including node-only moves, relation membership changes and deletions.
- Apply ordered regional diffs to the complete source and verify its replication metadata.
- Run native Osmium or an explicitly configured container and forward cancellation to the actual tool process.

### `scripts/region-sync/osm2pgsql-flex.lua`

- Defines the managed import contract for `osm2pgsql`.
- Keeps only building/building-part rows needed by the canonical data path.
- Writes staging rows used later by merge/apply.

### `scripts/region-sync/osm2pgsql-import.ts`

- Creates/drops per-run PostgreSQL staging schemas.
- Runs `osm2pgsql` flex against the complete cached regional PBF.
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
- Uses trusted regional replication state derived from the local catalog, avoiding stale daily-extract timestamps for minute feeds.
- No longer depends on runtime extract resolver services.

## Data artifacts

Temporary workspace artifacts:

- downloaded/rebased PBF and bounded replication diffs
- per-run staging schema in PostgreSQL
- region export NDJSON for PMTiles input
- `region.pmtiles`

Persistent runtime outputs:

- `osm.building_contours`
- `data_region_memberships`
- `data_region_source_snapshots`
- `data/source-cache/r<regionId>/<sha256>.osm.pbf` (the committed complete regional source)
- `building_data_changes` (pending object IDs and generations)
- `data_region_tile_state` (rendering/publication state per region)
- `filter_tag_key_counts` and `filter_tag_keys_cache`
- `data/regions/buildings-region-<slug>.pmtiles`

The staging schema is released after successful apply. The final workspace cleanup remains a fallback if early release fails. Source snapshot rows record fingerprints and history; only the current managed source file is retained after cleanup. Legacy snapshot paths may no longer exist and cannot enable source reuse.

The cache exchanges disk space for smaller subsequent transfers: one complete regional PBF remains on disk. During an update, old and new complete sources and temporary tile inputs can coexist. First load and periodic/repair rebases still transfer a complete regional extract. The browser independently requests PMTiles byte ranges and does not download this PBF or the complete regional map archive.

Repository-managed catalog artifacts:

- `frontend/static/admin-regions.geojson`
- `src/lib/server/data/region-catalog.json`

## Safety and failure handling

- Syncs are serialized through one in-process queue.
- A per-region source lock also protects CLI/multiple-process updates; canonical apply and source-pointer advancement share a database lock.
- Duplicate `queued`/`running` runs for the same region are deduplicated.
- A `0`-feature import is treated as failure.
- PMTiles publication is protected by revision checks, per-region locks and backup/rollback behavior. Expensive export/build work does not hold publication locks.
- A failure after database apply but before archive publication leaves the region dirty. A later import with no additional data changes still rebuilds its archive.
- Missing/replaced archives and changed export signatures force rebuilding. New installations/upgrades without publication state also build once before reuse is possible.
- Geometry, building-kind, height/floor inputs and membership changes invalidate affected regions. Shared building-part changes invalidate every member region, covering parent remainder geometry as well.
- Rollback restores the previous archive before releasing the publication locks. If commit outcome is unknown, the archive is left in place; persisted revision/file metadata determines whether it can be reused. An interrupted file swap can recover its `.bak` on the next publication attempt.
- Cleanup deletes only contours that no longer have memberships in any region.
- Replication diffs are applied to a complete source snapshot before membership reconciliation. A changed-only file is never treated as a complete region, which would incorrectly delete unchanged buildings.
- The provider extract defines coverage. Building selection preserves its existing way/relation references and does not replace extract coverage with a viewport or strict administrative-boundary clip.
- Unsupported/unavailable replication, damaged cache files and bounded catch-up limits fall back to a complete download; a known source cut cannot silently move backwards.
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
