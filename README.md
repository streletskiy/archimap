# ArchiMap

## What It Is
ArchiMap is a self-hosted platform for an interactive architectural map.
Building data is based on OpenStreetMap and enriched locally in SQLite.
The map is rendered with MapLibre and vector PMTiles.
The backend runs on Node.js + Express, and the UI is built with SvelteKit.
The project is designed for private deployments with full control over data, tiles, and sessions.

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

## Environment Variables
Required for production:
- `DATABASE_PATH` (or `ARCHIMAP_DB_PATH`)
- `REDIS_URL`
- `SESSION_SECRET`
- `BOOTSTRAP_ADMIN_ENABLED`

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
- `tiles:build`

## Documentation
- Architecture -> `docs/architecture.md`
- API -> `docs/api.md`
- Security -> `docs/security.md`
- Performance -> `docs/performance/`
- Runbook -> `docs/runbook.md`

## License
Apache-2.0. See `LICENSE`.

## Status
Stages 1-3 are complete: SvelteKit migration, security hardening, and performance/DX improvements are in place.
The repository is now in a production-ready state for open-source maintenance.
