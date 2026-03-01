# Environment Variables

| Variable                                | Description                                                                                                                                              |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PORT`                                  | Server port.                                                                                                                                             |
| `TRUST_PROXY`                           | Set `true` when app works behind reverse proxy/ingress so secure cookies and request protocol are handled correctly.                                     |
| `SESSION_SECRET`                        | Session secret.                                                                                                                                          |
| `REDIS_URL`                             | Redis URL for sessions (default: `redis://redis:6379`).                                                                                                  |
| `SESSION_ALLOW_MEMORY_FALLBACK`         | Allow fallback to in-memory sessions when Redis is unavailable. Defaults to `true` in development and `false` in production. Keep `false` in production. |
| `SESSION_COOKIE_SECURE`                 | Force secure session cookie (`true/false`). If not set, defaults to `true` in production and `false` otherwise. Set `false` for local HTTP Docker runs.  |
| `LOG_LEVEL`                             | Structured logger minimum level (`debug`, `info`, `warn`, `error`; default `info`).                                                                      |
| `METRICS_ENABLED`                       | Enable Prometheus-style `/metrics` endpoint (`true/false`, default `true`).                                                                              |
| `ARCHIMAP_DB_PATH`                      | Path to primary DB (default: `data/archimap.db`).                                                                                                        |
| `OSM_DB_PATH`                           | Path to OSM contours DB (default: `data/osm.db`).                                                                                                        |
| `USER_AUTH_DB_PATH`                     | Path to auth DB (default: `data/users.db`).                                                                                                              |
| `MAP_DEFAULT_LON`                       | Default map longitude when URL hash has no `#map=...`.                                                                                                   |
| `MAP_DEFAULT_LAT`                       | Default map latitude when URL hash has no `#map=...`.                                                                                                    |
| `MAP_DEFAULT_ZOOM`                      | Default map zoom when URL hash has no `#map=...`.                                                                                                        |
| `USER_EDITS_DB_PATH`                    | Optional custom path for user moderation DB (default: `data/user-edits.db`).                                                                             |
| `APP_DISPLAY_NAME`                      | App name used in registration emails (default: `archimap`).                                                                                              |
| `APP_BASE_URL`                          | Public application base URL used in password reset links (for example: `https://archimap.example.com`). Recommended to set explicitly for security.      |
| `APP_SETTINGS_SECRET`                   | Secret used to encrypt app settings in DB (for example SMTP password). Defaults to `SESSION_SECRET` if not set.                                          |
| `SMTP_URL`                              | Full SMTP connection URL (alternative to host/port/user/pass).                                                                                           |
| `SMTP_HOST`                             | SMTP host for registration emails.                                                                                                                       |
| `SMTP_PORT`                             | SMTP port for registration emails (default: `587`).                                                                                                      |
| `SMTP_SECURE`                           | Use TLS SMTP transport (`true/false`).                                                                                                                   |
| `SMTP_USER`                             | SMTP username.                                                                                                                                           |
| `SMTP_PASS`                             | SMTP password or app password.                                                                                                                           |
| `EMAIL_FROM`                            | Sender address for registration emails (for example: `archimap <no-reply@example.com>`).                                                                 |
| `REGISTRATION_ENABLED`                  | Enable/disable regular email registration (`true/false`, default `true`). Note: first-user bootstrap admin signup is still allowed even when `false`.    |
| `REGISTRATION_CODE_TTL_MINUTES`         | Verification code lifetime in minutes (`2..60`, default `15`).                                                                                           |
| `REGISTRATION_CODE_RESEND_COOLDOWN_SEC` | Delay before requesting another code in seconds (`10..600`, default `60`).                                                                               |
| `REGISTRATION_CODE_MAX_ATTEMPTS`        | Maximum wrong code attempts before re-request is required (`3..12`, default `6`).                                                                        |
| `REGISTRATION_MIN_PASSWORD_LENGTH`      | Minimum password length for new users (`8..72`, default `8`).                                                                                            |
| `PASSWORD_RESET_TTL_MINUTES`            | Password reset link lifetime in minutes (`5..180`, default `60`).                                                                                        |
| `USER_EDIT_REQUIRES_PERMISSION`         | If `true` (default), regular users can edit buildings only when `can_edit=1` in `auth.users`. If `false`, any authenticated user can edit.               |
| `OSM_EXTRACT_QUERY`                     | Optional single QuackOSM extract query (example: `Gibraltar`).                                                                                           |
| `OSM_EXTRACT_QUERIES`                   | Optional semicolon-separated extract queries (example: `Nizhny Novgorod;Moscow Oblast;Russia`).                                                          |
| `OSM_PBF_PATH`                          | Optional path to local `.osm.pbf`.                                                                                                                       |
| `PBF_PROGRESS_EVERY`                    | Importer progress print interval.                                                                                                                        |
| `PBF_PROGRESS_COUNT_PASS`               | Optional fallback retry flag (`--no-count-pass` on retry).                                                                                               |
| `AUTO_SYNC_ENABLED`                     | Enable/disable auto sync (`true/false`).                                                                                                                 |
| `AUTO_SYNC_ON_START`                    | Run sync on startup (`true/false`).                                                                                                                      |
| `AUTO_SYNC_INTERVAL_HOURS`              | Periodic sync interval in hours (`<=0` disables periodic sync).                                                                                          |
| `SEARCH_INDEX_BATCH_SIZE`               | FTS rebuild batch size (`200..20000`, default `2500`).                                                                                                   |
| `RTREE_REBUILD_BATCH_SIZE`              | Background R\*Tree rebuild batch size (`500..20000`, default `4000`).                                                                                    |
| `RTREE_REBUILD_PAUSE_MS`                | Delay between R\*Tree batches in ms (`0..200`, default `8`).                                                                                             |
| `LOCAL_EDITS_DB_PATH`                   | Path to local edits DB (default: `data/local-edits.db`).                                                                                                 |
| `BUILDINGS_PMTILES_FILE`                | PMTiles output filename inside `data/` (default: `buildings.pmtiles`).                                                                                   |
| `BUILDINGS_PMTILES_SOURCE_LAYER`        | Vector layer name written by tippecanoe (default: `buildings`).                                                                                          |
| `BUILDINGS_PMTILES_MIN_ZOOM`            | Minimum PMTiles zoom (default: `13`).                                                                                                                    |
| `BUILDINGS_PMTILES_MAX_ZOOM`            | Maximum PMTiles zoom (default: `16`).                                                                                                                    |
| `TIPPECANOE_BIN`                        | Optional absolute path to `tippecanoe`.                                                                                                                  |
| `TIPPECANOE_PROGRESS_JSON`              | Print tippecanoe progress as JSON lines (default: `true`).                                                                                               |
| `TIPPECANOE_PROGRESS_INTERVAL_SEC`      | Tippecanoe progress update interval in seconds (default: `5`).                                                                                           |

Startup sync behavior details:

- startup sync is skipped automatically when both `osm.building_contours` and PMTiles file already exist;
- when `AUTO_SYNC_ON_START=false`, app still builds missing PMTiles from existing `osm.building_contours` (without full OSM import).

Build info in `/info/` page:

- for Docker builds, `shortSha` + `version` are embedded automatically during image build into `build-info.json` (from git metadata);
- if no exact tag on `HEAD`, version is `dev`;
- fallback is `unknown` + `dev` when git metadata is unavailable.
