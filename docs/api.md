# API

This page is a human-readable companion to [OpenAPI](openapi.yaml). `docs/openapi.yaml` is the canonical contract for request and response shapes; keep this summary aligned with it.

## Runtime routing

- Public HTTP runtime is `server.sveltekit.ts`.
- API/system endpoints are dispatched to the internal app runtime created by `src/lib/server/boot/server-runtime.boot.ts` and exported through thin `server.ts` entrypoint for:
  - `/api/**`
  - `/healthz`, `/readyz`, `/metrics`
  - `/app-config.js`, `/favicon.ico`, `/.well-known/appspecific/com.chrome.devtools.json`, `/ui/**`

System notes:

- `GET /healthz` returns `200` when the process is alive.
- `GET /readyz` returns `200` when the runtime is ready and `503` otherwise.
- `GET /metrics` returns Prometheus-style text payload when `METRICS_ENABLED=true` and an HTTP `Authorization: Bearer <token>` header is provided. The token can be generated in the Admin Settings UI.
- `GET /metrics` returns `404` when metrics are disabled, and `401` if an invalid token is provided.

## Core endpoints

- `GET /api/version`
  - Returns build/runtime version payload.
  - Cache: `Cache-Control: no-store`.
- `GET /api/search-buildings?q=...&limit=...&cursor=...&lon=...&lat=...&west=...&south=...&east=...&north=...`
  - Returns paginated building search results.
  - Result items include `name`, `address`, `style`, `architect`, and optional `designRef` when present.
  - Cache: `Cache-Control: public, max-age=15`, `ETag`.
- `GET /api/search-buildings-map?q=...&west=...&south=...&east=...&north=...&limit=...&lon=...&lat=...`
  - Map-oriented search variant that requires a bbox.
  - Returns `items[]`, `total`, and `truncated`.
  - Cache: `Cache-Control: public, max-age=15`, `ETag`.
- `GET /api/filter-tag-keys`
  - Returns cached list of allowlisted OSM tag keys that are currently present in `osm.building_contours`.
  - The runtime reuses the persisted `filter_tag_keys_cache` after restarts and only cold-starts a rebuild when the cache is empty.
  - `warmingUp` stays true while the cache is empty or a background rebuild is running.
  - Cache: `Cache-Control: public, max-age=300`, `ETag`.
- `GET /api/filter-presets`
  - Returns runtime map filter presets from DB-backed admin settings storage.
  - Each item contains `id`, stable `key`, `name`, `nameI18n`, optional `description`, and runtime-compatible `layers[]`.
  - `layers[]` is fully compatible with `normalizeFilterLayers(...)` and map filter pipeline execution.
  - Cache: `Cache-Control: public, max-age=60`, `ETag`.
- `POST /api/buildings/filter-data`
  - Body: `{ keys: ["way/123", "relation/456", ...] }`.
  - Returns merged filter payload for explicit building keys.
- `GET /api/buildings/filter-data-bbox?minLon=&minLat=&maxLon=&maxLat=&limit=`
  - Returns tag/info set for current bbox.
  - Cache: `Cache-Control: public, max-age=10`, `ETag`.
- `POST /api/buildings/filter-matches`
  - Body: `{ bbox: { west, south, east, north }, zoom|zoomBucket, rules[], rulesHash?, maxResults? }`.
  - `rules[]` remains a flat per-request contract. Layer modes, priorities, presets, and color resolution are handled client-side by issuing one or more requests against this endpoint.
  - Supported operators: `contains`, `equals`, `not_equals`, `starts_with`, `exists`, `not_exists`, `greater_than`, `greater_or_equals`, `less_than`, `less_or_equals`.
  - Numeric operators expect a numeric `value`; `exists` / `not_exists` ignore `value`.
  - Returns `{ matchedKeys[], matchedFeatureIds[], meta: { rulesHash, bboxHash, truncated, elapsedMs, cacheHit } }`.
  - Cache: short-lived in-memory server cache (`rulesHash+bboxHash+zoomBucket`), per-request `meta.cacheHit`.
- `POST /api/buildings/filter-matches-batch`
  - Body: `{ bbox: { west, south, east, north }, zoom|zoomBucket, requests[] }`.
  - Each batch item uses the same flat `rules[]` contract as `POST /api/buildings/filter-matches`, with its own optional `id`, `rulesHash?`, and `maxResults?`.
  - Returns `items[]`, each item containing `matchedKeys`, `matchedFeatureIds`, and per-item `meta`.
  - Batch meta includes overall `elapsedMs` and `cacheHit`.
- `GET /api/building/:osmType/:osmId`
  - Returns GeoJSON feature.
  - Cache: `Cache-Control: public, max-age=30`, `ETag`.
- `GET /api/building-info/:osmType/:osmId`
  - Returns merged info + moderation state.
  - Editable merged fields include `name`, `style`, `design`, `design_ref`, `design_year`, `material`, `colour`, `levels`, `year_built`, `architect`, `address`, `archimap_description`.
  - Response also includes `design_ref_suggestions[]`, backed by a startup-warmed in-memory cache of known project numbers.
  - `material` can represent the concrete subtypes `concrete_panels`, `concrete_blocks`, and `concrete_monolith`; the runtime stores them as `material=concrete` plus `material_concrete`.
  - Includes `region_slugs[]` for the building's current region memberships.
  - Cache: `Cache-Control: private, no-cache`, `ETag`, `Last-Modified` (if known).
- `POST /api/building-info`
  - Submits or updates a user building edit.
  - Uses the same merged field vocabulary as `GET /api/building-info/:osmType/:osmId`.
  - Requires CSRF for session-authenticated writes.
- `GET /api/style-overrides`
  - Public list of active style-region override rules used by the frontend style picker.
  - Returns `{ items[] }`, where each item contains `id`, `region_pattern`, `style_key`, `is_allowed`.
  - Cache: `Cache-Control: public, max-age=60`.
- `GET /api/data/regions/:regionId/pmtiles`
  - Region-specific PMTiles binary stream.
  - Supports `Range`, `If-None-Match`, `If-Modified-Since`.
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
- `GET /api/admin/app-settings/general`
- `POST /api/admin/app-settings/general`
- `GET /api/admin/app-settings/smtp`
- `POST /api/admin/app-settings/smtp`
- `POST /api/admin/app-settings/smtp/test`
- `GET /api/admin/app-settings/data`
  - Returns DB-backed data settings summary, bootstrap state, and current regions.
  - Also returns filter-tag allowlist config plus raw available tag keys from the current DB cache for admin UI.
  - Also returns filter presets config for admin (`filterPresets.source`, `filterPresets.items[]`).
  - Region items include canonical extract metadata (`searchQuery`, `extractSource`, `extractId`, `extractLabel`, `extractResolutionStatus`, `extractResolutionError`) and storage metadata (`pmtilesBytes`, `dbBytes`, `dbBytesApproximate`).
  - `filterTags` includes `source`, `allowlist`, `defaultAllowlist`, `availableKeys`, `updatedBy`, `updatedAt`.
  - `filterPresets.items[]` includes `id`, `key`, `name`, `nameI18n`, `description`, `layers[]`, `createdAt`, `updatedAt`, `updatedBy`.
- `POST /api/admin/app-settings/data/filter-tag-allowlist`
  - Master-admin only.
  - Body: `{ allowlist: ["building", "height", ...] }`.
  - Saves the explicit allowlist used by public filter-tag suggestions and server-side filter-key validation.
- `GET /api/admin/app-settings/data/filter-presets`
  - Master-admin only.
  - Returns `{ ok, source, items[] }` where each item is a persisted filter preset.
- `POST /api/admin/app-settings/data/filter-presets`
  - Master-admin only.
  - Upserts one filter preset.
  - Body: `{ preset: { id?, key, name?, nameI18n?, description?, layers[] } }`.
  - `nameI18n` is an object like `{ en: "Building levels", ru: "Этажность" }`; at least one name value must be provided (`name` or `nameI18n.*`).
  - `layers[]` uses the same structure as map `buildingFilterLayers[]`: `id`, `color`, `priority`, `mode`, `rules[]`.
- `DELETE /api/admin/app-settings/data/filter-presets/:id`
  - Master-admin only.
  - Deletes one persisted filter preset by id.
- `GET /api/admin/app-settings/data/regions`
  - Returns region list for admin UI.
  - Region payload mirrors admin data summary items, including extract-resolution fields plus cached storage stats `pmtilesBytes`, `dbBytes`, `dbBytesApproximate`.
- `POST /api/admin/app-settings/data/regions/resolve-extract`
  - Master-admin only.
  - Body: `{ query: "Moscow", source?: "any|..." }`.
  - Returns `{ ok, query, items[] }`, where each candidate contains `extractSource`, `extractId`, `extractLabel`, and may also include `downloadUrl`, `matchKind`, `exact`.
- `POST /api/admin/app-settings/data/regions`
  - Creates or updates a region.
  - Existing region `id` stays stable; `name` and `slug` can be updated after creation.
  - Supported source type: `sourceType=extract`.
  - Request body uses canonical extract fields (`searchQuery`, `extractSource`, `extractId`, `extractLabel`).
  - On save, server re-validates the selected canonical extract via exact resolver lookup. Ambiguous or missing canonical extract selection returns `400` with a manual-resolution message; managed syncs only run for regions whose stored `extractResolutionStatus` is `resolved`.
- `DELETE /api/admin/app-settings/data/regions/:regionId`
  - Deletes a region, its PMTiles archive, region memberships, sync runs, and orphan contours no longer referenced by any region.
  - Regions in `queued` or `running` state cannot be deleted.
- `GET /api/admin/app-settings/data/regions/:regionId/runs`
  - Returns recent sync runs for the region.
  - Run items include storage metadata captured during sync (`pmtilesBytes`, `dbBytes`, `dbBytesApproximate`) plus feature counters (`importedFeatureCount`, `activeFeatureCount`, `orphanDeletedCount`).
  - `dbBytesApproximate=true` means the stored DB size is an estimate rather than an exact byte count.
- `POST /api/admin/app-settings/data/regions/:regionId/sync-now`
  - Queues region sync in the single managed queue.
- `GET /api/admin/app-settings/osm`
  - Master-admin only.
  - Returns OSM sync settings, connection state, and OAuth capability metadata for the `Admin -> Send to OSM` tab.
- `POST /api/admin/app-settings/osm`
  - Master-admin only.
  - Saves OSM OAuth2 client settings and encrypted token material.
- `POST /api/admin/app-settings/osm/oauth/start`
  - Master-admin only.
  - Starts the OAuth2 authorization-code flow and returns the provider authorize URL plus `state`.
  - Requires OSM client ID, client secret, and redirect URI to be configured.
  - Returns explicit `OSM_SYNC_*` error codes when required OAuth settings are missing.
- `GET /api/admin/app-settings/osm/oauth/callback`
  - Master-admin only.
  - OAuth callback endpoint used by OpenStreetMap to exchange `code` + `state` for access tokens.
  - On success, the route redirects back to `/admin/osm`.
- `GET /api/admin/osm-sync/candidates`
  - Returns building-level sync candidates grouped by `osm_type` + `osm_id`.
  - Includes local merge state, sync status, last sync timestamps, and current contour snapshot data.
  - Candidates with `syncStatus` set to `synced` or `cleaned` are read-only archive rows, are shown only in the collapsed archive section of the admin UI, and are excluded from bulk sync selection.
  - If a building receives a newer accepted / partially accepted edit after an earlier sync, the queue reactivates that building and shows the newest non-read-only edit state instead of keeping the old synced history in the archive.
- `GET /api/admin/osm-sync/candidates/:osmType/:osmId`
  - Returns a detailed preflight snapshot for one building, including current live OSM state, local desired state, and drift/conflict diagnostics.
  - OAuth connection metadata is not included here; use `GET /api/admin/app-settings/osm` for OSM settings and connection state.
- `POST /api/admin/osm-sync/candidates/sync`
  - Master-admin only.
  - Accepts `{ items: [{ osmType, osmId }, ...] }` and publishes the selected building groups in one OSM changeset.
  - Marks synced edit rows with a shared changeset id and per-building summary metadata.
- `POST /api/admin/osm-sync/candidates/:osmType/:osmId/sync`
  - Master-admin only.
  - Publishes the merged local building state to OSM after preflight drift checks.
  - Marks the linked accepted/partially accepted edit rows as synced and stores the returned changeset id / compact summary in edit history.
  - Returns `409 OSM_SYNC_ALREADY_PUBLISHED` for building groups that were already synchronized and are read-only.
- `GET /api/admin/building-edits`, `GET /api/admin/building-edits/:editId`
  - `GET /api/admin/building-edits` accepts `status`, `sync`, `user`, `q`, `from`, `to`, `page`, and `limit` query parameters and returns paginated raw edit rows ordered newest-first.
  - `sync=active` returns editable rows, `sync=archived` returns read-only rows with `syncStatus` of `synced` or `cleaned`.
  - The list response includes `total`, `page`, `pageSize`, `pageCount`, `items`, and `authors[]` for the user filter dropdown.
  - Edit history items include sync metadata when available: `syncStatus`, `syncAttemptedAt`, `syncSucceededAt`, `syncCleanedAt`, `syncChangesetId`, `syncSummary`, `syncError`.
- `POST /api/admin/building-edits/:editId/reject`, `POST /api/admin/building-edits/:editId/merge`
- `POST /api/admin/building-edits/bulk-merge`
  - Admin-only bulk accept for multiple pending edit rows selected in the moderation table.
  - Body: `{ editIds: [1, 2, ...], force?: boolean, comment?: string }`.
  - Each selected edit is processed independently through the same merge path as the single-edit action, so already-processed rows can fail without aborting the rest of the batch.
- `POST /api/admin/building-edits/:editId/reassign`
- `DELETE /api/admin/building-edits/:editId`
  - Master-admin only.
  - `pending`, `rejected`, `superseded`: deletes only the edit history row.
  - `accepted`, `partially_accepted`: deletes the edit row and the linked `local.architectural_info` record only when no other accepted edit points to the same building.
  - Returns `409 EDIT_DELETE_SHARED_MERGED_STATE` when merged local data is already shared with other accepted edits for the same OSM object.
  - Returns `409 EDIT_SYNC_LOCKED` for rows that are already synchronized and treated as read-only.
- `GET /api/admin/style-overrides`
  - Admin-only list of style-region override rules.
- `POST /api/admin/style-overrides`
  - Admin-only create/update for a style-region override rule.
  - Body: `{ override: { region_pattern, style_key, is_allowed } }`.
- `DELETE /api/admin/style-overrides/:id`
  - Admin-only delete for a style-region override rule.
- `GET /api/account/edits`, `GET /api/account/edits/:editId`
  - Account history uses the same sync metadata fields as admin edit details and keeps them visible after local overwrite cleanup.
  - `GET /api/account/edits` accepts `status`, `q`, `from`, `to`, `page`, and `limit` query parameters and returns paginated building groups ordered from newest to oldest.
  - The list response includes `total`, `page`, `pageSize`, `pageCount`, and `items`.
- `DELETE /api/account/edits/:editId`
  - Current-user only.
  - Withdraws one of the user's own `pending` edits before moderation and removes that history row.
  - Returns `403 EDIT_ACCESS_DENIED` when the edit belongs to another user.
  - Returns `409 EDIT_NOT_PENDING` when the edit has already been moderated or withdrawn.

## Runtime config payload

- `GET /app-config.js`
  - Returns `window.__ARCHIMAP_CONFIG`.
  - Multi-region payload adds `buildingRegionsPmtiles[]`, each item containing:
    - `id`
    - `slug`
    - `name`
    - `url`
    - `sourceLayer`
    - `bounds`
    - `pmtilesMinZoom`
    - `pmtilesMaxZoom`
    - `lastSuccessfulSyncAt`

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
- JSON error responses use the normalized shape `{ code, error }`.
- `code` is the stable integration contract for frontend i18n and client logic.
- `error` is sanitized backend text and should be treated as a fallback/debug field, not as the primary user-facing localization source.

## CSRF scope

- `x-csrf-token` is required for session-authenticated mutating routes (`/api/logout`, `/api/account/*`, `/api/building-info`, `/api/admin/**`).
- `POST /api/login`, registration, and password-reset flows do not require CSRF.
