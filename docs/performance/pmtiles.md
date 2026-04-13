# PMTiles Performance

## HTTP behavior

- Endpoint: `GET /api/data/regions/:regionId/pmtiles`.
- Implementation: `src/lib/server/infra/pmtiles-stream.infra.ts`.
- Uses `fs.createReadStream` with explicit byte window.
- The regional archive contains both normal buildings and features carrying `building:part`; the client splits them with the `feature_kind` property instead of fetching a second archive. If `building` is also present, the feature is treated as a normal building.
- All PMTiles export paths can also add synthetic `building_remainder` features when `building:part` geometry covers only part of the parent footprint, so 3D mode can extrude the leftover contour instead of dropping the whole base building.
- Region exports also embed derived `render_height_m` and `render_min_height_m` properties plus `render_hide_base_when_parts`, so the frontend can switch to `fill-extrusion` layers without an extra per-feature height lookup and suppress parent footprints when `building:part` geometry is available.
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

## Sharded builds for large regions

- `scripts/region-sync/pmtiles-builder.ts` splits every multi-cell region into a square km-grid before running `tippecanoe`, then merges the per-cell archives with `tile-join`. Each tippecanoe invocation processes only one cell, so peak RSS scales with the *densest* cell instead of the whole region.
- Cell size is controlled by `REGION_SYNC_SHARD_KM` (default `60`). The grid is planned from the region bbox using a cosine-adjusted longitude step so cells stay roughly square on the ground at the region's latitude. Set `REGION_SYNC_SHARD_KM=0` to force the legacy single-pass path for the whole deployment.
- Single-cell regions (bbox smaller than one shard cell) automatically collapse to a direct tippecanoe call, so small cities still take the fast path. `REGION_SYNC_SHARD_MIN_FEATURES` now defaults to an adaptive floor when unset, which keeps small and medium regions on the single-pass path without hard-coding one universal threshold. Set it explicitly if you need reproducible benchmarking behavior.
- Each feature is assigned to a cell by the bbox center of its geometry, so building footprints and `building:part` geometry never straddle two shards. Invalid or geometry-less lines are counted as `skippedFeatureCount` and reported at the start of the sharded build.
- The builder keeps a persistent shard cache under `data/regions/.pmtiles-cache/`: it hashes each shard input, reuses matching shard archives on repeat runs, and only rebuilds dirty shards before `tile-join` merges cached and rebuilt inputs. This is the main reason repeat PMTiles rebuilds can be much cheaper than the first run.
- `tile-join` is invoked with `--no-tile-size-limit` and the region source layer name so the merged archive keeps the same `buildings` layer the runtime expects. Intermediate per-shard NDJSON and temporary PMTiles files are removed after the merge, while the on-disk cache remains available for later runs.
- `REGION_SYNC_WORKDIR_CLEANUP=warm` keeps reusable download/materialization artifacts between retries by default. Use `aggressive` or `off` only when you explicitly want the old cleanup behavior or need to reclaim disk space quickly.
- The PMTiles-only rebuild path can also use the PostgreSQL-derived `osm.region_render_features` table when that cache is refreshed, which avoids recomputing render-height and remainder metadata during rebuilds.
- The builder also accepts `TILE_JOIN_BIN` as an override path for the `tile-join` binary (default: auto-discovered from `PATH`).
