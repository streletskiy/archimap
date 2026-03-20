# ArchiMap

## What It Is

ArchiMap is a self-hosted platform for an interactive architectural map.
Building data is based on OpenStreetMap and enriched in the selected runtime DB provider:
PostgreSQL + PostGIS (production default) or SQLite (dev/fallback).
The map is rendered with MapLibre and vector PMTiles.
The public backend runtime is SvelteKit Node (`server.sveltekit.js`).
The project is designed for private deployments with full control over data, tiles, and sessions.
The UI is multilingual (`en` + `ru`) with runtime locale switching.

## How It Works

- Architectural data is sourced from OpenStreetMap.
- Data is imported, normalized, and stored in PostgreSQL + PostGIS or SQLite (depending on `DB_PROVIDER`).
- A PMTiles file is generated from building contours and building parts for efficient map delivery, with render metadata that lets the client split normal buildings and pure `building:part` features into separate layers. If an object has both `building` and `building:part=yes`, it is treated as a normal building.
- The SvelteKit UI loads tiles and renders them through MapLibre.
- Map filter presets are loaded at runtime from backend-managed admin settings (`/api/filter-presets`) and edited in Admin -> Filters, including per-locale preset names (`nameI18n`).
- Users can submit building info edits.
- Administrators moderate and merge approved changes into the local layer.
- Master admins can publish merged local building state back to OpenStreetMap from Admin -> Send to OSM using OAuth2-protected sync settings, including multiple building groups in one OSM changeset.

References:

- https://www.openstreetmap.org/
- https://maplibre.org/
- https://github.com/protomaps/PMTiles

## Architecture (Short)

- SvelteKit UI (`Tailwind CSS v4` + `shadcn-svelte` base layer)
- API layer (`server.js` thin entrypoint + `src/lib/server/boot/server-runtime.boot.js` internal runtime dispatched by `server.sveltekit.js` for `/api` and system endpoints)
  - internal runtime is built around `ServerRuntime` + `createServerRuntime(...)`
  - runtime composition is split across `src/lib/server/boot/server-runtime.{config,middleware,routes}.js` and other `*.boot.js` modules
  - HTTP route modules live in `src/lib/server/http/**`
- PostgreSQL + PostGIS / SQLite (switchable runtime)
- PMTiles
- Redis (optional, for sessions)

Details -> [docs/architecture.md](docs/architecture.md)

## Frontend UI Conventions

- Generated `shadcn-svelte` primitives live in `frontend/src/lib/components/ui/**`.
- Product code imports shared controls from `frontend/src/lib/components/base/**`, not from `ui/**`.
- Shared visual contracts and semantic UI classes live in `frontend/src/app.css`.
- UI rules, shared patterns, and verification expectations are documented in [docs/ui-architecture.md](docs/ui-architecture.md).

## Quick Start

```bash
npm ci
npm --prefix frontend ci
cp .env.example .env
npm run dev
```

Production:

```bash
npm run build
npm run start
```

Docker:

```bash
docker compose up --build
```

PostgreSQL + PostGIS is enabled in Docker Compose by default.
SQLite remains available for local development or explicit env override.

Run default stack:

```bash
docker compose up -d
```

Pending PostgreSQL migrations are applied automatically on app startup.
Storage-compaction PostgreSQL migrations are also applied automatically on startup after image updates; the first boot can take noticeably longer and may temporarily require extra free disk space while tables are rebuilt.

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
export ARCHIMAP_IMAGE=streletskiy/archimap:1.2.3
docker pull streletskiy/archimap:1.2.3
docker compose up -d
```

Do not bind-mount local `./db` into `/app/db` on remote hosts. The image already contains the migration files, and masking that path can leave PostgreSQL running with an empty schema.

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
- `SESSION_ALLOW_MEMORY_FALLBACK=false` when Redis is required in production

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

In Docker Compose, `db:pg:migrate` is mainly a manual recovery/verification command because startup already applies pending PostgreSQL migrations.

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
- `test:e2e`
- `lint`
- `frontend:check`
- `perf:smoke`
- `analyze`
- `db:seed`
- `admin:create-master`
- `tiles:build`
- `admin:regions:pmtiles`
- `i18n:extract`
- `i18n:validate`
- `i18n:check`
- `version:print`

`npm run tiles:build -- --region-id=<id>` and direct `node scripts/sync-osm-region.js --region-id=<id>` now rebuild search and filter-tag read-models after a successful full region sync. `--pmtiles-only` still rebuilds only the archive.

## Build Version

- Runtime build version is generated from Git metadata by `scripts/generate-version.js`.
- UI build info is shown on `/info`.
- API build info is available at `/api/version` and included in `/healthz`.
- Release source of truth is Git tags in `vX.Y.Z` format.
- If `.git` is unavailable (for example source tarball builds), version falls back to `package.json` version.

## Documentation

- Docs index -> [docs/README.md](docs/README.md)
- Architecture -> [docs/architecture.md](docs/architecture.md)
- UI architecture -> [docs/ui-architecture.md](docs/ui-architecture.md)
- API -> [docs/api.md](docs/api.md)
- OSM import pipeline -> [docs/osm-import-pipeline.md](docs/osm-import-pipeline.md)
- Edits workflow -> [docs/edits-workflow.md](docs/edits-workflow.md)
- Security -> [docs/security.md](docs/security.md)
- Performance -> [docs/performance/](docs/performance/)
- Runbook -> [docs/runbook.md](docs/runbook.md)
- Release guide -> [docs/dev/release.md](docs/dev/release.md)
- Docker guide -> [docs/dev/docker.md](docs/dev/docker.md)
- OpenAPI -> [docs/openapi.yaml](docs/openapi.yaml)

## Deep Links (URL state)

- Map camera: `?lat=<latitude>&lng=<longitude>&z=<zoom>`
- Shareable filter state: `?f=<encodedFilterLayers>`
- Open building modal: `?building=way/<osmId>` or `?building=relation/<osmId>`
- Open admin edit details: `?edit=<id>` (`adminEdit=<id>` is still supported for backward compatibility)
- Open the OSM sync admin tab: `/admin/osm`
- Canonical info/legal routes:
  - `/info/about`, `/info/terms`, `/info/privacy`
  - `/app/info/about`, `/app/info/terms`, `/app/info/privacy`

Notes:

- Camera updates use history replace (no history spam while panning/zooming).
- Shareable map links can combine camera, building, and filter state in one URL, for example `?lat=55.751244&lng=37.618423&z=15.2&f=...`.
- `f` is a compact versioned payload for filter layers and should be treated as opaque; it stores layer order, mode, color, and rules.
- Legacy legal params remain compatible (`tab=user-agreement`, `tab=privacy-policy`).
- Section root routes such as `/app/info` and `/info` still honor legacy query aliases and normalize back to canonical tab state.

## License

Apache-2.0. See `LICENSE`.
