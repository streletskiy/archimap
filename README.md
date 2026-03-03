# archimap

archimap is a self-hosted architecture map platform built on a Node/Express backend and a SvelteKit frontend.
It serves local PMTiles for building footprints, searchable building metadata, and moderated user edits.
The runtime is optimized for private deployments where data, auth, and tiles stay under your control.
Security defaults include strict CSP, centralized security headers, CSRF protection, and sanitized logs.
The project ships with unit/integration/e2e checks and CI-ready scripts.

## Architecture Overview
- Backend entrypoint: `server.js`
- Server modules: `src/lib/server/**`, route adapters in `src/routes/**`
- Frontend: `frontend/` (SvelteKit static build)
- Datastores: SQLite (multiple attached DB files) + optional Redis for sessions
- Tiles: `/api/buildings.pmtiles` with Range streaming

## Quick Start

### Development
1. Install dependencies:
   - `npm ci`
   - `npm --prefix frontend ci`
2. Copy env template:
   - `.env.example` -> `.env`
3. Build frontend:
   - `npm run build`
4. Start app:
   - `npm run start`

### Docker
1. `docker compose up --build`
2. Open `http://localhost:3252`

### Production
1. Set required env variables.
2. `npm run build`
3. `npm run start`
4. Verify `/readyz` and `/healthz`.

## Required Environment Variable Names
- `SESSION_SECRET`
- `APP_BASE_URL`
- `TRUST_PROXY`
- `SESSION_COOKIE_SECURE`
- `ARCHIMAP_DB_PATH`
- `OSM_DB_PATH`
- `USER_AUTH_DB_PATH`
- `LOCAL_EDITS_DB_PATH`
- `USER_EDITS_DB_PATH`
- `BUILDINGS_PMTILES_FILE`
- `BUILDINGS_PMTILES_SOURCE_LAYER`

See full reference: [`docs/dev/env.md`](docs/dev/env.md).

## NPM Scripts (short list)
- `npm run dev`
- `npm run build`
- `npm run start`
- `npm run lint`
- `npm run test`
- `npm run test:e2e`
- `npm run perf:smoke`
- `npm run analyze`
- `npm run db:seed`
- `npm run tiles:build`

## Documentation
- Architecture: [`docs/architecture.md`](docs/architecture.md)
- Data flow: [`docs/data-flow.md`](docs/data-flow.md)
- API: [`docs/api.md`](docs/api.md)
- Security: [`docs/security.md`](docs/security.md)
- Performance baseline: [`docs/performance/baseline.md`](docs/performance/baseline.md)
- Server perf: [`docs/performance/server.md`](docs/performance/server.md)
- Client perf: [`docs/performance/client.md`](docs/performance/client.md)
- PMTiles perf: [`docs/performance/pmtiles.md`](docs/performance/pmtiles.md)
- Bundle: [`docs/performance/bundle.md`](docs/performance/bundle.md)
- Profiling: [`docs/performance/profiling.md`](docs/performance/profiling.md)
- Dev setup: [`docs/dev/setup.md`](docs/dev/setup.md)
- Dev scripts: [`docs/dev/scripts.md`](docs/dev/scripts.md)
- Dev testing: [`docs/dev/testing.md`](docs/dev/testing.md)
- Dataset: [`docs/dev/dataset.md`](docs/dev/dataset.md)
- Runbook: [`docs/runbook.md`](docs/runbook.md)
- Migration history: [`docs/migration-history.md`](docs/migration-history.md)

## License
Apache-2.0. See [`LICENSE`](LICENSE).

## Project Status
Active. Stage 3 performance hardening is in place; main remaining bottleneck is large map vendor chunk and aggregate-heavy contours status query.
