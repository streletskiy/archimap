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
- `CSP_CONNECT_SRC_EXTRA` - defaults to CARTO tile hosts, `api.maptiler.com`, and the public Overpass origins used by the browser fallback

## Observability and app identity

- `LOG_LEVEL`
- `METRICS_ENABLED`
- `APP_DISPLAY_NAME`

## Docker image selection

- `ARCHIMAP_IMAGE` - optional compose image tag for the `archimap` service.
- Local source builds should usually leave it unset or point it to a local tag such as `archimap-local:dev`.
- Pull-based deploys should set it to a published registry tag such as `streletskiy/archimap:1.2.3`.

## DB-backed data settings

- Runtime OSM region settings live in `Admin -> Data`.
- Each enabled region stores its extract query, schedule, PMTiles zooms/layer, bounds, sync status, and run history in the application DB.
- The map runtime receives regional PMTiles metadata only through `/app-config.js`.

## DB-backed general settings

- `Admin -> Settings` stores runtime general settings in DB.
- Basemap selection (`carto|maptiler|custom`) and the public `MapTiler` browser key are delivered to clients only through `/app-config.js`.
- Custom basemap TileJSON URL and optional API key are also stored in DB settings, but the browser uses same-origin proxy routes for custom TileJSON and tiles, while glyphs and sprites are served from local static assets, so no custom basemap host needs to be added to CSP.

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
- `PLANETILER_BIN` - optional absolute path to the `planetiler` wrapper/command. The Docker runtime image ships `/usr/local/bin/planetiler` out of the box.
- `PMTILES_PROGRESS_JSON` / `PMTILES_PROGRESS_INTERVAL_SEC` - optional build-stage progress tuning for managed PMTiles generation.
- `REGION_SYNC_IMPORT_APPLY_BATCH_SIZE` - apply-stage batching knob for the PostgreSQL merge/apply path.
- `REGION_SYNC_RENDER_CACHE_REFRESH` - `true` refreshes `osm.region_render_features` after PostgreSQL apply so later `--pmtiles-only` rebuilds can reuse the derived render model; default `false` keeps the current full-sync path lighter.
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
  verify `DB_PROVIDER=postgres`, `DATABASE_URL`, and that `osm2pgsql` is available in the runtime image.
- `node --import tsx scripts/sync-osm-region.ts --region-id=<id>` fails during PMTiles build:
  verify `planetiler` or `PLANETILER_BIN`.
- Newly created regions do not appear on the map:
  verify the region has a successful sync, non-empty bounds, and a PMTiles file under `data/regions/`.

Reference template: [`.env.example`](../../.env.example).
