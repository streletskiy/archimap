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

## Environment Variables

- `PORT` - server port.
- `SESSION_SECRET` - session secret.
- `REDIS_URL` - Redis connection URL for sessions (default: `redis://redis:6379`).
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
