# Runbook

## Production deploy

1. Set required secrets/env (`SESSION_SECRET`, `APP_BASE_URL`, DB paths, SMTP if used).
2. Pull release image: `docker pull streletskiy/archimap:<version>`.
3. Set `ARCHIMAP_IMAGE=streletskiy/archimap:<version>` in environment (or `.env` used by Compose).
4. Start/update service: `docker compose up -d`.
5. Validate:
   - `/readyz`
   - `/healthz`
   - `/api/contours-status`

## Data refresh

1. Update OSM source settings.
2. Run `npm run tiles:build`.
3. Verify PMTiles:
   - `curl -I -H "Range: bytes=0-1023" http://host/api/buildings.pmtiles`
   - Expect `206`, `Accept-Ranges`, `Content-Range`.

## First master admin setup

1. Start the service in normal production mode (`NODE_ENV=production`).
2. Run one-time command in the app container:
   - `docker compose exec archimap npm run admin:create-master -- --email=admin@example.com --password=<strong-password>`
3. Sign in with created account and verify admin access to `/admin`.
4. Optionally rotate password immediately after first login.

## Common incidents

### Map tiles not loading

- Check PMTiles file exists in `data/`.
- Check `/api/buildings.pmtiles` returns `200` or `206`.
- Check CSP `connect-src`/`worker-src` and browser console.

### Search degraded

- Validate FTS source/index integrity.
- Re-run sync/rebuild flow.
- Check `/metrics` and request logs for high latency spikes.

### Auth appears broken in local docker

- Usually cookie dropped on non-HTTPS:
  - set `SESSION_COOKIE_SECURE=false` for local HTTP only.
