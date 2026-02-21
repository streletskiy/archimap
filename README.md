# ArchiMap

ArchiMap is a web app with an OSM-based vector map for viewing and editing architectural metadata of buildings.

## Features

- MapLibre GL map with a customized Positron style.
- Building contours imported from Geofabrik PBF and stored in local SQLite.
- Additional building metadata stored in SQLite:
  `name`, `style`, `levels`, `year`, `architect`, `address`, `description`.
- Building info modal with in-place editing for authorized users.
- OSM tags viewer in building modal.
- OSM-tag filter panel with highlight of matching buildings.
- Global building search (SQLite-wide, not only current viewport) with FTS5 relevance + distance ranking.
- Search results modal with skeleton loading and quick "go to building" action.
- URL state for map view/building selection.
- Redis-backed sessions.
- Automatic contour sync (startup + scheduled, configurable via env).
- Tile-based contour loading with client-side cache for better map performance.

## Tech Stack

- Backend: Node.js, Express, better-sqlite3
- Frontend: Vanilla JS, MapLibre GL, Tailwind/Flowbite
- Data import: Python + osmium
- Sessions: Redis

## Local Run

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

What it does:

- downloads Geofabrik PBF only when changed (or always with `FORCE_DOWNLOAD=true`);
- uses `aria2c` when available;
- imports building geometries + all available OSM tags into `building_contours`;
- removes stale buildings no longer present in the latest import;
- prints progress in terminal.

## Search Logic

- API: `GET /api/search-buildings?q=...&lon=...&lat=...&limit=...&cursor=...`.
- Search scope: full local `building_contours` (+ local overrides from `architectural_info`), not limited by viewport.
- Search index:
  - source table `building_search_source` stores normalized searchable fields + geometry center;
  - FTS table `building_search_fts` (SQLite FTS5, `unicode61`) indexes `name`, `address`, `style`, `architect`.
- Fields used:
  - `name` (`architectural_info.name`, OSM `name`, `name:ru`, `official_name`)
  - `address` (`architectural_info.address`, OSM `addr:*` including `addr:place`)
  - `style` (`architectural_info.style`, OSM `building:architecture` / `architecture` / `style`)
  - `architect` (`architectural_info.architect`, OSM `architect` / `architect_name`)
- Matching and ranking:
  - query is tokenized;
  - all tokens are required (`AND` across token prefixes in FTS);
  - ordering: `bm25` relevance, then distance to current map center.
- Pagination:
  - response returns `items`, `hasMore`, `nextCursor`;
  - frontend supports progressive loading via "Показать ещё".
- Index lifecycle:
  - startup checks DB fingerprint and search table counts; full rebuild runs only when data/index changed;
  - per-building incremental refresh after `POST /api/building-info`;
  - post-auto-sync rebuild is also conditional (same fingerprint/count checks);
  - full rebuild runs in a separate worker process (`scripts/rebuild-search-index.js`) to keep API responsive.
- Frontend behavior:
  - desktop search input in navbar + mobile search button;
  - results shown in modal with skeleton on first page;
  - page-aware browser cache (`query + rounded center + cursor`, TTL ~5 min).

## Environment Variables

- `PORT` - server port.
- `SESSION_SECRET` - session secret.
- `REDIS_URL` - Redis connection URL for sessions (default: `redis://redis:6379`).
- `MAP_DEFAULT_LON` - default map center longitude (used when URL hash has no `#map=...`).
- `MAP_DEFAULT_LAT` - default map center latitude (used when URL hash has no `#map=...`).
- `MAP_DEFAULT_ZOOM` - default map zoom (used when URL hash has no `#map=...`).
- `ADMIN_USERNAME` - admin login.
- `ADMIN_PASSWORD` - admin password.
- `GEOFABRIK_PBF_URL` - Geofabrik PBF URL.
- `GEOFABRIK_DOWNLOAD_DIR` - local directory for downloaded PBF.
- `CITY_FILTER_BBOXES` - optional city bbox list:
  `minLon,minLat,maxLon,maxLat;minLon,minLat,maxLon,maxLat`.
- `FORCE_DOWNLOAD` - force redownload even if local file is up to date.
- `PBF_PROGRESS_EVERY` - importer progress print interval.
- `PBF_PROGRESS_COUNT_PASS` - enable count pass for percentage/ETA.
- `AUTO_SYNC_ENABLED` - enable/disable auto sync (`true/false`).
- `AUTO_SYNC_ON_START` - run sync automatically on server startup (`true/false`).
- `AUTO_SYNC_INTERVAL_HOURS` - periodic sync interval in hours (`<=0` disables periodic sync).
- `SEARCH_INDEX_BATCH_SIZE` - FTS rebuild batch size for progress/indexing loop (`200..20000`, default `2500`).
