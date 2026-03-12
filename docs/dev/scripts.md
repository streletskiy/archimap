# Scripts

## Core

- `npm run dev`: build frontend then run server.
- `npm run build`: production frontend build.
- `npm run start`: run server.
- `npm run lint`: backend + frontend lint.
- `npm run frontend:check`: Svelte/type-level frontend validation.
- `npm run test`: CI-like non-E2E local gate (`frontend:build` + unit + integration + syntax + security + smoke).
- [`node scripts/generate-version.js`](../../scripts/generate-version.js): generate backend/frontend build version files.
- `npm run version:print`: print generated version payload.
- `npm run format:check`: Prettier check for repo docs/config formats.

## Testing

- `npm run test:unit`
- `npm run test:integration`
- `npm run test:integration:postgres`
- `npm run test:security`
- `npm run test:smoke`
- `npm run test:e2e`
- `npm run db:pg:smoke`

## Performance / analysis

- `npm run perf:smoke`: local latency + bundle snapshot report.
- `npm run analyze`: build with bundle visualizer (`frontend/build/bundle-analysis.html`).

## Data operations

- `npm run migrate`: DB migrations.
- `npm run db:seed`: seed demo admin user into auth DB.
- `npm run admin:create-master -- --email=<email> --password=<password>`: create or promote master admin.
- `npm run tiles:build -- --region-id=<id>`: build/sync one managed region through the region pipeline.
- `python scripts/build-admin-regions-geojson.py`: rebuild the admin region coverage GeoJSON in `frontend/static/admin-regions.geojson`. Country coverage primarily follows Geofabrik extracts with Natural Earth display contours, combined extracts such as Senegal and Gambia and Israel and Palestine can use Natural Earth unions, Somalia is expanded with the Natural Earth Somaliland polygon, `guernsey-jersey` is restored through a Natural Earth Jersey + Guernsey union, Cyprus uses a Natural Earth full-island union, Kosovo uses a Natural Earth `XK` override, curated `osmfr` country coverage fills gaps such as Kuwait, Qatar, and Aland Islands, Falkland Islands are added through an explicit Geofabrik extract alias with a Natural Earth contour, US states reuse Natural Earth Admin 1 boundaries for admin-map display, Russia regions reuse Natural Earth Admin 1 boundaries while keeping `osmfr` extract ids except for Crimea where the Crimea Republic and Sevastopol Natural Earth polygons are merged into one `geofabrik` `russia/crimean-fed-district` contour, curated `osmfr` overlays add missing regions such as Lesser Antilles and Reunion, and Kazakhstan has its Baikonur gap filled for admin selection.
- `npm run admin:regions:pmtiles`: rebuild the admin region coverage archive in `frontend/static/admin-regions.pmtiles` from `frontend/static/admin-regions.geojson` using local `tippecanoe` when available, otherwise a Dockerized runtime-base fallback. The command also writes `frontend/static/admin-regions.pmtiles.meta.json` with the GeoJSON hash used for freshness checks.
- `node scripts/ensure-admin-regions-pmtiles.js`: verify the served admin coverage archive under `frontend/build/client/` and rebuild it only if the committed metadata/hash says the archive is stale or missing.
- `npm run sync:city -- --region-id=<id>`: compatibility wrapper around managed region sync.
- `node scripts/sync-osm-region.js --region-id=<id>`: direct managed region sync orchestrator.
- `node scripts/sync-osm-region.js --region-id=<id> --pmtiles-only`: rebuild PMTiles from already imported DB rows.

Notes:

- `scripts/sync-osm-region.js` is intentionally thin; implementation stages now live in `scripts/region-sync/python-extractor.js`, `db-ingester.js`, `region-db.js`, `import-applier.js`, and `pmtiles-builder.js`.
- Docker containers start through `scripts/runtime-start.js`, which runs `scripts/ensure-admin-regions-pmtiles.js` before booting `server.sveltekit.js`.
- `npm test` does not run Playwright; use `npm run test:e2e` separately when finalizing UI-impacting changes.
