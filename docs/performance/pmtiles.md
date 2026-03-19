# PMTiles Performance

## HTTP behavior

- Endpoint: `GET /api/data/regions/:regionId/pmtiles`.
- Implementation: `src/lib/server/infra/pmtiles-stream.infra.js`.
- Uses `fs.createReadStream` with explicit byte window.
- The regional archive contains both normal buildings and pure `building:part` features; the client splits them with the `feature_kind` property instead of fetching a second archive. If `building` is also present, the feature is treated as a normal building.

## Supported features

- `Range: bytes=start-end` -> `206 Partial Content`.
- `Accept-Ranges: bytes` always returned.
- `Content-Range` and `Content-Length` are set for partial responses.
- Invalid ranges return `416` with `Content-Range: bytes */<size>`.
- `ETag` + `Last-Modified` + conditional `304` for non-range requests.
- `Cache-Control: public, max-age=300, stale-while-revalidate=120`.

## CDN compatibility notes

- Byte-range and validators are CDN-friendly.
- Keep region URLs stable by addressing PMTiles through `regionId`; the on-disk file may still use the current region slug.
