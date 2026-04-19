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

## Engine behavior for large regions

- `scripts/region-sync/pmtiles-builder.ts` uses `planetiler` only.
- The runtime path is a single-pass build over the region GeoJSON NDJSON export.
- Managed sync streams the export from PostgreSQL, first materializing `building:part` rows into a temporary indexed table and then emitting base/remainder passes separately, so Node does not need to buffer the full region in memory or force a monolithic export CTE.
- Managed PMTiles performance is therefore driven mainly by:
  - PostgreSQL export speed
  - `planetiler` throughput
  - the cost of the export pipeline that derives render-only features such as `building_remainder`
- The PMTiles-only rebuild path can also use the PostgreSQL-derived `osm.region_render_features` table when that cache is refreshed, which avoids recomputing render-height and remainder metadata during rebuilds.
- The builder accepts `PLANETILER_BIN` as an override path.

## Benchmark note

- Cold Docker benchmark on `regionId=267` (`ru-volga-federal-district-nizhny-novgorod-oblast`) showed that simplifying the managed runtime path improved `apply` and `planetiler` build time materially, while total wall clock stayed close because download time dominated that run.
- The same benchmark also showed that the export path must stay streaming and bounded; a full-buffer Node export can OOM on larger regions such as Belarus.
