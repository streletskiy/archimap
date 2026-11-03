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

## Engine behavior for large regions

- `scripts/region-sync/pmtiles-builder.ts` uses `planetiler` only.
- When a build is required, the runtime performs one complete regional build over the GeoJSON NDJSON export. It does not incrementally patch individual PMTiles entries.
- Managed sync streams the export from PostgreSQL, first materializing `building:part` rows into a temporary indexed table and then emitting base/remainder passes separately, so Node does not need to buffer the full region in memory or force a monolithic export CTE.
- Managed PMTiles performance is therefore driven mainly by:
  - PostgreSQL export speed
  - `planetiler` throughput
  - the cost of the export pipeline that derives render-only features such as `building_remainder`
- Both full-sync builds and explicit `--pmtiles-only` rebuilds export canonical rows through the same streaming base/remainder path. The managed orchestrator does not read or populate the legacy persistent `osm.region_render_features` cache.
- The builder accepts `PLANETILER_BIN` as an override path.

## Reusing an unchanged archive

`scripts/region-sync/tile-state.ts` can skip both export and build after a normal import. Reuse requires all of the following:

- `data_region_tile_state.data_revision` equals the recorded publication revision.
- The signature of export source files and region layer/zoom configuration matches the published signature.
- The archive exists, is nonempty and matches the recorded size and modification time.

Canonical geometry/bounds, building kind, height/floor source inputs and region memberships invalidate rendering revisions transactionally. Shared contour changes invalidate all member regions; rebuilding the affected regions also recalculates parent/part remainders. Changes to tags used only by search or server filters do not require new tile geometry, while their complete data is still updated in PostgreSQL.

An import with no changes after a failed build does not clear the dirty revision. A missing archive, stale publication, changed export code or missing initial publication state therefore rebuilds safely. `--pmtiles-only` always requests a rebuild rather than taking the reuse path.

Publication holds a region row lock only for the final revision check, file swap and state update. A session advisory lock spans that transaction and backup cleanup, preventing another publisher from replacing the shared backup after commit. Failures before commit restore the prior archive while those locks remain held. Export and Planetiler execution hold neither lock.

These optimizations reduce repeated rendering work and temporary disk peaks: the source PBF is released after extraction and PostgreSQL staging after apply. They do not eliminate downloading/parsing a full regional PBF when upstream refresh is required, nor reduce the size of the final archive by dropping tags from the canonical data.

## Benchmark note

- Cold Docker benchmark on `regionId=267` (`ru-volga-federal-district-nizhny-novgorod-oblast`) showed that simplifying the managed runtime path improved `apply` and `planetiler` build time materially, while total wall clock stayed close because download time dominated that run.
- The same benchmark also showed that the export path must stay streaming and bounded; a full-buffer Node export can OOM on larger regions such as Belarus.
