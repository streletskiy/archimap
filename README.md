# ArchiMap

## What It Is

ArchiMap is a self-hosted platform for an interactive architectural map.
Building data is based on OpenStreetMap and enriched in the selected runtime DB provider:
PostgreSQL + PostGIS (production default) or SQLite (dev/fallback).
The map is rendered with MapLibre and vector PMTiles.
The backend runs on Node.js + Express, and the UI is built with SvelteKit.
The project is designed for private deployments with full control over data, tiles, and sessions.
The UI is multilingual (`en` + `ru`) with runtime locale switching.

## How It Works

- Architectural data is sourced from OpenStreetMap.
- Data is imported, normalized, and stored in PostgreSQL + PostGIS or SQLite (depending on `DB_PROVIDER`).
- A PMTiles file is generated from building contours for efficient map delivery.
- The SvelteKit UI loads tiles and renders them through MapLibre.
- Users can submit building info edits.
- Administrators moderate and merge approved changes into the local layer.

References:

- https://www.openstreetmap.org/
- https://maplibre.org/
- https://github.com/protomaps/PMTiles

## Architecture (Short)

- SvelteKit (UI)
- API layer (Express)
- PostgreSQL + PostGIS / SQLite (switchable runtime)
- PMTiles
- Redis (optional, for sessions)

Details -> [docs/architecture.md](docs/architecture.md)

## Quick Start

```bash
npm ci
npm run dev
```

Production:

```bash
npm run build
npm run start
```

Docker:

```bash
docker-compose up
```

PostgreSQL + PostGIS is enabled in Docker Compose by default.
SQLite remains available for local development or explicit env override.

Run default stack:

```bash
docker compose up -d
```

Release image (multi-arch, registry push):

```powershell
./scripts/release-docker.ps1 -Version 1.2.3
```

```bash
chmod +x ./scripts/release-docker.sh
./scripts/release-docker.sh --version 1.2.3
```

Push to another Docker account:

```powershell
./scripts/release-docker.ps1 -Version 1.2.3 -Image yourname/archimap
```

```bash
./scripts/release-docker.sh --version 1.2.3 --image yourname/archimap
```

Deploy on server (layer-based):

```bash
docker pull streletskiy/archimap:1.2.3
docker compose up -d
```

Create first master admin (after start):

```bash
docker compose exec archimap npm run admin:create-master -- --email=admin@example.com --password=change-me
```

## Environment Variables

Required for production:

- `SESSION_SECRET`
- `APP_BASE_URL`
- `DB_PROVIDER`
- `DATABASE_URL` or `POSTGRES_HOST`/`POSTGRES_PORT`/`POSTGRES_DB`/`POSTGRES_USER`/`POSTGRES_PASSWORD` for `DB_PROVIDER=postgres`
- `DATABASE_PATH` / `ARCHIMAP_DB_PATH` only for `DB_PROVIDER=sqlite`
- `REDIS_URL` (recommended for production sessions)

Full list -> [docs/dev/env.md](docs/dev/env.md)

Database provider switching:

- `DB_PROVIDER=sqlite|postgres` (default: `postgres`, but `sqlite` in `NODE_ENV=development` if unset)
- `DATABASE_URL=postgresql://...` for PostgreSQL mode
- `SQLITE_URL` or existing `DATABASE_PATH` / `ARCHIMAP_DB_PATH` for SQLite mode

PostgreSQL/PostGIS migration and smoke:

```bash
npm run db:pg:migrate
npm run db:pg:smoke
```

Run by provider:

```bash
# SQLite mode
DB_PROVIDER=sqlite npm run migrate
DB_PROVIDER=sqlite npm run dev

# PostgreSQL mode
DB_PROVIDER=postgres DATABASE_URL=postgresql://archimap:archimap@127.0.0.1:5432/archimap npm run db:pg:migrate
DB_PROVIDER=postgres DATABASE_URL=postgresql://archimap:archimap@127.0.0.1:5432/archimap npm run dev
```

## Scripts

- `dev`
- `build`
- `start`
- `test`
- `lint`
- `perf:smoke`
- `analyze`
- `db:seed`
- `admin:create-master`
- `tiles:build`
- `i18n:extract`
- `i18n:validate`
- `i18n:check`
- `version:print`

## Build Version

- Runtime build version is generated from Git metadata by `scripts/generate-version.js`.
- UI build info is shown on `/info`.
- API build info is available at `/api/version` and included in `/healthz`.
- Release source of truth is Git tags in `vX.Y.Z` format.
- If `.git` is unavailable (for example source tarball builds), version falls back to `package.json` version.

## Documentation

- Docs index -> [docs/README.md](docs/README.md)
- Architecture -> [docs/architecture.md](docs/architecture.md)
- API -> [docs/api.md](docs/api.md)
- Security -> [docs/security.md](docs/security.md)
- Performance -> [docs/performance/](docs/performance/)
- Runbook -> [docs/runbook.md](docs/runbook.md)
- Release guide -> [docs/dev/release.md](docs/dev/release.md)
- Docker guide -> [docs/dev/docker.md](docs/dev/docker.md)

## Deep Links (URL state)

- Map camera: `?lat=<latitude>&lng=<longitude>&z=<zoom>`
- Open building modal: `?building=way/<osmId>` or `?building=relation/<osmId>`
- Open admin edit details: `?edit=<id>` (legacy `adminEdit=<id>` is still supported)
- Open legal docs directly:
  - `?tab=legal&doc=terms`
  - `?tab=legal&doc=privacy`

Notes:

- Camera updates use history replace (no history spam while panning/zooming).
- Legacy legal params remain compatible (`tab=user-agreement`, `tab=privacy-policy`).

## License

Apache-2.0. See `LICENSE`.
