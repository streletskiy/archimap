# ArchiMap

ArchiMap is a self-hosted platform for architectural mapping and building analysis. It is built for architects, urban planners, GIS teams, and other specialists who need to inspect OpenStreetMap building data, enrich it with local project context, and keep it synchronized with a shared map workflow.

## Features

- Sync OpenStreetMap building data into a local, project-owned database and tile set.
- Explore buildings visually by floors, style, materials, function, density, and surrounding context.
- When a viewport falls outside processed regions, load nearby buildings from a curated set of public Overpass endpoints directly in the browser via explicit controls, cache them locally, and let users create edits for them; on first save the app stores the source geometry/tags snapshot server-side so the same OSM id can be reopened later without relying on the browser cache.
- Configure visual filters to expose missing architectural tags, compare building attributes, and focus on gaps in the map data.
- Edit architectural tags and building metadata directly on the map with a review-and-moderation workflow.
- Bulk edit multiple selected buildings on the map with Shift+Click and apply the same non-address changes to all of them.
- Merge approved local changes and publish them back to OpenStreetMap when needed.
- Work in a multilingual UI with runtime language switching.
- Deploy privately with full control over data, tiles, and sessions.

## Stack

- Frontend and public runtime: SvelteKit
- Map rendering: MapLibre + PMTiles
- Data storage: PostgreSQL + PostGIS or SQLite
- Sessions: Redis optional
- UI layer: Tailwind CSS v4 + shadcn-svelte + Bits UI

## Quick Start

### Local development

Use Node.js 24 LTS.

```bash
npm ci
npm --prefix frontend ci --legacy-peer-deps
cp .env.example .env
npm run dev
```

The frontend workspace currently needs `--legacy-peer-deps` because npm peer checks still reject the TypeScript 6 and SvelteKit combination during install.

Optional production-like run:

```bash
npm run build
npm run start
```

### Docker

```bash
docker compose up --build
```

`docker-compose.yml` defaults to PostgreSQL + PostGIS. SQLite is still available for local development or explicit env override.

## Docs

- Full index -> [docs/README.md](docs/README.md)
- Architecture -> [docs/architecture.md](docs/architecture.md)
- UI architecture -> [docs/ui-architecture.md](docs/ui-architecture.md)
- Setup -> [docs/dev/setup.md](docs/dev/setup.md)
- Environment -> [docs/dev/env.md](docs/dev/env.md)
- Docker -> [docs/dev/docker.md](docs/dev/docker.md)
- OpenAPI contract -> [docs/openapi.yaml](docs/openapi.yaml)
- API guide -> [docs/api.md](docs/api.md)
- OSM import pipeline -> [docs/osm-import-pipeline.md](docs/osm-import-pipeline.md)
- Edits workflow -> [docs/edits-workflow.md](docs/edits-workflow.md)
- Runbook -> [docs/runbook.md](docs/runbook.md)
- Security -> [docs/security.md](docs/security.md)

## License

Apache-2.0. See [LICENSE](LICENSE).
