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
- `frontend/src/lib/components/admin/**`: decomposed admin UI (`AdminUsersTab`, `AdminEditsTab`, `AdminSettingsTab`, `AdminDataTab`, `AdminFiltersTab`, `AdminStylesTab`, `AdminMap`) with a shared data-controller for `Data`/`Filters`.
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
  - `data/user-edits.db` (moderation queue)
  - `data/users.db` (auth/users)
- Redis (optional): session store backend.
- PMTiles: per-region vector tile files served as `/api/data/regions/:regionId/pmtiles`.

## Execution boundaries

- Client-only code: `frontend/src/lib/**` and Svelte routes/components.
- Shared UI composition follows `ui/** -> base/** -> shell/routes`; product code should not consume generated primitives directly.
- Client map services: `frontend/src/lib/services/map/**`, `frontend/src/lib/services/map-runtime.ts`.
- Server-only code: `src/lib/server/**`.
- Internal HTTP route modules: `src/lib/server/http/**`.
- Building filter backend decomposition:
  - `src/lib/server/http/buildings.route.ts`: thin HTTP wiring for building/filter endpoints
  - `src/lib/server/services/building-filters.service.ts`: filter-data/filter-matches orchestration, cache policy, request normalization
  - `src/lib/server/services/building-filter-query.service.ts`: bbox/key query selection for SQLite RTREE/plain paths and PostGIS paths
  - `src/lib/server/utils/filter-sql-builder.ts`: isolated Postgres predicate/guard SQL builder for filter rules
- Building edit backend decomposition:
  - `src/lib/server/services/building-edits.service.ts`: service assembly entrypoint for runtime wiring
  - `src/lib/server/services/building-edits/shared.ts`: shared edit context, row mapping, reusable SQL fragments, info normalization
  - `src/lib/server/services/building-edits/history.ts`: edit list/details queries and response shaping
  - `src/lib/server/services/building-edits/moderation.ts`: reassignment/delete flows and merged-local-state safety checks
  - `src/lib/server/services/building-edits/personal-overlays.ts`: pending/rejected personal overlay lookup for feature info and filter payloads
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
- Frontend map filter decomposition:
  - `frontend/src/lib/services/map/map-filter-pipeline.ts`: filter lifecycle orchestration entrypoint for viewport events and status transitions
  - `frontend/src/lib/services/map/filter-request-planner.ts`: rule/layer normalization, request-spec planning, and resolved highlight payload shaping
  - `frontend/src/lib/services/map/filter-match-cache-strategy.ts`: optimistic cache reuse, authoritative request caching, and prefetch coordination
  - `frontend/src/lib/services/map/filter-worker-dispatcher.ts`: lazy `MapFilterService` worker lifecycle and request dispatch
  - `frontend/src/lib/services/map/filter-diff-apply-strategy.ts`: highlight diff/apply strategy over MapLibre paint properties
- Frontend map canvas decomposition:
  - `frontend/src/lib/components/map/MapCanvas.svelte`: Svelte container for MapLibre mount/unmount, reactive store bridging, and overlay markup
  - `frontend/src/lib/components/map/map-selection-controller.ts`: map selection, selected-feature highlight, and search-result click routing
  - `frontend/src/lib/components/map/map-region-layers-controller.ts`: region source/layer orchestration, PMTiles coverage checks, and carto fallback visibility
- Data settings domain modules: `src/lib/server/services/data-settings/**` (`bootstrap`, `extracts`, `regions`, `sync-runs`, `presets`) composed by `data-settings.service.ts`.
- Shared search source normalization: `src/lib/server/services/search-index-source.service.ts`.
- Shared utilities: `src/lib/shared/**`.
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

## i18n

- Core runtime: `frontend/src/lib/i18n/index.ts`.
- Locale config: `frontend/src/lib/i18n/config.ts`.
- Locales: `frontend/src/lib/i18n/locales/en.tson`, `frontend/src/lib/i18n/locales/ru.tson`.
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
- Filter evaluation for architectural fields uses merged local values first and then falls back to raw OSM tags, so accepted/synced edits participate in map highlighting the same way they do in building details.
- Filtering uses a two-phase pipeline:
  - Optimistic phase: client immediately applies cached matches for current `rulesHash + bboxHash + zoomBucket`.
  - Authoritative phase: client calls `POST /api/buildings/filter-matches` with coverage-window bbox + rules and applies server result by diff.
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
  - `filter-worker-dispatcher.js`: lazy worker lifecycle for `prepare-rules` and `build-apply-plan`
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
  +--> workers/scripts (region-sync pipeline, search index rebuild, tag cache rebuild)
```
