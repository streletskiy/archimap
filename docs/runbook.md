# Runbook

## Production deploy
1. Set required secrets/env (`SESSION_SECRET`, `APP_BASE_URL`, DB paths, SMTP if used).
2. Build frontend: `npm run build`.
3. Start service: `npm run start`.
4. Validate:
   - `/readyz`
   - `/healthz`
   - `/api/contours-status`

## Data refresh
1. Update OSM source settings.
2. Run `npm run tiles:build`.
3. Verify PMTiles:
   - `curl -I -H "Range: bytes=0-1023" http://host/api/buildings.pmtiles`
   - Expect `206`, `Accept-Ranges`, `Content-Range`.

## Safe first admin bootstrap
1. In production keep `BOOTSTRAP_ADMIN_ENABLED=false` by default.
2. For one-time bootstrap:
   - set `BOOTSTRAP_ADMIN_ENABLED=true`
   - set `BOOTSTRAP_ADMIN_SECRET=<one-time-secret>`
   - set restrictive `BOOTSTRAP_ADMIN_ALLOWED_IPS`
3. Complete first registration.
4. Revert `BOOTSTRAP_ADMIN_ENABLED=false` and rotate bootstrap secret.

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
