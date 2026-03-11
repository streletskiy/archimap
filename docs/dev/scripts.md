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
- `npm run admin:regions:pmtiles`: rebuild the admin region coverage archive in `frontend/static/admin-regions.pmtiles` from `frontend/static/admin-regions.geojson` through Dockerized `tippecanoe`.
- `npm run sync:city -- --region-id=<id>`: compatibility wrapper around managed region sync.
- `node scripts/sync-osm-region.js --region-id=<id>`: direct managed region sync orchestrator.
- `node scripts/sync-osm-region.js --region-id=<id> --pmtiles-only`: rebuild PMTiles from already imported DB rows.

Notes:

- `scripts/sync-osm-region.js` is intentionally thin; implementation stages now live in `scripts/region-sync/python-extractor.js`, `db-ingester.js`, `region-db.js`, `import-applier.js`, and `pmtiles-builder.js`.
- `npm test` does not run Playwright; use `npm run test:e2e` separately when finalizing UI-impacting changes.
