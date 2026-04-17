# Runbook

## Production deploy

1. Set required secrets/env:
   - `SESSION_SECRET`
   - `APP_BASE_URL`
   - `DB_PROVIDER`
   - PostgreSQL connection via `DATABASE_URL` or full `POSTGRES_*`
   - `REDIS_URL` for Redis-backed sessions, or explicit `SESSION_ALLOW_MEMORY_FALLBACK=false|true`
   - `SMTP_*` / `EMAIL_FROM` if registration or password reset is enabled
2. Pull release image: `docker pull streletskiy/archimap:<version>`.
3. Set `ARCHIMAP_IMAGE=streletskiy/archimap:<version>` in environment (or `.env` used by Compose).
4. Start/update service: `docker compose up -d`.
   - `docker-compose.yml` sets `pull_policy: never` for the app service, so Compose will not auto-pull the image for you at this step.
   - Pending PostgreSQL migrations are applied automatically by the app container during startup.
   - Do not bind-mount local `./db` over `/app/db`; the image already contains the migration SQL.
5. Validate:
   - `/readyz`
   - `/healthz`
   - `/api/version`
   - `/api/contours-status`
   - `/metrics` only when `METRICS_ENABLED=true`

## Docker release script behavior

- Runtime base tag is derived from dependency versions (`tippecanoe`, `quackosm`, `duckdb`, `pip`).
- `scripts/release-docker.sh` and `scripts/release-docker.ps1` skip rebuilding `runtime-base` if that tag already exists in registry.
- Force rebuild only when needed:
  - Bash: `--force-runtime-base`
  - PowerShell: `-ForceRuntimeBase`

### How to run the Docker release scripts

1. Prerequisites:
   - `docker` is installed and running.
   - `docker buildx` is available.
   - Logged in to target registry (`docker login`).
2. Linux/macOS (Bash):
   - Minimal release:
     - `./scripts/release-docker.sh --version 1.2.3`
   - Custom image/platforms:
     - `./scripts/release-docker.sh --version 1.2.3 --image yourorg/archimap --platforms linux/amd64,linux/arm64`
   - Force runtime-base rebuild:
     - `./scripts/release-docker.sh --version 1.2.3 --force-runtime-base`
3. Windows (PowerShell):
   - Minimal release:
     - `./scripts/release-docker.ps1 -Version 1.2.3`
   - Custom image/platforms:
     - `./scripts/release-docker.ps1 -Version 1.2.3 -Image yourorg/archimap -Platforms linux/amd64,linux/arm64`
   - Force runtime-base rebuild:
     - `./scripts/release-docker.ps1 -Version 1.2.3 -ForceRuntimeBase`
4. Optional cache control:
   - Bash: `--no-cache` or `--cache-ref yourorg/archimap:buildcache`
   - PowerShell: `-NoCache` or `-CacheRef yourorg/archimap:buildcache`
5. Deploy published version:
   - `docker pull <image>:<version>`
   - `docker compose up -d`

## Data refresh

1. Open `Admin -> Data`, select or create the target region in the modal editor, and update its settings there.
2. Run `Sync now` for the target region from the same modal or `npm run tiles:build -- --region-id=<id>`.
3. Optional maintenance rebuild without re-import:
   - `node --import tsx scripts/sync-osm-region.ts --region-id=<id> --pmtiles-only`
4. Verify PMTiles:
   - `curl -I -H "Range: bytes=0-1023" http://host/api/data/regions/<id>/pmtiles`
   - Expect `206`, `Accept-Ranges`, `Content-Range`.

## First master admin setup

1. Start the service in normal production mode (`NODE_ENV=production`).
2. Run one-time command in the app container:
   - `docker compose exec archimap npm run admin:create-master -- --email=admin@example.com --password=<strong-password>`
3. Sign in with created account and verify admin access to `/admin`.
4. Optionally rotate password immediately after first login.

## Common incidents

### Map tiles not loading

- Check region PMTiles file exists in `data/regions/`.
- Check `/api/data/regions/<id>/pmtiles` returns `200` or `206`.
- Check CSP `connect-src`/`worker-src` and browser console.

### Search degraded

- Validate FTS source/index integrity.
- Re-run sync/rebuild flow.
- Check `/metrics` when enabled and request logs for high latency spikes.

### PostgreSQL shared memory exhausted

- Symptoms:
  - `could not resize shared memory segment ... No space left on device`
  - `could not attach to dynamic shared area`
  - `parallel worker` exit messages in the Postgres log
- Usually triggered by a heavy spatial filter query, especially `POST /api/buildings/filter-matches`.
- In Docker Compose, raise the `db-postgres` `shm_size` value above the default `512m` if the workload still exhausts shared memory.
- For non-Compose deployments, increase the container or host `/dev/shm` allocation, or disable parallel workers for the affected query path.

### Auth appears broken in local docker

- Usually cookie dropped on non-HTTPS:
  - set `SESSION_COOKIE_SECURE=false` for local HTTP only.
- If Redis is intentionally absent in local Docker:
  - set `SESSION_ALLOW_MEMORY_FALLBACK=true`.

### Runtime mode and entrypoint

- Public HTTP runtime entrypoint is `server.sveltekit.ts`.
- `server.ts` is a thin backend entrypoint that creates and exports the internal app runtime.
- API/system routes are dispatched by `server.sveltekit.ts` to the internal runtime assembled by `ServerRuntime` in `src/lib/server/boot/server-runtime.boot.ts`.
- Runtime assembly is further split into `server-runtime.config.ts`, `server-runtime.middleware.ts`, and `server-runtime.routes.ts`.

### Region sync CLI fails immediately

- Check `PYTHON_BIN` or system Python availability.
- Verify Python packages `quackosm` and `duckdb` are installed for the interpreter used by the app.
- If the failure is later in PMTiles build, verify `tippecanoe` or `TIPPECANOE_BIN`.

### Region shows `Sync interrupted by process restart` while a sync is still alive

- Current managed sync workers keep a heartbeat on every owned `queued`/`running` run, so another runtime instance should no longer archive a live sync immediately.
- If you still see this after upgrading, look for an actual second app process/container pointing at the same DB or an old release still running without the heartbeat fix.
- Long-running orphaned extract jobs should now self-stop because both `scripts/sync-osm-region.ts` and `scripts/sync-osm-buildings.py` watch their parent PID.
- If a stale-recovery `startup` retry was queued before the original run eventually reports `success`, the stale retry is now archived as superseded and cannot keep the region stuck in `queued`/`running` or overwrite the successful result later.
- Admin cancel now has a stale-state fallback: when the current runtime no longer owns the worker, it can still abandon `queued`/`running` runs whose DB heartbeat is already stale and repair a stuck region row that still says `queued`/`running` even though no active run remains.
- Region update/delete checks now block only on real active sync runs, not on a stale `last_sync_status` value left behind after an interrupted worker.

### Building selection in map UI

- Selection is atomic on first click: highlight + focus + modal open.
- Closing the building modal clears selection and highlight (`selectedBuilding=null`).
- Optional debug mode: set `MAP_SELECTION_ATOMIC_DEBUG=true`.
  - enables `[map-selection]` logs in browser console (dev/test),
  - exposes debug hook `document.body.dataset.selectedBuildingId`.
