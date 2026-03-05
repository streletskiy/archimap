# API

## Runtime routing

- Public HTTP runtime is `server.sveltekit.js`.
- API/system endpoints are dispatched directly to the internal app runtime in `server.js` for:
  - `/api/**`
  - `/healthz`, `/readyz`, `/metrics`
  - `/app-config.js`, `/favicon.ico`, `/.well-known/appspecific/com.chrome.devtools.json`, `/ui/**`

System notes:

- `GET /metrics` returns Prometheus-style text payload when `METRICS_ENABLED=true`.
- `GET /metrics` returns `404` when metrics are disabled.

## Core endpoints

- `GET /api/version`
  - Returns build/runtime version payload.
  - Cache: `Cache-Control: no-store`.
- `GET /api/search-buildings?q=...&limit=...&cursor=...&lon=...&lat=...`
  - Returns paginated building search results.
  - Cache: `Cache-Control: public, max-age=15`, `ETag`.
- `GET /api/filter-tag-keys`
  - Returns cached list of OSM tag keys plus `warmingUp`.
  - Cache: `Cache-Control: public, max-age=300`, `ETag`.
- `POST /api/buildings/filter-data`
  - Body: `{ keys: ["way/123", "relation/456", ...] }`.
  - Returns merged filter payload for explicit building keys.
- `GET /api/buildings/filter-data-bbox?minLon=&minLat=&maxLon=&maxLat=&limit=`
  - Returns tag/info set for current bbox.
  - Cache: `Cache-Control: public, max-age=10`, `ETag`.
- `POST /api/buildings/filter-matches`
  - Body: `{ bbox: { west, south, east, north }, zoom|zoomBucket, rules[], rulesHash?, maxResults? }`.
  - Returns `{ matchedKeys[], matchedFeatureIds[], meta: { rulesHash, bboxHash, truncated, elapsedMs, cacheHit } }`.
  - Cache: short-lived in-memory server cache (`rulesHash+bboxHash+zoomBucket`), per-request `meta.cacheHit`.
- `GET /api/building/:osmType/:osmId`
  - Returns GeoJSON feature.
  - Cache: `Cache-Control: public, max-age=30`, `ETag`.
- `GET /api/building-info/:osmType/:osmId`
  - Returns merged info + moderation state.
  - Cache: `Cache-Control: private, no-cache`, `ETag`, `Last-Modified` (if known).
- `GET /api/buildings.pmtiles`
  - PMTiles binary stream.
  - Supports `Range`, `If-None-Match`, `If-Modified-Since`.
  - Returns `206` for valid byte ranges and `416` for invalid ranges.
- `GET /api/contours-status`
  - Total contours + last update timestamp.
  - Cache: `Cache-Control: public, max-age=60`, `ETag`, `Last-Modified` (if available).

## Auth/admin/account

- `GET /api/me`
- `POST /api/login`, `POST /api/logout`
- `POST /api/register/start`, `POST /api/register/confirm-code`, `POST /api/register/confirm-link`
- `POST /api/password-reset/request`, `POST /api/password-reset/confirm`
- `POST /api/account/profile`, `POST /api/account/change-password`
- `GET /api/admin/users`, `GET /api/admin/users/:email`, `GET /api/admin/users/:email/edits`
- `POST /api/admin/users/edit-permission`, `POST /api/admin/users/role`
- `GET/POST /api/admin/app-settings/general`
- `GET/POST /api/admin/app-settings/smtp`, `POST /api/admin/app-settings/smtp/test`
- `GET /api/admin/building-edits`, `GET /api/admin/building-edits/:editId`
- `POST /api/admin/building-edits/:editId/reject`, `POST /api/admin/building-edits/:editId/merge`
- `GET /api/account/edits`, `GET /api/account/edits/:editId`

## Cache semantics

- Conditional GET:
  - `If-None-Match` -> `304` when ETag matches.
  - `If-Modified-Since` -> `304` when resource not newer.
- JSON responses can be compressed:
  - `Content-Encoding: br|gzip` when `Accept-Encoding` allows and payload is large enough.

## Error model

- Validation errors: `400`.
- Unauthorized/forbidden: `401` / `403`.
- Not found: `404`.
- Rate limit: `429` + `Retry-After`.
- Internal errors: `500` with sanitized message (no stack trace leak in prod).

## CSRF scope

- `x-csrf-token` is required for session-authenticated mutating routes (`/api/logout`, `/api/account/*`, `/api/building-info`, `/api/admin/**`).
- `POST /api/login`, registration, and password-reset flows do not require CSRF.
