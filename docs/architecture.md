# Architecture

## Runtime components

- `server.sveltekit.ts`: main public HTTP runtime (SvelteKit Node handler + internal app dispatch for API/system paths).
- `server.ts`: thin backend entrypoint that loads env, creates runtime, and re-exports lifecycle hooks.
- `src/lib/server/boot/server-runtime.boot.ts`: internal app runtime class/factory (`ServerRuntime`, `createServerRuntime`) used by `server.ts`.
- `src/lib/server/boot/server-runtime.config.ts`: runtime config/env/path normalization.
- `src/lib/server/boot/server-runtime.middleware.ts`: middleware/security/session wiring for the internal app.
- `src/lib/server/boot/server-runtime.routes.ts`: route registration for API/system endpoints.
- `src/lib/server/boot/*.boot.ts`: subsystem bootstrap modules for DB runtime, rate limiters, runtime settings caches, PMTiles hooks, search rebuild, and filter-tag cache rebuild.
- `frontend/` (SvelteKit adapter-node build): UI bundles/routes + server routes (`/`, `/app`, `/admin`, `/account`, `/info`, `/api/**`).
- `frontend/src/lib/components/ui/**`: generated `shadcn-svelte` primitives kept close to upstream.
- `frontend/src/lib/components/base/**`: project UI wrappers that bind generated primitives to ArchiMap tokens, shared sizing, and event contracts.
- `frontend/src/routes/admin/+page.svelte`: thin admin route container for auth guard, tab routing, and admin URL state (`tab`, `editId`).
- `frontend/src/lib/components/admin/**`: decomposed admin UI (`AdminUsersTab`, `AdminEditsTab`, `AdminSettingsTab`, `AdminDataTab`, `AdminFiltersTab`, `AdminStylesTab`, `AdminMap`) with a shared data-controller for `Data`/`Filters`, plus tab-local subcomponents for list/filter/detail panes (`EditListFilters`, `EditDetailPane`, `SyncCandidateCard`, `SyncCandidateDetailPane`, `AdminDataForm`, `AdminDataRegionList`, `AdminDataHistorySection`, `AdminFilterTagsSection`, `AdminFilterPresetsSection`, `StyleOverridesDialog`, `StyleDefaultsSection`).
- `frontend/src/lib/components/map/MapCanvas.svelte`: map render/bind layer for MapLibre.
- `frontend/src/lib/services/map/**`: extracted non-UI map logic (filter pipeline, debug hooks, math, layer/theme/search helpers).
- `scripts/region-sync/**`: modular managed region-sync pipeline (extract, DB ingest/apply, PMTiles build).
- PostgreSQL runtime storage:
  - `osm.building_contours`: PostGIS `geom` + bbox/tags metadata; GeoJSON is rendered on demand for API/PMTiles export.
  - `public.building_search_source`: searchable subset with generated `search_tsv`.
- SQLite:
  - `data/archimap.db` (main app DB)
  - `data/osm.db` (OSM contours/search source)
  - `data/local-edits.db` (accepted local edits)
  - `data/user-edits.db` (moderation queue + stored source geometry/tags snapshots for contour-less Overpass edits)
  - `data/users.db` (auth/users)
- Redis (optional): session store backend.
- PMTiles: per-region vector tile files served as `/api/data/regions/:regionId/pmtiles`.
- Browser-local map fallback cache: Overpass-loaded building tiles are stored in IndexedDB from `frontend/src/lib/services/map/overpass-buildings.ts` so uncovered viewports can be revisited without re-downloading the same area in one session. When the user saves an edit for one of those buildings, the app also persists a server-side snapshot of the source geometry/tags in `user_edits.building_user_edits`, so later account/admin views do not depend on the browser cache. The same client-side module also tracks the last sync timestamp, exposes explicit load/refresh/clear controls, and uses a small concurrent worker pool that prefers the last working public endpoint for each tile while cooling down `403/504/5xx` hosts.

## Execution boundaries

- Client-only code: `frontend/src/lib/**` and Svelte routes/components.
- Shared UI composition follows `ui/** -> base/** -> shell/routes`; product code should not consume generated primitives directly.
- Client map services: `frontend/src/lib/services/map/**`, `frontend/src/lib/services/map-runtime.ts`.
  - `frontend/src/lib/services/map/overpass-buildings.ts`: client-side Overpass fallback loader/cache with viewport tiling, browser-local persistence, explicit load/refresh/clear controls, and a small concurrent worker pool that prefers the last working public endpoint while cooling down failing hosts.
  - `frontend/src/lib/services/map/overpass-data-utils.ts`: normalization helpers for locally loaded Overpass building features and their search/filter/detail payloads, including source snapshots used when saving Overpass-backed edits.
- Server-only code: `src/lib/server/**`.
- Internal HTTP route modules: `src/lib/server/http/**`.
- Building filter backend decomposition:
  - `src/lib/server/http/buildings.route.ts`: thin HTTP wiring for building/filter endpoints
  - `src/lib/server/services/building-filters.service.ts`: filter-data/filter-matches orchestration, cache policy, request normalization
  - `src/lib/server/services/building-filter-marker-aggregation.ts`: low-zoom marker aggregation helpers and stable cell-id generation
  - `src/lib/server/services/building-filter-query.service.ts`: bbox/key query selection for SQLite RTREE/plain paths and PostGIS paths
  - `src/lib/server/utils/filter-sql-builder.ts`: isolated Postgres predicate/guard SQL builder for filter rules
- Building edit backend decomposition:
  - `src/lib/server/services/building-edits.service.ts`: service assembly entrypoint for runtime wiring
  - `src/lib/server/services/building-edits/shared.ts`: shared edit context, row mapping, reusable SQL fragments, info normalization
  - `src/lib/server/services/building-edits/history.ts`: edit list/details queries and response shaping
  - `src/lib/server/services/building-edits/moderation.ts`: reassignment/delete flows and merged-local-state safety checks
  - `src/lib/server/services/building-edits/personal-overlays.ts`: pending/rejected personal overlay lookup for feature info and filter payloads
- Building data access:
  - `src/lib/server/services/buildings.repository.ts`: SQL access for building contour lookups, region slug resolution, local architectural info attachment, and pending building-info draft persistence plus stored source snapshot lookup shared by `buildings.route.ts` and `feature-info.http.ts`
- Auth backend decomposition:
  - `src/lib/server/auth/index.ts`: auth bootstrap and route registration entrypoint
  - `src/lib/server/auth/schema.ts`: auth schema bootstrap for SQLite
  - `src/lib/server/auth/auth.route.ts`: thin HTTP wiring for auth/session/password/admin-user endpoints
  - `src/lib/server/auth/auth.service.ts`: login/session/registration/password-reset workflows and admin auth guards
  - `src/lib/server/auth/user-profile.service.ts`: current-profile updates and admin user-management queries/mutations
- Admin backend decomposition:
  - `src/lib/server/http/admin.route.ts`: thin HTTP wiring for admin/settings/moderation endpoints
  - `src/lib/server/services/admin/shared.ts`: shared admin guards, parsers, and typed error helpers
  - `src/lib/server/services/admin/admin-settings.service.ts`: email-preview, app-settings, data-settings, and region-sync orchestration
  - `src/lib/server/services/admin/admin-edits.service.ts`: admin edit moderation, merge flows, and admin user detail queries
  - `src/lib/server/services/style-region-overrides.service.ts`: public/admin style-region override rule persistence and validation
  - `src/lib/server/services/osm-sync.service.ts`: thin façade over `osm-oauth.ts`, `osm-api-client.ts`, `osm-changeset-builder.ts`, and `osm-candidate-resolver.ts` for OSM admin sync and OAuth flows
- Frontend map filter decomposition:
  - `frontend/src/lib/services/map/map-filter-pipeline.ts`: filter lifecycle orchestration entrypoint for viewport events and status transitions
  - `frontend/src/lib/services/map/filter-request-planner.ts`: rule/layer normalization, request-spec planning, and resolved highlight payload shaping
  - `frontend/src/lib/services/map/filter-match-cache-strategy.ts`: optimistic cache reuse, authoritative request caching, and prefetch coordination
  - `frontend/src/lib/services/map/filter-worker-dispatcher.ts`: lazy `MapFilterService` worker lifecycle and request dispatch
  - `frontend/src/lib/services/map/filter-diff-apply-strategy.ts`: highlight diff/apply strategy over MapLibre paint properties
- Frontend map canvas decomposition:
  - `frontend/src/lib/components/map/MapCanvas.svelte`: Svelte container for MapLibre mount/unmount, reactive store bridging, and overlay markup
  - `frontend/src/lib/components/map/map-selection-controller.ts`: map selection, selected-feature highlight, buffered hover/click hit-testing for pmtiles buildings, and search-result click routing
  - `frontend/src/lib/components/map/map-region-layers-controller.ts`: region source/layer orchestration, PMTiles coverage checks, and carto fallback visibility
- Data settings domain modules: `src/lib/server/services/data-settings/**` (`bootstrap`, `extracts`, `regions`, `sync-runs`, `presets`) composed by `data-settings.service.ts`.
- Shared search source normalization: `src/lib/server/services/search-index-source.service.ts` now covers `name`, `address`, `style`, `architect`, and `design_ref` for the building search index.
- Shared utilities: `src/lib/shared/**`, including `src/lib/shared/types/**` for cross-cutting domain contracts shared by backend and frontend (`Region`, `FilterPreset`, `BuildingEdit`, `SyncCandidate`, and related admin payloads).
- Client URL-state helpers (deep links): `frontend/src/lib/client/urlState.ts`, `frontend/src/lib/client/filterUrlState.ts`, `frontend/src/lib/client/section-routes.ts`.
- Admin UI boundaries: `frontend/src/routes/admin/+page.svelte` owns only route-level coordination; tab-specific UI/state live under `frontend/src/lib/components/admin/**`, and the `Filters` tab contains both filter-tag allowlist management and DB-backed filter-preset CRUD.

## Security and auth points

- Security headers/CSP:
  - internal app runtime: `src/lib/server/infra/security-headers.infra.ts`, `src/lib/server/infra/csp.infra.ts`
  - SvelteKit-rendered pages: `frontend/src/hooks.server.ts`
- Auth/session routes: `src/lib/server/auth/auth.route.ts` via facade `src/lib/server/auth/index.ts`.
- CSRF enforcement: `src/lib/server/services/csrf.service.ts`.
- Error normalization: `src/lib/server/infra/error-handling.infra.ts`.

## Caching points

- HTTP cache helpers (ETag/Last-Modified/304 + JSON compression): `src/lib/server/infra/http-cache.infra.ts`.
- PMTiles range/streaming + validators: `src/lib/server/infra/pmtiles-stream.infra.ts`.
- In-process LRU: `src/lib/server/infra/lru-cache.infra.ts` (search hot-paths plus building filter bbox/match caches via `building-filters.service.ts`).
- Runtime settings caches (`general`, `smtp`, `filter-tag allowlist`): `src/lib/server/boot/runtime-settings.boot.ts`.
- Design-ref suggestions cache: `src/lib/server/boot/design-ref-suggestions.boot.ts` is startup-warmed and refreshed when `design_ref`-affecting writes or import/rebuild paths need it; OSM publish itself no longer waits on a full suggestions rebuild.
- Search index maintenance: `src/lib/server/boot/search-index.boot.ts` keeps incremental building refreshes in a keyed in-process queue, coalesces repeated refreshes for the same `osm_key`, and defers queued work while a full rebuild is running. Incremental refreshes are dispatched to a dedicated worker process (`workers/refresh-search-index.worker.ts`) so request handlers do not wait on the DB update or the worker response, and call sites only enqueue refreshes for search-affecting fields (`name`, `address`, `style`, `architect`, `design_ref`); OSM publish/sync metadata updates do not enqueue search refreshes.
- Region deletes also trigger a full search rebuild through the existing worker, but the admin delete request does not wait for that rebuild to finish.

## i18n

- Core runtime: `frontend/src/lib/i18n/index.ts`.
- Locale config: `frontend/src/lib/i18n/config.ts`.
- Locales: `src/lib/shared/i18n/locales/en.json`, `src/lib/shared/i18n/locales/ru.json`.
- Frontend imports them through the `$shared/i18n/locales/*` alias, and transactional email copy is loaded from the same locale JSON files under `email.*` by `src/lib/server/email-templates/localization.ts`.
- Locale storage: cookie `archimap_locale`.
- Fallback policy: missing key in active locale falls back to `en`; in dev missing keys are logged.

## Map filter highlight

- Building base layers are region-scoped PMTiles layers (`<region>-fill`, `<region>-line`) and remain visible; custom rules do not hide or re-filter them directly.
- UI filter state is layer-based (`buildingFilterLayers[]`): each layer carries `color`, `priority`, `mode` (`and|or|layer`), and `rules[]`.
- Persisted preset state is DB-backed (`data_filter_presets`) and reuses the same layer/rule model as runtime map filters.
- Runtime preset source of truth is backend-managed storage exposed through `GET /api/filter-presets`; frontend constants no longer store preset definitions.
- Preset names support persisted localized values (`nameI18n`); map/admin UI resolves labels by active locale with `name` fallback.
- Custom building filter renders through dedicated region-scoped highlight layers:
  - `<region>-filter-highlight-fill`
  - `<region>-filter-highlight-line`
- Building hover renders through dedicated region-scoped hover layers:
  - `<region>-hover-fill`
  - `<region>-hover-line`
  - Hover hit-testing uses a small pixel buffer around the cursor so thin building contours still respond to pointer hover and click.
- Filter evaluation for architectural fields uses merged local values first and then falls back to raw OSM tags, so accepted/synced edits participate in map highlighting the same way they do in building details.
- Filtering uses a two-phase pipeline:
  - Optimistic phase: client immediately applies cached matches for current `rulesHash + bboxHash + zoomBucket`.
  - Authoritative phase: client calls `POST /api/buildings/filter-matches` with coverage-window bbox + rules and applies server result by diff.
- Zoom-aware highlight rendering switches below zoom `13` from contour highlight to clustered marker fallback:
  - the client reuses `matchedLocations[]` from `filter-matches`, or centroid coordinates from `filter-data`, to place marker points;
  - each filter color gets its own clustered marker source/layers, and unclustered points use a tiny deterministic coordinate jitter so overlapping matches do not sit exactly on top of each other;
  - below zoom `5` the backend aggregates marker-mode matches into viewport-relative cells and includes `count` on each returned point, so the client does not need the full building list for only the most zoomed-out views;
  - the marker path uses a larger low-zoom match budget and does not surface the contour-style truncation warning, because the rendered output is already an intentionally clustered approximation;
  - the centered "filter applying" overlay is suppressed on contour zooms (`z13+`) so camera moves do not keep popping a blocking loader while PMTiles building contours stay visible;
  - the marker layer stack stays above the building base layers but below search result overlays.
- Search and filter overlays are mutually exclusive on the map: the last applied mode wins, and a new search request clears active filter layers while activating the search overlay; a new filter application deactivates the map search overlay before the filter result markers are applied.
- Multi-layer execution stays client-side:
  - all `and` and `or` layers are resolved as one combined logical group;
  - each `layer` mode layer is fetched independently;
  - each request contains flat `rules[]`.
- Combined group semantics:
  - all `and` layers must pass;
  - if any `or` layers exist, at least one `or` layer must pass;
  - rules inside one layer are ANDed.
- Client filter pipeline is decomposed into dedicated modules under `frontend/src/lib/services/map/`:
  - `map-filter-pipeline.js`: top-level orchestration and runtime status
  - `filter-request-planner.js`: layer normalization, request planning, and resolved highlight payload shaping
  - `filter-match-cache-strategy.js`: authoritative request caching, optimistic reuse, and prefetch coordination
  - `filter-worker-dispatcher.js`: lazy worker lifecycle for `prepare-rules`, `build-request-plan`, and `build-resolved-payload`
  - `filter-diff-apply-strategy.js`: chunked highlight diff/apply over MapLibre paint properties
  - supporting utilities remain split into `filter-bbox.js`, `filter-cache.js`, `filter-fetcher.js`, and `filter-utils.js`
- Active coverage-window avoids redundant viewport refetches while current viewport remains inside expanded window.
- Matched buildings are marked with `setFeatureState({ isFiltered: true, filterColor: '#rrggbb' })` using encoded OSM ids (`way/relation + osm_id`), and highlight layers render by `feature-state`.
- When one building matches multiple layers, the highest-priority layer wins and provides the visible `filterColor`.
- Feature-state updates are diff-based (`toEnable` / `toDisable`) via worker apply-plan and are chunked per frame for smoothness.
- Style priority is `base -> filter highlight -> selected`, so selected building style always wins over filtered highlight.
- Filter prefetch (optional) warms neighbor windows in background with strict throttling and cancellation.

## ASCII diagram

```text
Browser (SvelteKit UI)
  |  GET/POST /api/*
  v
SvelteKit Node runtime (server.sveltekit.ts)
  |- Svelte pages/assets
  |- route dispatch:
      * /api/**, /healthz, /readyz, /metrics, /app-config.js, /favicon.ico, /.well-known/*, /ui/** -> internal app
      * everything else -> Svelte handler/pages
       v
    server.ts (thin entrypoint)
       v
    Internal app runtime boot (src/lib/server/boot/server-runtime.boot.ts)
      |- ServerRuntime + createServerRuntime(...)
      |- server-runtime.config / middleware / routes
      |- rate limiters + runtime settings caches
      |- security headers + CSP + request-id + logging
      |- auth/session + CSRF
      |- route handlers (src/lib/server/http/*, auth/*)
      |- building filter services/query/sql builder
      |- cached JSON + PMTiles streaming
      |- sync hooks + PMTiles/search/filter maintenance jobs
  |
  +--> SQLite (main + osm + local/user edits + auth)
  +--> Redis session store (optional, prod)
  +--> workers/scripts (region-sync pipeline, search index rebuild, search index refresh, tag cache rebuild)
```
