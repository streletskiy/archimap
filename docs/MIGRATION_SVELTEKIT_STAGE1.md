# MIGRATION_SVELTEKIT_STAGE1

## Status

Date: 2026-03-02

Stage 1 migration target is implemented as a single SvelteKit frontend with Express backend API.

## 1) Inventory (actual repo state)

### Frontend location

- SvelteKit app source: `frontend/`
- Main routes: `frontend/src/routes`

### Routes already migrated to SvelteKit

- `/` (main map + building modal + search modal)
- `/account`
- `/admin`
- `/info`
- compatibility aliases:
  - `/app`
  - `/app/account`
  - `/app/admin`
  - `/app/info`

### Legacy `/public` state

- Legacy static frontend pages (`public/*.html`, old imperative UI modules) are not present.
- `public/app` existed only as generated SvelteKit artifact from previous static build output.
- Runtime no longer depends on `public/app`.
- Map style assets moved to `frontend/static/styles`.

### App startup and deployment entrypoints

- App server: `server.js`
- Root npm scripts: `package.json`
  - `dev`: frontend build + backend start
  - `build`: frontend build
  - `start`: backend start
- Docker orchestration: `docker-compose.yml`
- Container build: `Dockerfile`

## 2) Architecture decision

Chosen approach: **Option A (preferred)**, backend remains main server.

- Express remains authoritative server and listens on the public port.
- `/api/*` endpoints remain in Express without contract changes.
- SvelteKit is built (static SPA output) into `frontend/build`.
- Express serves static assets from `frontend/build` and returns `frontend/build/index.html` for app routes.
- Single domain/origin preserved, so cookies/session/CSRF continue to work unchanged.

Why this option:

- Minimal-risk change from existing architecture.
- No reverse proxy or second runtime server required.
- Preserves existing auth/session model.

## 3) Auth / CSRF / session compatibility

- Session and auth APIs unchanged (`/api/me`, `/api/login`, `/api/logout`, `/api/register/*`, `/api/password-reset/*`).
- CSRF mechanism unchanged (`x-csrf-token`, server-side `requireCsrfSession`).
- Frontend mutation requests continue to send CSRF token via shared `apiFetch`.
- Added query-token handling in UI:
  - registration confirmation link token: `registerToken`
  - password reset token: `resetToken` and legacy `reset`
- After processing, auth query tokens are removed from URL via `history.replaceState`.

## 4) MapLibre / PMTiles

- Map implementation remains in Svelte component (`MapCanvas.svelte`) with `onMount` client-only initialization.
- PMTiles source endpoint remains `/api/buildings.pmtiles`.
- Map styles are served from `/styles/*.json` via SvelteKit static assets.

## 5) Cleanup and migration outcomes

- Runtime serving moved from `public/app` to `frontend/build`.
- Removed Express runtime binding to `/public/styles`; styles now sourced from `frontend/static/styles`.
- Route compatibility preserved for `/`, `/account`, `/admin`, `/info`, `/app/*`.
- Updated Docker build to compile frontend during image build.

## 6) Verification scope

Smoke coverage includes:

1. Main pages are reachable.
2. Map-related style endpoint and search endpoint are reachable.
3. Login flow works in local smoke run (bootstrap admin + login).
4. Admin endpoint is protected for anonymous and available for admin session.

Additional checks to run before completion:

- `npm run lint`
- `npm test`
- `npm run build`
- `docker-compose build`
