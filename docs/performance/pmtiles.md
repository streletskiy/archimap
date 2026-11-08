# PMTiles Performance

## HTTP behavior

- Endpoint: `GET /api/data/regions/:regionId/pmtiles`.
- Implementation: `src/lib/server/infra/pmtiles-stream.infra.ts`.
- Uses `fs.createReadStream` with explicit byte window.
- The regional archive contains both normal buildings and features carrying `building:part`; the client splits them with the `feature_kind` property instead of fetching a second archive. If `building` is also present, the feature is treated as a normal building.
- All PMTiles export paths can also add synthetic `building_remainder` features when `building:part` geometry covers only part of the parent footprint, so 3D mode can extrude the leftover contour instead of dropping the whole base building.
- Region exports also embed derived `render_height_m` and `render_min_height_m` properties plus `render_hide_base_when_parts`, so the frontend can switch to `fill-extrusion` layers without an extra per-feature height lookup and suppress parent footprints when `building:part` geometry is available.
- Tiles include the versioned floor-filter properties `filter_schema`, `filter_levels` and `filter_levels_num`. Complete arbitrary tags remain in PostgreSQL for search/details/server filters; they are not duplicated in every map tile.
- Those 3D properties are calculated during export from contour tags, using explicit `building:height` / `height` when present and otherwise falling back to `building:levels` / `levels` for the extrusion top, plus `building:min_height` / `min_height` and `building:min_level` / `min_level` for the base offset. `render_hide_base_when_parts` is a bbox-based export hint used when `building:part` rendering is active; when parts only partially cover the parent footprint, the export path can also emit `building_remainder` geometry computed as `base - union(parts)`. The current UI enables `building:part` rendering automatically in 3D mode.

## Supported features

- `Range: bytes=start-end` -> `206 Partial Content`.
- `Accept-Ranges: bytes` always returned.
- `Content-Range` and `Content-Length` are set for partial responses.
- Invalid ranges return `416` with `Content-Range: bytes */<size>`.
- `ETag` + `Last-Modified` + conditional `304` for non-range requests.
- `Cache-Control: public, max-age=300, stale-while-revalidate=120`.

## CDN compatibility notes

- Byte-range and validators are CDN-friendly.
- Keep region URLs stable by addressing PMTiles through `regionId`; the on-disk file may use the current region slug.

## Engine and temporary storage

`scripts/region-sync/pmtiles-builder.ts` uses Planetiler for both complete builds and replacement tiles. The geometry rules, zoom range, clipping buffer, simplification and tile compression remain the same in both paths. Managed exports stream canonical PostgreSQL rows, derive `building_remainder` geometry and use an indexed temporary parts table; Node does not buffer the complete region. The managed path does not read or populate the legacy persistent `osm.region_render_features` cache.

By default, `scripts/region-sync/planetiler.ts` creates a separate `/tmp/archimap-planetiler-<uuid>` directory inside the Planetiler container. It copies the input NDJSON and schema there once, keeps feature sorting and archive output on the container's local filesystem, then copies the completed archive back to the shared workspace once. This avoids repeated random reads and writes through a host bind mount. Each build also has its own feature database, so simultaneous builds cannot overwrite a shared `data/tmp/feature.db`.

The final copy first goes into a reserved sibling file, which is flushed before replacing the requested workspace output. A failed engine run or incomplete copy preserves the previous output. Normal completion and handled failures remove only that build's generated temporary directory. A hard process/container termination can leave scratch files until they are cleaned up or the container is recreated; this scratch directory is separate from the persistent source cache and published archives.

`REGION_SYNC_PLANETILER_LOCAL_IO=false` disables local staging and uses an isolated directory beside the requested output instead. This is useful when the container's local disk lacks capacity or when comparing storage paths. Native `PLANETILER_BIN` execution uses an isolated system temporary directory by default and reads the original input directly. The switch changes storage placement, not rendering quality. See [environment settings](../dev/env.md) for container selection and path mapping.

Compose mounts the `tile-inputs` volume in the sync worker and mounts it read-only in Planetiler. The worker exports NDJSON into a private workspace on this volume and Planetiler reads the same file directly. The finished archive still enters the regional workspace on the publication filesystem before the guarded swap. Without the volume setting, the worker exports to the shared workspace and stages the input into Planetiler.

## Stable feature identity

Building MVT feature IDs are derived from `osm_id * 2 + relationBit`, where the bit is `1` for relations and `0` for ways. A derived remainder intentionally shares its parent's encoded OSM identity; `feature_kind` distinguishes their render roles. `osm_key`, `osm_type` and `osm_id` remain in feature properties, and selection/highlighting uses these properties.

Planetiler's GeoJSON reader assigns its own sequential input IDs, so using `${feature.id}` would renumber buildings when exporting only a subset. The schema derives IDs explicitly from OSM properties instead. The export signature changes with this contract: an older publication receives one complete rebuild before it can be used as the base for partial updates.

## Replacing changed tiles

PostgreSQL records old and new spatial bounds for render-affecting contour and membership changes in the same transaction as the rendering revision. A changed building part also invalidates the complete footprint of each affected parent, covering its hide flag and derived remainder. Shared contours invalidate every affected member region. Metadata-only tag changes that do not affect rendering retain the existing tile revision.

The planner converts these bounds into at most 20,000 unique tile IDs over the region's configured zoom range. It pads invalidation and input windows by 8/256 of a tile, conservatively covering Planetiler's unchanged 4/256 clipping buffer and coordinate rounding. Export selects all current features needed by those tiles, including unchanged neighbors and complete parent/part dependencies. It exports whole source geometries; it does not clip them before Planetiler's normal simplification and tile slicing.

The archive update replaces each selected tile in full. It copies untouched compressed tile payloads from the old archive, uses complete replacement tiles for changed tile IDs, and removes a selected tile when the new build emits no content for it. Extra tiles emitted while rendering the selected source window are ignored. This avoids duplicate features from merging independently rendered feature shards and handles moves and deletions as well as additions.

Missing or incompatible base archives, changed export signatures, absent/incomplete spatial history and updates exceeding the planner's bounds require a complete regional build. Spatial history holds at most 256 envelopes; the tile budget is fixed in code, not an environment setting. Invalid bounds, unsupported zoom ranges and selections reaching a world/polar edge also fall back to a full build, preserving wrapped/buffered geometry. An explicit `--pmtiles-only` rebuild uses the complete path. A partial update never treats its feature subset as a complete canonical import.

## Reusing an unchanged archive

`scripts/region-sync/tile-state.ts` can skip both export and build after a normal import. Reuse requires all of the following:

- `data_region_tile_state.data_revision` equals the recorded publication revision.
- The signature of export source files and region layer/zoom configuration matches the published signature.
- The archive exists, is nonempty and matches the recorded size and modification time.

Canonical geometry/bounds, building kind, height/floor source inputs and region memberships invalidate rendering revisions transactionally. Shared contour changes invalidate all member regions; rebuilding the affected regions also recalculates parent/part remainders. Changes to tags used only by search or server filters do not require new tile geometry, while their complete data is still updated in PostgreSQL.

An import with no changes after a failed build does not clear the dirty revision. A missing archive, stale publication, changed export code or missing initial publication state therefore rebuilds safely. `--pmtiles-only` always requests a rebuild rather than taking the reuse path.

Publication holds a region row lock only for the final revision check, file swap and state update. A session advisory lock spans that transaction and backup cleanup, preventing another publisher from replacing the shared backup after commit. A stale build cannot clear newer dirty bounds or replace an archive after its captured rendering revision has changed. Successful publication records the new revision/file metadata and clears the covered spatial invalidation state together. Failures before commit restore the prior archive while those locks remain held. Export and Planetiler execution hold neither publication lock.

Source updates have an independent cache and replication cursor: one complete regional PBF remains cached for applying future diffs. Tile optimizations neither discard canonical tags nor change upstream coverage. The browser continues to request PMTiles byte ranges from one published regional archive.

## Benchmarking

Compare complete export/build/publication time on the same frozen regional data and container limits. Report export, engine, input/output copying and archive rewriting separately; a faster engine-only measurement does not include every pipeline cost. Validate unchanged compressed tile payloads and compare decoded geometry, properties and stable IDs against a complete build after additions, moves, part edits and deletions. Keep the export streaming and bounded when testing larger regions.

On 2026-11-03 an isolated Windows/Docker stand used the Nizhny Novgorod Oblast extract with 742,579 canonical objects and 89,324 tiles at zooms 13–16. Planetiler 0.10.2 had 3 CPUs, a 2,560 MiB container limit and a 1,536 MiB Java heap. The same database snapshot and limits were used before and after the storage change.

| Operation                              |                               Before |                    Optimized |
| -------------------------------------- | -----------------------------------: | ---------------------------: |
| Complete export, build and publication |                             101.28 s |  46.49 s (final output copy) |
| Engine stage including staging/copying |                              84.13 s |  28.55 s (final output copy) |
| Update of the changed snapshot         | 40.55 s with the optimized full path | 6.28 s with the partial path |
| Export for that update                 |           742,810 features / 16.35 s |      4,340 features / 0.62 s |
| Tile stage with no subsequent changes  |                                    — |   0.31 s, no export or build |

The change fixture updated a real parent's height, moved and changed the height of a real part, deleted a standalone building, and added a footprint crossing a tile boundary. It invalidated eight tiles; all 89,316 other tiles retained their original compressed payload bytes. Every decompressed MVT byte in the partial result matched the complete build of the same changed database, including feature IDs, properties and geometry. No unreferenced payload bytes or file gaps remained after archive compaction.

The initial local-storage implementation completed full runs in 40.93–42.73 seconds. Release hardening changed output copying to retain an exclusive file descriptor through flushing; the final complete run took 46.49 seconds (17.22 seconds export, 28.55 seconds build/staging) and produced the exact same archive hash as the full changed-snapshot reference. The partial-update and no-change timings above were measured before this output-copy hardening; their archive replacement logic is unchanged.

The old and new complete builds had identical geometry, properties and feature multiplicities in every tile; only the intentional stable-ID migration differed. The full archive stayed approximately 108 MB. These are tile pipeline measurements: source download and canonical import are excluded. Benefits of partial updates depend on the affected area; larger or unsupported changes use the measured full path. Raw benchmark artifacts remain outside version control under the stand's `.benchmarks/efficiency-20261103/results/` directory.
