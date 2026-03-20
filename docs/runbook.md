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

1. Update region settings in `Admin -> Data`.
2. Run `Sync now` for the target region or `npm run tiles:build -- --region-id=<id>`.
3. Optional maintenance rebuild without re-import:
   - `node scripts/sync-osm-region.js --region-id=<id> --pmtiles-only`
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

### Auth appears broken in local docker

- Usually cookie dropped on non-HTTPS:
  - set `SESSION_COOKIE_SECURE=false` for local HTTP only.
- If Redis is intentionally absent in local Docker:
  - set `SESSION_ALLOW_MEMORY_FALLBACK=true`.

### Runtime mode and entrypoint

- Public HTTP runtime entrypoint is `server.sveltekit.js`.
- `server.js` is a thin backend entrypoint that creates and exports the internal app runtime.
- API/system routes are dispatched by `server.sveltekit.js` to the internal runtime assembled by `ServerRuntime` in `src/lib/server/boot/server-runtime.boot.js`.
- Runtime assembly is further split into `server-runtime.config.js`, `server-runtime.middleware.js`, and `server-runtime.routes.js`.

### Region sync CLI fails immediately

- Check `PYTHON_BIN` or system Python availability.
- Verify Python packages `quackosm` and `duckdb` are installed for the interpreter used by the app.
- If the failure is later in PMTiles build, verify `tippecanoe` or `TIPPECANOE_BIN`.

### Building selection in map UI

- Selection is atomic on first click: highlight + focus + modal open.
- Closing the building modal clears selection and highlight (`selectedBuilding=null`).
- Optional debug mode: set `MAP_SELECTION_ATOMIC_DEBUG=true`.
  - enables `[map-selection]` logs in browser console (dev/test),
  - exposes debug hook `document.body.dataset.selectedBuildingId`.
