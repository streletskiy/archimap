# Scripts

## Core

- `npm run dev`: build frontend then run server.
- `npm run frontend:dev`: run the frontend Vite dev server only. It first regenerates `frontend/svelte.config.js` from `frontend/src/bootstrap/svelte.config.ts` and `frontend/static/theme-init.js` from `frontend/src/theme-init.ts`.
- `npm run build`: production frontend build.
- `npm run frontend:build`: production frontend build only. It first regenerates `frontend/svelte.config.js` from `frontend/src/bootstrap/svelte.config.ts` and `frontend/static/theme-init.js` from `frontend/src/theme-init.ts`.
- `npm run start`: run server.
- `npm run lint`: backend + frontend lint.
- `npm run frontend:lint`: frontend ESLint only.
- `npm run frontend:check`: Svelte/type-level frontend validation. It uses the generated `frontend/svelte.config.js` so the SvelteKit config loads natively.
- `npm run frontend:preview`: preview the built frontend locally. It first regenerates `frontend/svelte.config.js` from `frontend/src/bootstrap/svelte.config.ts` and `frontend/static/theme-init.js` from `frontend/src/theme-init.ts`.
- `npm run test`: CI-like non-E2E local gate (`frontend:build` + unit + integration + syntax + security + smoke).
- [`node --import tsx scripts/generate-version.ts`](../../scripts/generate-version.ts): generate backend/frontend build version files.
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
- `node --import tsx scripts/ensure-admin-regions-pmtiles.ts`: verify the served admin coverage archive under `frontend/build/client/` and rebuild it only if the committed metadata/hash says the archive is stale or missing.
- `npm run sync:city -- --region-id=<id>`: compatibility wrapper around managed region sync.
- `node --import tsx scripts/sync-osm-region.ts --region-id=<id>`: direct managed region sync orchestrator.
- `node --import tsx scripts/sync-osm-region.ts --region-id=<id> --pmtiles-only`: rebuild PMTiles from already imported DB rows.

Notes:

- `scripts/sync-osm-region.ts` is intentionally thin; implementation stages live in `scripts/region-sync/python-extractor.ts`, `db-ingester.ts`, `region-db.ts`, `import-applier.ts`, and `pmtiles-builder.ts`.
- `frontend/src/bootstrap/svelte.config.ts` is the source of truth for the frontend SvelteKit config. The generated `frontend/svelte.config.js` is produced by frontend `generate:bootstrap`; do not edit the generated file directly.
- `frontend/src/theme-init.ts` is the source of truth for the initial theme bootstrap. The generated `frontend/static/theme-init.js` is produced by frontend `generate:bootstrap`; do not edit the generated file directly.
- Docker containers start through `scripts/runtime-start.ts`, which runs `scripts/ensure-admin-regions-pmtiles.ts` before booting `server.sveltekit.ts`.
- `npm test` does not run Playwright; use `npm run test:e2e` separately when finalizing UI-impacting changes.
- For shared UI work, `npm run frontend:check`, `npm run frontend:build`, and `npm run test:e2e` are the minimum practical frontend contour.
