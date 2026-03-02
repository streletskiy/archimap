# SvelteKit Migration Plan (Stage 1)

## Inventory Snapshot (2026-03-02)

- SvelteKit source: `frontend/`
- Runtime integration: `Express` serves backend API and now serves SvelteKit static build from `frontend/build/`.
- Migrated routes already present in SvelteKit:
  - `/` (main map)
  - `/account`
  - `/admin`
  - `/info`
  - compatibility aliases: `/app`, `/app/account`, `/app/admin`, `/app/info`
- Backend API remains under `/api/*`.
- PMTiles endpoint remains `/api/buildings.pmtiles`.
- Legacy frontend source files in `public/*.html` are absent.
- `public/app` previously used as generated build artifact only; runtime switched to `frontend/build`.

## Checklist

- [x] Confirm current migration state and page coverage.
- [x] Choose target integration architecture (Option A, Express as main server).
- [x] Route all UI pages through SvelteKit build fallback.
- [x] Keep `/api/*` contracts unchanged.
- [x] Preserve cookies/sessions/CSRF behavior.
- [x] Keep MapLibre + PMTiles behavior in Svelte components.
- [x] Move frontend static map styles into SvelteKit static assets.
- [x] Remove runtime dependency on `public/app`.
- [x] Keep URL compatibility for `/`, `/account`, `/admin`, `/info`, `/app/*`.
- [x] Handle auth tokens in query params (`registerToken`, `resetToken` / `reset`).
- [x] Update Docker build for frontend artifact generation.
- [x] Update smoke checks for main routes + auth + admin protection.
- [x] Run full verification: `npm run lint`, `npm test`, `npm run build`, `docker-compose build`.

## Validation Commands

- `npm run frontend:build`
- `npm run build`
- `npm run lint`
- `npm test`
- `docker-compose build`
