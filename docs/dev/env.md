# Environment

## Public vs private
- Public client config is delivered only through `/app-config.js`.
- Server secrets stay private in process env and server-only modules.
- Do not add secrets to frontend source or static assets.

## Core required variables (production)
- `SESSION_SECRET`
- `REDIS_URL`
- `DATABASE_PATH` (alias for `ARCHIMAP_DB_PATH`)
- `BOOTSTRAP_ADMIN_ENABLED`

## Data/database paths
- `DATABASE_PATH` (alias)
- `ARCHIMAP_DB_PATH`
- `OSM_DB_PATH`
- `USER_AUTH_DB_PATH`
- `LOCAL_EDITS_DB_PATH`
- `USER_EDITS_DB_PATH`

## Security knobs
- `APP_BASE_URL`
- `TRUST_PROXY`
- `SESSION_COOKIE_SECURE`
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
