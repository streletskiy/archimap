# Environment

## Public vs private

- Public client config is delivered only through `/app-config.js`.
- Server secrets stay private in process env and server-only modules.
- Do not add secrets to frontend source or static assets.

## Core required variables (production)

- `SESSION_SECRET`
- `APP_BASE_URL`
- `DB_PROVIDER`
- `DATABASE_URL` or `POSTGRES_HOST`/`POSTGRES_PORT`/`POSTGRES_DB`/`POSTGRES_USER`/`POSTGRES_PASSWORD` when `DB_PROVIDER=postgres`
- `DATABASE_PATH` / `ARCHIMAP_DB_PATH` when `DB_PROVIDER=sqlite`
- `REDIS_URL` (recommended; or enable explicit memory fallback)

The exhaustive template with current defaults and comments is [`.env.example`](../../.env.example).

## Database provider toggle

- `DB_PROVIDER` - `sqlite` or `postgres`.
- Default if unset: `postgres` for non-development environments, `sqlite` for `NODE_ENV=development`.
- `DATABASE_URL` - required when `DB_PROVIDER=postgres`.
- `SQLITE_URL` - optional SQLite URL/path; existing `DATABASE_PATH`/`ARCHIMAP_DB_PATH` remain supported.

## Data/database paths

- `DATABASE_PATH` (alias)
- `ARCHIMAP_DB_PATH`
- `OSM_DB_PATH`
- `USER_AUTH_DB_PATH`
- `LOCAL_EDITS_DB_PATH`
- `USER_EDITS_DB_PATH`

## PostgreSQL/PostGIS settings

- `POSTGRES_HOST`
- `POSTGRES_PORT`
- `POSTGRES_DB`
- `POSTGRES_USER`
- `POSTGRES_PASSWORD`

## Security knobs

- `APP_BASE_URL`
- `TRUST_PROXY`
- `SESSION_COOKIE_SECURE`
- `SESSION_ALLOW_MEMORY_FALLBACK`
- `APP_SETTINGS_SECRET`
- `CSP_CONNECT_SRC_EXTRA`

## Observability and app identity

- `LOG_LEVEL`
- `METRICS_ENABLED`
- `APP_DISPLAY_NAME`

## DB-backed data settings

- Runtime OSM region settings live in `Admin -> Data`.
- Each enabled region stores its extract query, schedule, PMTiles zooms/layer, bounds, sync status, and run history in the application DB.
- The map runtime receives regional PMTiles metadata only through `/app-config.js`.

## Region defaults

- `AUTO_SYNC_ENABLED`
- `AUTO_SYNC_ON_START`
- `AUTO_SYNC_INTERVAL_HOURS`
- `BUILDINGS_PMTILES_SOURCE_LAYER`
- `BUILDINGS_PMTILES_MIN_ZOOM`
- `BUILDINGS_PMTILES_MAX_ZOOM`

There is no env-based region selector anymore. Extract queries are configured only in `Admin -> Data`.

These values are not the runtime source of truth. They are used only as server-side defaults when DB-backed region fields are missing.

On first startup with an empty data-settings DB, bootstrap only records that DB-backed settings are active; it does not import regions from env anymore.

## System envs that stay outside admin UI

- `DATABASE_URL`, `DATABASE_PATH`, `ARCHIMAP_DB_PATH`, `OSM_DB_PATH`
- `LOCAL_EDITS_DB_PATH`, `USER_EDITS_DB_PATH`, `USER_AUTH_DB_PATH`
- `PYTHON_BIN`
- `TIPPECANOE_BIN`
- `ADMIN_REGIONS_PMTILES_ON_START` - `auto` (default), `always`, or `never`; controls whether the container startup checks and optionally rebuilds `frontend/build/client/admin-regions.pmtiles`.
- `SESSION_SECRET`, `APP_SETTINGS_SECRET`, SMTP credentials, Redis/session settings

## Map defaults

- `MAP_DEFAULT_LON`
- `MAP_DEFAULT_LAT`
- `MAP_DEFAULT_ZOOM`

These values are used as fallback camera only when neither URL nor the saved client-side camera provide a valid position.

## Troubleshooting

- `DB_PROVIDER=postgres` and login looks stateless in local HTTP:
  set `SESSION_COOKIE_SECURE=false` for non-HTTPS local runs.
- `DB_PROVIDER=postgres` but startup fails:
  verify `DATABASE_URL` (or full `POSTGRES_*`) and run `npm run db:pg:migrate`.
- `node --import tsx scripts/sync-osm-region.ts --region-id=<id>` fails before extract starts:
  verify `PYTHON_BIN` or install Python modules `quackosm` and `duckdb`.
- `node --import tsx scripts/sync-osm-region.ts --region-id=<id>` fails during PMTiles build:
  install `tippecanoe` or set `TIPPECANOE_BIN`.
- Newly created regions do not appear on the map:
  verify the region has a successful sync, non-empty bounds, and a PMTiles file under `data/regions/`.

Reference template: [`.env.example`](../../.env.example).
