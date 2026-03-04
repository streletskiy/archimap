# Environment

## Public vs private

- Public client config is delivered only through `/app-config.js`.
- Server secrets stay private in process env and server-only modules.
- Do not add secrets to frontend source or static assets.

## Core required variables (production)

- `SESSION_SECRET`
- `REDIS_URL`
- `DATABASE_PATH` (alias for `ARCHIMAP_DB_PATH`)
- `APP_BASE_URL`

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
- `CSP_CONNECT_SRC_EXTRA`

## PMTiles / sync

- `BUILDINGS_PMTILES_FILE`
- `BUILDINGS_PMTILES_SOURCE_LAYER`
- `AUTO_SYNC_ENABLED`
- `AUTO_SYNC_ON_START`
- `AUTO_SYNC_INTERVAL_HOURS`

## Map defaults

- `MAP_DEFAULT_LON`
- `MAP_DEFAULT_LAT`
- `MAP_DEFAULT_ZOOM`

These values are used as initial camera only when URL does not provide `lat/lng/z`.

Reference template: [`.env.example`](../../.env.example).
