# Docker Build and Release

## Goals

- Reuse cached layers when only source files change.
- Keep runtime image minimal and predictable.
- Deliver updates via registry layers (`push/pull`), not tar archives.

## Dockerfile Stages

Reference: [`Dockerfile`](../../Dockerfile)

1. `tippecanoe-builder`

- Builds `tippecanoe` and `tile-join` once from pinned ref.

2. `deps`

- Installs backend production dependencies from `package-lock.json`.
- Changes only when backend dependency manifests change.

3. `frontend-deps`

- Installs frontend dependencies from `frontend/package-lock.json`.
- Isolated from backend source changes.

4. `frontend-build`

- Generates version metadata and builds frontend bundle.
- Depends on frontend sources, not on backend dependency install layer.

5. `runtime`

- Uses pinned `node:20-bookworm-slim`.
- Contains only runtime assets:
  - backend runtime code (`server.sveltekit.js`, `server.js`, `src/`, `scripts/`, `workers/`)
  - `frontend/build`
  - production `node_modules`
  - python venv with `quackosm`/`duckdb`
  - `tippecanoe` binaries

## Cache Stability Rules

- Dependency install is isolated before source code copy.
- Frontend dependency install is isolated from frontend sources.
- BuildKit cache mounts are used for:
  - npm (`/root/.npm`)
  - apt (`/var/cache/apt`, `/var/lib/apt/lists`)
  - pip (`/root/.cache/pip`)

## Build Context

`.dockerignore` excludes heavy and volatile paths:

- `.git`, `node_modules`, `frontend/node_modules`
- frontend local artifacts (`frontend/.svelte-kit`, `frontend/build`)
- local data and temporary files (`data`, `tmp`, `cache`, logs)
- test artifacts (`playwright-report`, `test-results`, `coverage`)
- local env files (`.env`, `.env.*`, except examples)

## Release Pipeline

Use release scripts:

- [`scripts/release-docker.ps1`](../../scripts/release-docker.ps1)
- [`scripts/release-docker.sh`](../../scripts/release-docker.sh)

```powershell
./scripts/release-docker.ps1 -Version 1.2.3
```

```bash
chmod +x ./scripts/release-docker.sh
./scripts/release-docker.sh --version 1.2.3
```

What it does:

- Enables BuildKit (`DOCKER_BUILDKIT=1`)
- Builds multi-arch image with `docker buildx`
- Pushes image tags to registry
- Publishes build cache (`type=registry`)

Push to another Docker account/repository:

```powershell
./scripts/release-docker.ps1 -Version 1.2.3 -Image yourname/archimap
```

```bash
./scripts/release-docker.sh --version 1.2.3 --image yourname/archimap
```

Before push, authenticate:

```bash
docker login
```

Server deploy (layer-based):

```bash
export ARCHIMAP_IMAGE=streletskiy/archimap:1.2.3
docker pull streletskiy/archimap:1.2.3
docker compose up -d
```

Docker downloads only changed layers during pull.

`docker-compose.yml` reads `ARCHIMAP_IMAGE`, so the same compose file can be used for:

- local source builds (`docker compose up --build`, default image tag `streletskiy/archimap:dev`)
- registry deploys (`ARCHIMAP_IMAGE=streletskiy/archimap:<version> docker compose up -d`)

## PostgreSQL + PostGIS (default in Compose)

`docker-compose.yml` now starts `db-postgres` by default.

```bash
docker compose up -d
```

Pending PostgreSQL migrations are applied automatically on app startup. Manual migrations/smoke remain available in the compose network for recovery or verification:

```bash
docker compose exec archimap npm run db:pg:migrate
docker compose exec archimap npm run db:pg:smoke
```

Avoid bind-mounting local `./db` into `/app/db` on deployment hosts. The runtime image already contains `db/postgres/migrations`, and masking that path can make the app start against an empty schema.

## Validate Layer Sizes

```bash
docker history streletskiy/archimap:1.2.3
```

Check that:

- dependency layer is separate and stable
- frontend build layer is separate
- runtime layers are small except unavoidable tool binaries
