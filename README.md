# archimap

![Node.js](https://img.shields.io/badge/node-%3E%3D18-339933?logo=node.js&logoColor=white)
![Python](https://img.shields.io/badge/python-%3E%3D3.11-3776AB?logo=python&logoColor=white)
![Docker](https://img.shields.io/badge/docker-enabled-2496ED?logo=docker&logoColor=white)
![OSM](https://img.shields.io/badge/data-OpenStreetMap-7EBC6F)
![Output](https://img.shields.io/badge/output-PMTiles-2F855A)
![License](https://img.shields.io/badge/license-Apache--2.0-blue)

archimap is a web app with an OSM-based vector map for viewing and editing architectural metadata of buildings.

## Contents

- [Highlights](#highlights)
- [Tech Stack](#tech-stack)
- [Architecture at a Glance](#architecture-at-a-glance)
- [Quick Start (Local)](#quick-start-local)
- [Docker Compose](#docker-compose)
- [Contour Sync](#contour-sync)
- [Search Logic](#search-logic)
- [API Overview](#api-overview)
- [Edits Workflow](#edits-workflow)
- [Environment Variables](#environment-variables)
- [External Projects](#external-projects)
- [License](#license)

## Highlights

- [MapLibre GL JS](https://maplibre.org/maplibre-gl-js/docs/) map with a customized Positron style.
- Building contours imported from OSM extracts ([QuackOSM](https://github.com/kraina-ai/quackosm)) or local `.osm.pbf`, stored in local [SQLite](https://www.sqlite.org/).
- Separate DBs for edits:
  - `local-edits.db` - merged local architectural metadata.
  - `user-edits.db` - user submissions with moderation status (`pending/accepted/partially_accepted/rejected/superseded`).
- Building modal with in-place editing (authorized users).
- Dedicated account page (`/account/`) for profile and password management.
- Dedicated admin page (`/admin/`) for user roles/permissions and local-edits moderation.
- UI kit is integrated as an admin tab (`/admin/?tab=uikit`) rather than a standalone page.
- OSM tags viewer in the building modal.
- OSM-tag filter panel with highlight of matching buildings.
- Viewport filter prefetch uses SQLite R*Tree bbox index with fallback to B-tree query when R*Tree is unavailable.
- Filter-tag keys are served from persistent SQLite cache and rebuilt in a background worker.
- Global building search (SQLite-wide, not viewport-limited) with FTS5 relevance + distance ranking.
- Search modal with skeleton loading and quick "go to building" action.
- Search map markers with zoom-dependent clustering and count labels.
- Mobile search bottom sheet keeps map visible while browsing results.
- URL state for map view and selected building.
- [Redis](https://redis.io/)-backed sessions.
- Automatic contour sync (startup + scheduled, configurable via env).
- [PMTiles](https://github.com/protomaps/PMTiles) vector layer for contours (generated locally via [tippecanoe](https://github.com/felt/tippecanoe)).

## Tech Stack

- Backend: [Node.js](https://nodejs.org/), [Express](https://expressjs.com/), [better-sqlite3](https://github.com/WiseLibs/better-sqlite3)
- Frontend: Vanilla JS, [MapLibre GL JS](https://maplibre.org/maplibre-gl-js/docs/), [Tailwind CSS](https://tailwindcss.com/)
- Data import: Python, [QuackOSM](https://github.com/kraina-ai/quackosm), [DuckDB](https://duckdb.org/), [tippecanoe](https://github.com/felt/tippecanoe), [PMTiles](https://github.com/protomaps/PMTiles)
- Sessions: [Redis](https://redis.io/)

## Architecture at a Glance

- Primary DB: `data/archimap.db`
  - `building_contours` (geometry + OSM tags)
  - `building_contours_rtree` (SQLite R*Tree bbox index)
  - Search structures (`building_search_source`, `building_search_fts`)
  - Filter tag key cache (`filter_tag_keys_cache`)
- Local metadata DB: `data/local-edits.db`
  - `architectural_info` merged overrides and additions
- User edits DB: `data/user-edits.db`
  - `building_user_edits` (author-scoped edits + moderation status and admin comments)
- Auth DB: `data/users.db`
  - `users`, registration codes, password-reset tokens
- Tiles artifact: `data/buildings.pmtiles`
- Main server: `server.js`
- Auth + email templates:
  - `auth.js`
  - `email-templates/index.js`
- Sync pipeline:
  - `scripts/sync-osm-buildings.js`
  - `scripts/sync-osm-buildings.py`
  - `scripts/rebuild-search-index.js`
  - `scripts/rebuild-filter-tag-keys-cache.js`

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

Local prerequisite (non-Docker):

- Python 3 with pip and importer modules:
  - `python -m pip install --user quackosm duckdb`
  - On Windows, if `python` is unavailable, use: `py -3 -m pip install --user quackosm duckdb`

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
- Search scope: full local `building_contours` + merged local overrides from `local-edits.db`.

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
- each item includes `lon`, `lat` (building center) for map markers/fit;
- frontend supports progressive loading via "Показать ещё";
- results modal shows skeleton on first page;
- map centers/fits to current result set and renders clustered markers;
- mobile search modal is rendered as a bottom sheet so markers remain visible.

Index lifecycle:

- startup checks DB fingerprint and search table counts;
- full rebuild runs only when data/index changed;
- incremental refresh runs after `POST /api/building-info`;
- post-auto-sync rebuild is conditional with the same checks;
- full rebuild runs in worker process: `scripts/rebuild-search-index.js`.

## Viewport Filter Logic

- Prefetch API: `GET /api/buildings/filter-data-bbox?minLon=...&minLat=...&maxLon=...&maxLat=...&limit=...`
- Data API: `POST /api/buildings/filter-data` with `keys: string[]`.
- BBox query path:
  - primary: `building_contours_rtree` -> `building_contours` -> `local.architectural_info`,
  - fallback: direct bbox scan on `building_contours` when R*Tree is unavailable/not ready.
- R*Tree lifecycle:
  - schema + triggers are ensured on startup and during sync,
  - startup never blocks HTTP availability; rebuild runs in background batches,
  - rebuild progress is logged in server console.
- Tag keys for filter UI:
  - served from `filter_tag_keys_cache`,
  - rebuilt in worker process (`scripts/rebuild-filter-tag-keys-cache.js`) on startup/auto-sync,
  - `/api/filter-tag-keys` returns `{ keys, warmingUp }` while cache is being warmed.

## API Overview

Detailed API list:

- [docs/API_OVERVIEW.md](./docs/API_OVERVIEW.md)

## Edits Workflow

Detailed edits workflow:

- [docs/EDITS_WORKFLOW.md](./docs/EDITS_WORKFLOW.md)

## Environment Variables

Full environment variables reference:

- [docs/ENVIRONMENT_VARIABLES.md](./docs/ENVIRONMENT_VARIABLES.md)

## External Projects

- [OpenStreetMap](https://www.openstreetmap.org/) for base geodata and OSM tags.
- [MapLibre GL JS](https://maplibre.org/maplibre-gl-js/docs/) for browser map rendering.
- [QuackOSM](https://github.com/kraina-ai/quackosm) for extracting OSM features from `.osm.pbf` or extract queries.
- [DuckDB](https://duckdb.org/) for spatial processing during import.
- [SQLite](https://www.sqlite.org/) + [FTS5](https://www.sqlite.org/fts5.html) for local storage and full-text search.
- [PMTiles](https://github.com/protomaps/PMTiles) for compact vector tile archives.
- [tippecanoe](https://github.com/felt/tippecanoe) for vector tile generation.
- [Redis](https://redis.io/) for session storage.

## License

- Source code: [Apache License 2.0](./LICENSE)
- Project notices: [NOTICE](./NOTICE)
- OpenStreetMap-derived data: [ODbL v1.0](https://opendatacommons.org/licenses/odbl/1-0/) (see [DATA_LICENSE.md](./DATA_LICENSE.md))
