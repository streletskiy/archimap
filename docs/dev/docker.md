# Docker Build and Release

## Goals

- Reuse cached layers when only source files change.
- Keep runtime image minimal and predictable.
- Deliver updates via registry layers (`push/pull`), not tar archives.

## Dockerfile Stages

Reference: [`Dockerfile`](../../Dockerfile)

1. `planetiler-dist`

- Pulls the pinned upstream `ghcr.io/onthegomap/planetiler` image and reuses its Java runtime + application classpath in our `runtime-base`.

2. `deps`

- Installs backend production dependencies from `package-lock.json`.
- Changes only when backend dependency manifests change.

3. `frontend-deps`

- Installs frontend dependencies from `frontend/package-lock.json`.
- Isolated from backend source changes.

4. `frontend-runtime-deps`

- Starts from `frontend-deps` and prunes dev dependencies with `npm prune --omit=dev`.
- Keeps the runtime image free of frontend dev dependencies.

5. `frontend-build`

- Generates version metadata and builds frontend bundle from committed frontend assets.
- Installs the backend production dependency tree in the build-platform stage so `scripts/generate-version.ts` uses a matching native `esbuild` binary.
- Does not reuse the runtime `deps` layer.

6. `runtime`

- Uses pinned `node:24-bookworm-slim`.
- Contains only runtime assets:
  - backend runtime code (`server.sveltekit.ts`, `server.ts`, `src/`, `scripts/`, `workers/`)
  - `frontend/build`
  - `frontend/static`
  - production `node_modules`
  - `osm2pgsql`
  - `aria2`
  - `planetiler` wrapper + Java runtime
  - no QuackOSM / DuckDB / Python importer / `tippecanoe` runtime dependency for managed region sync

## Cache Stability Rules

- Dependency install is isolated before source code copy.
- Frontend dependency install is isolated from frontend sources.
- BuildKit cache mounts are used for:
  - npm (`/root/.npm`)
  - apt (`/var/cache/apt`, `/var/lib/apt/lists`)

## Build Context

`.dockerignore` excludes heavy and volatile paths:

- `.git`, `node_modules`, `frontend/node_modules`
- frontend local artifacts (`frontend/.svelte-kit`, `frontend/build`)
- local data and temporary files (`data`, `tmp`, `cache`, logs)
- test artifacts (`playwright-report`, `test-results`, `coverage`)
- local env files (`.env`, `.env.*`, except examples)

## Release Pipeline

Every push to `dev` runs [`.github/workflows/docker-dev.yml`](../../.github/workflows/docker-dev.yml). The workflow:

- builds only `linux/amd64` and publishes `streletskiy/archimap:dev`
- uses the same build metadata and hashed `runtime-base` tag as the release scripts
- builds `runtime-base` only when its derived tag is missing from Docker Hub
- reuses GitHub Actions caches and cancels superseded builds so an older commit cannot overwrite a newer `dev` image

Every pushed `X.Y.Z` tag runs
[`.github/workflows/docker-release.yml`](../../.github/workflows/docker-release.yml). The workflow:

- builds and publishes `linux/amd64` and `linux/arm64`
- publishes both `streletskiy/archimap:X.Y.Z` and `streletskiy/archimap:latest`
- checks that the shared `runtime-base` supports both release platforms before reusing it
- verifies both published tags and platforms before completing

The repository must have these GitHub Actions secrets:

- `DOCKERHUB_USERNAME` — Docker Hub account name
- `DOCKERHUB_TOKEN` — Docker Hub personal access token with read/write permission

Deploy the current development image:

```bash
export ARCHIMAP_IMAGE=streletskiy/archimap:dev
docker pull streletskiy/archimap:dev
docker compose up -d
```

The release scripts below remain available as a manual fallback and for custom registries.

Use release scripts:

- [`scripts/release-docker.ps1`](../../scripts/release-docker.ps1)
- [`scripts/release-docker.sh`](../../scripts/release-docker.sh)

```powershell
./scripts/release-docker.ps1 -Version 1.2.3 -Latest
```

```bash
chmod +x ./scripts/release-docker.sh
./scripts/release-docker.sh --version 1.2.3 --latest
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

- local source builds (`docker compose up --build`, default image tag `archimap-local:dev`)
- registry deploys (`ARCHIMAP_IMAGE=streletskiy/archimap:<version> docker compose up -d`)

The `archimap` service also sets `pull_policy: never`. Compose therefore does not silently pull a registry image for the app service when the local Docker image cache was wiped or Docker was reinstalled. This avoids accidentally booting an older published tag while iterating on the local working tree:

- for local source changes, rebuild explicitly with `docker compose up -d --build archimap`
- for published releases, pull the image first (`docker pull streletskiy/archimap:<version>`) and then run `docker compose up -d`

`admin-regions.pmtiles` is expected to be committed in the repository. The runtime container checks the served `admin-regions.geojson` hash on startup and rebuilds `admin-regions.pmtiles` with `planetiler` only when the archive is missing or out of date.

## PostgreSQL + PostGIS (default in Compose)

`docker-compose.yml` starts `db-postgres` by default.

```bash
docker compose up -d
```

The Compose service sets `shm_size: 512m` for `db-postgres` because Docker's default 64MB `/dev/shm` is often too small for PostGIS parallel workers and bbox filter queries.
It also sets `log_autovacuum_min_duration=-1` to suppress noisy autovacuum skip messages from the long-lived `region_import_stage` table during managed syncs.

Pending PostgreSQL migrations are applied automatically on app startup. Manual migrations/smoke remain available in the compose network for recovery or verification:

```bash
docker compose exec archimap npm run db:pg:migrate
docker compose exec archimap npm run db:pg:smoke
```

When an updated image contains storage-compaction PostgreSQL migrations, the first container start applies them automatically to the existing database. Expect a longer first boot and keep extra free disk space available temporarily while large tables are rebuilt.

Avoid bind-mounting local `./db` into `/app/db` on deployment hosts. The runtime image already contains `db/postgres/migrations`, and masking that path can make the app start against an empty schema.

If PostgreSQL logs `could not resize shared memory segment` or `could not attach to dynamic shared area` during `POST /api/buildings/filter-matches`, raise the `shm_size` value further or reduce parallelism for the affected query.

## Validate Layer Sizes

```bash
docker history streletskiy/archimap:1.2.3
```

Check that:

- dependency layer is separate and stable
- frontend build layer is separate
- runtime layers are small except unavoidable tool binaries
