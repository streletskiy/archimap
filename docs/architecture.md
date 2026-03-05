# Architecture

## Runtime components

- `server.sveltekit.js`: main public HTTP runtime (SvelteKit Node handler + internal app dispatch for API/system paths).
- `server.js`: internal app runtime module (`prepareRuntime`, `app`, `stopRuntime`) without Express dependency.
- `frontend/` (SvelteKit adapter-node build): UI bundles/routes + server routes (`/`, `/app`, `/admin`, `/account`, `/info`, `/api/**`).
- SQLite:
  - `data/archimap.db` (main app DB)
  - `data/osm.db` (OSM contours/search source)
  - `data/local-edits.db` (accepted local edits)
  - `data/user-edits.db` (moderation queue)
  - `data/users.db` (auth/users)
- Redis (optional): session store backend.
- PMTiles: local vector tiles file served as `/api/buildings.pmtiles`.

## Execution boundaries

- Client-only code: `frontend/src/lib/**` and Svelte routes/components.
- Server-only code: `src/lib/server/**` and `src/routes/**`.
- Shared utilities: `src/lib/shared/**`.
- Client URL-state helpers (deep links): `frontend/src/lib/client/urlState.js`.

## Security and auth points

- Security headers/CSP:
  - internal app runtime: `src/lib/server/infra/security-headers.infra.js`, `src/lib/server/infra/csp.infra.js`
  - SvelteKit-rendered pages: `frontend/src/hooks.server.ts`
- Auth/session routes: `src/lib/server/auth/index.js`.
- CSRF enforcement: `src/lib/server/services/csrf.service.js`.
- Error normalization: `src/lib/server/infra/error-handling.infra.js`.

## Caching points

- HTTP cache helpers (ETag/Last-Modified/304 + JSON compression): `src/lib/server/infra/http-cache.infra.js`.
- PMTiles range/streaming + validators: `src/lib/server/infra/pmtiles-stream.infra.js`.
- In-process LRU: `src/lib/server/infra/lru-cache.infra.js` (search and bbox hot-paths).

## i18n

- Core runtime: `frontend/src/lib/i18n/index.js`.
- Locale config: `frontend/src/lib/i18n/config.js`.
- Locales: `frontend/src/lib/i18n/locales/en.json`, `frontend/src/lib/i18n/locales/ru.json`.
- Locale storage: cookie `archimap_locale`.
- Fallback policy: missing key in active locale falls back to `en`; in dev missing keys are logged.

## Map filter highlight

- Building base layers (`local-buildings-fill`, `local-buildings-line`) are always visible and are no longer filtered out by custom rules.
- Custom building filter now renders through dedicated highlight layers:
  - `buildings-filter-highlight-fill`
  - `buildings-filter-highlight-outline`
- Filtering uses a two-phase pipeline:
  - Optimistic phase: client immediately applies cached matches for current `rulesHash + bboxHash + zoomBucket`.
  - Authoritative phase: client calls `POST /api/buildings/filter-matches` with coverage-window bbox + rules and applies server result by diff.
- Active coverage-window avoids redundant viewport refetches while current viewport remains inside expanded window.
- Matched buildings are marked with `setFeatureState({ isFiltered: true })` using encoded OSM ids (`way/relation + osm_id`), and highlight layers render by `feature-state`.
- Feature-state updates are diff-based (`toEnable` / `toDisable`) via worker apply-plan and are chunked per frame for smoothness.
- Style priority is `base -> filter highlight -> selected`, so selected building style always wins over filtered highlight.
- Filter prefetch (optional) warms neighbor windows in background with strict throttling and cancellation.

## ASCII diagram

```text
Browser (SvelteKit UI)
  |  GET/POST /api/*
  v
SvelteKit Node runtime (server.sveltekit.js)
  |- Svelte pages/assets
  |- route dispatch:
      * /api/**, /healthz, /readyz, /metrics, /app-config.js, /favicon.ico, /.well-known/*, /ui/** -> internal app
      * everything else -> Svelte handler/pages
       v
    Internal app runtime (server.js)
      |- security headers + CSP + request-id + logging
      |- auth/session + CSRF
      |- route handlers (src/lib/server/http/*, auth/*)
      |- cached JSON + PMTiles streaming
  |
  +--> SQLite (main + osm + local/user edits + auth)
  +--> Redis session store (optional, prod)
  +--> workers/scripts (sync, search index rebuild, tag cache rebuild)
```
