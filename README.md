# ArchiMap

## What It Is

ArchiMap is a self-hosted platform for an interactive architectural map.
Building data is based on OpenStreetMap and enriched locally in SQLite.
The map is rendered with MapLibre and vector PMTiles.
The backend runs on Node.js + Express, and the UI is built with SvelteKit.
The project is designed for private deployments with full control over data, tiles, and sessions.
The UI is multilingual (`en` + `ru`) with runtime locale switching.

## How It Works

- Architectural data is sourced from OpenStreetMap.
- Data is imported, normalized, and stored in SQLite.
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
- SQLite
- PMTiles
- Redis (optional, for sessions)

Details -> `docs/architecture.md`

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

- `DATABASE_PATH` (or `ARCHIMAP_DB_PATH`)
- `REDIS_URL`
- `SESSION_SECRET`
- `APP_BASE_URL`

Full list -> `docs/dev/env.md`

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

- Architecture -> `docs/architecture.md`
- API -> `docs/api.md`
- Security -> `docs/security.md`
- Performance -> `docs/performance/`
- Runbook -> `docs/runbook.md`
- Release guide -> `docs/dev/release.md`
- Docker guide -> `docs/dev/docker.md`

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

## Status

Stages 1-3 are complete: SvelteKit migration, security hardening, and performance/DX improvements are in place.
The repository is now in a production-ready state for open-source maintenance.
