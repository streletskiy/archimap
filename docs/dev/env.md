# Environment

## Public vs private
- Public client config is delivered only through `/app-config.js`.
- Server secrets stay private in process env and server-only modules.
- Do not add secrets to frontend source or static assets.

## Core required variables
- `SESSION_SECRET`
- `APP_BASE_URL`
- `TRUST_PROXY` (for reverse proxy setups)
- `SESSION_COOKIE_SECURE` (explicit override for non-HTTPS local env)

## Data/database paths
- `ARCHIMAP_DB_PATH`
- `OSM_DB_PATH`
- `USER_AUTH_DB_PATH`
- `LOCAL_EDITS_DB_PATH`
- `USER_EDITS_DB_PATH`

## Security knobs
- `BOOTSTRAP_ADMIN_ENABLED`
- `BOOTSTRAP_ADMIN_SECRET`
- `BOOTSTRAP_ADMIN_ALLOWED_IPS`
- `CSP_CONNECT_SRC_EXTRA`

## PMTiles / sync
- `BUILDINGS_PMTILES_FILE`
- `BUILDINGS_PMTILES_SOURCE_LAYER`
- `AUTO_SYNC_ENABLED`
- `AUTO_SYNC_ON_START`
- `AUTO_SYNC_INTERVAL_HOURS`

Reference template: `.env.example`.
