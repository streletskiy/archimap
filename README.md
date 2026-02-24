# ArchiMap

ArchiMap is a web app with an OSM-based vector map for viewing and editing architectural metadata of buildings.

## Contents

- [Highlights](#highlights)
- [Tech Stack](#tech-stack)
- [Architecture at a Glance](#architecture-at-a-glance)
- [Quick Start (Local)](#quick-start-local)
- [Docker Compose](#docker-compose)
- [Contour Sync](#contour-sync)
- [Search Logic](#search-logic)
- [API Overview](#api-overview)
- [Environment Variables](#environment-variables)
- [External Projects](#external-projects)

## Highlights

- [MapLibre GL JS](https://maplibre.org/maplibre-gl-js/docs/) map with a customized Positron style.
- Building contours imported from OSM extracts ([QuackOSM](https://github.com/kraina-ai/quackosm)) or local `.osm.pbf`, stored in local [SQLite](https://www.sqlite.org/).
- Separate local edits DB (`local-edits.db`) for architectural metadata:
  `name`, `style`, `levels`, `year`, `architect`, `address`, `description`.
- Building modal with in-place editing (authorized users).
- OSM tags viewer in the building modal.
- OSM-tag filter panel with highlight of matching buildings.
- Global building search (SQLite-wide, not viewport-limited) with FTS5 relevance + distance ranking.
- Search modal with skeleton loading and quick "go to building" action.
- URL state for map view and selected building.
- [Redis](https://redis.io/)-backed sessions.
- Automatic contour sync (startup + scheduled, configurable via env).
- [PMTiles](https://github.com/protomaps/PMTiles) vector layer for contours (generated locally via [tippecanoe](https://github.com/felt/tippecanoe)).

## Tech Stack

- Backend: [Node.js](https://nodejs.org/), [Express](https://expressjs.com/), [better-sqlite3](https://github.com/WiseLibs/better-sqlite3)
- Frontend: Vanilla JS, [MapLibre GL JS](https://maplibre.org/maplibre-gl-js/docs/), [Tailwind CSS](https://tailwindcss.com/), [Flowbite](https://flowbite.com/)
- Data import: Python, [QuackOSM](https://github.com/kraina-ai/quackosm), [DuckDB](https://duckdb.org/), [tippecanoe](https://github.com/felt/tippecanoe), [PMTiles](https://github.com/protomaps/PMTiles)
- Sessions: [Redis](https://redis.io/)

## Architecture at a Glance

- Primary DB: `data/archimap.db`
  - `building_contours` (geometry + OSM tags)
  - Search structures (`building_search_source`, `building_search_fts`)
- Local metadata DB: `data/local-edits.db`
  - `architectural_info` overrides and additions
- Tiles artifact: `data/buildings.pmtiles`
- Main server: `server.js`
- Sync pipeline:
  - `scripts/sync-osm-buildings.js`
  - `scripts/sync-osm-buildings.py`

## Quick Start (Local)

1. Install dependencies:

```bash
npm install
```

2. Create `.env` from `.env.example`.

3. Start server:

```bash
npm start
```

4. Open:

```text
http://localhost:3252
```

## Docker Compose

1. Prepare `.env`.
2. Start:

```bash
docker compose up -d
```

3. Stop:

```bash
docker compose down
```

Persistent data is stored in `./data` via `./data:/app/data`.

## Contour Sync

Run manually:

```bash
npm run sync:city
```

Import modes:

- `OSM_EXTRACT_QUERY` / `OSM_EXTRACT_QUERIES`: QuackOSM auto-finds/downloads extract by query.
- `OSM_PBF_PATH`: imports from a local `.osm.pbf`.

What sync does:

- imports building geometries + all available OSM tags into `building_contours`;
- removes stale buildings not present in the latest import;
- rebuilds `data/buildings.pmtiles` from local [SQLite](https://www.sqlite.org/) via [tippecanoe](https://github.com/felt/tippecanoe);
- writes minimal PMTiles attributes (`feature.id` + `osm_id`) to keep tiles compact;
- prints progress in terminal.

Importer details:

- extracts building features via [QuackOSM](https://github.com/kraina-ai/quackosm) (`tags_filter={"building": true}`);
- computes geometry and bbox in [DuckDB](https://duckdb.org/) (spatial extension);
- writes into `building_contours` directly from DuckDB (`INSERT/UPSERT` style SQL, no per-row Python loop).

PMTiles-only mode (no OSM import):

```bash
node scripts/sync-osm-buildings.js --pmtiles-only
```

## Search Logic

- API: `GET /api/search-buildings?q=...&lon=...&lat=...&limit=...&cursor=...`
- Search scope: full local `building_contours` + local overrides from `local-edits.db`.

Search index:

- Source table `building_search_source` stores normalized searchable fields + geometry center.
- FTS table `building_search_fts` (SQLite FTS5, `unicode61`) indexes:
  - `name`
  - `address`
  - `style`
  - `architect`

Fields used:

- `name`: `local.architectural_info.name`, OSM `name`, `name:ru`, `official_name`
- `address`: `local.architectural_info.address`, OSM `addr:*` including `addr:place`
- `style`: `local.architectural_info.style`, OSM `building:architecture`, `architecture`, `style`
- `architect`: `local.architectural_info.architect`, OSM `architect`, `architect_name`

Matching and ranking:

- query is tokenized;
- all tokens are required (`AND` across token prefixes in FTS);
- ordering: local-edited buildings first, then `bm25`, then distance to current map center.

Pagination and UX:

- response returns `items`, `hasMore`, `nextCursor`;
- frontend supports progressive loading via "Показать ещё";
- results modal shows skeleton on first page.

Index lifecycle:

- startup checks DB fingerprint and search table counts;
- full rebuild runs only when data/index changed;
- incremental refresh runs after `POST /api/building-info`;
- post-auto-sync rebuild is conditional with the same checks;
- full rebuild runs in worker process: `scripts/rebuild-search-index.js`.

## API Overview

- PMTiles:
  - `GET /api/buildings.pmtiles`
- Building details:
  - `GET /api/building/:osmType/:osmId`
  - `GET /api/building-info/:osmType/:osmId`
  - `POST /api/building-info`
- Search:
  - `GET /api/search-buildings`
- Auth:
  - `GET /api/me`
  - `POST /api/login`
  - `POST /api/logout`

## Environment Variables

| Variable | Description |
|---|---|
| `PORT` | Server port. |
| `SESSION_SECRET` | Session secret. |
| `REDIS_URL` | Redis URL for sessions (default: `redis://redis:6379`). |
| `MAP_DEFAULT_LON` | Default map longitude when URL hash has no `#map=...`. |
| `MAP_DEFAULT_LAT` | Default map latitude when URL hash has no `#map=...`. |
| `MAP_DEFAULT_ZOOM` | Default map zoom when URL hash has no `#map=...`. |
| `ADMIN_USERNAME` | Admin login. |
| `ADMIN_PASSWORD` | Admin password. |
| `OSM_EXTRACT_QUERY` | Optional single QuackOSM extract query (example: `Gibraltar`). |
| `OSM_EXTRACT_QUERIES` | Optional semicolon-separated extract queries (example: `Nizhny Novgorod;Moscow Oblast;Russia`). |
| `OSM_PBF_PATH` | Optional path to local `.osm.pbf`. |
| `PBF_PROGRESS_EVERY` | Importer progress print interval. |
| `PBF_PROGRESS_COUNT_PASS` | Optional fallback retry flag (`--no-count-pass` on retry). |
| `AUTO_SYNC_ENABLED` | Enable/disable auto sync (`true/false`). |
| `AUTO_SYNC_ON_START` | Run sync on startup (`true/false`). |
| `AUTO_SYNC_INTERVAL_HOURS` | Periodic sync interval in hours (`<=0` disables periodic sync). |
| `SEARCH_INDEX_BATCH_SIZE` | FTS rebuild batch size (`200..20000`, default `2500`). |
| `LOCAL_EDITS_DB_PATH` | Path to local edits DB (default: `data/local-edits.db`). |
| `BUILDINGS_PMTILES_FILE` | PMTiles output filename inside `data/` (default: `buildings.pmtiles`). |
| `BUILDINGS_PMTILES_SOURCE_LAYER` | Vector layer name written by tippecanoe (default: `buildings`). |
| `BUILDINGS_PMTILES_MIN_ZOOM` | Minimum PMTiles zoom (default: `13`). |
| `BUILDINGS_PMTILES_MAX_ZOOM` | Maximum PMTiles zoom (default: `16`). |
| `TIPPECANOE_BIN` | Optional absolute path to `tippecanoe`. |
| `TIPPECANOE_PROGRESS_JSON` | Print tippecanoe progress as JSON lines (default: `true`). |
| `TIPPECANOE_PROGRESS_INTERVAL_SEC` | Tippecanoe progress update interval in seconds (default: `5`). |

Startup sync behavior details:

- startup sync is skipped automatically when both `building_contours` and PMTiles file already exist;
- when `AUTO_SYNC_ON_START=false`, app still builds missing PMTiles from existing `building_contours` (without full OSM import).

## External Projects

- [OpenStreetMap](https://www.openstreetmap.org/) for base geodata and OSM tags.
- [MapLibre GL JS](https://maplibre.org/maplibre-gl-js/docs/) for browser map rendering.
- [QuackOSM](https://github.com/kraina-ai/quackosm) for extracting OSM features from `.osm.pbf` or extract queries.
- [DuckDB](https://duckdb.org/) for spatial processing during import.
- [SQLite](https://www.sqlite.org/) + [FTS5](https://www.sqlite.org/fts5.html) for local storage and full-text search.
- [PMTiles](https://github.com/protomaps/PMTiles) for compact vector tile archives.
- [tippecanoe](https://github.com/felt/tippecanoe) for vector tile generation.
- [Redis](https://redis.io/) for session storage.