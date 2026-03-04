# Scripts

## Core

- `npm run dev`: build frontend then run server.
- `npm run build`: production frontend build.
- `npm run start`: run server.
- `npm run lint`: backend + frontend lint.
- `npm run test`: full CI-like local suite.
- [`node scripts/generate-version.js`](../../scripts/generate-version.js): generate backend/frontend build version files.
- `npm run version:print`: print generated version payload.

## Testing

- `npm run test:unit`
- `npm run test:integration`
- `npm run test:security`
- `npm run test:smoke`
- `npm run test:e2e`

## Performance / analysis

- `npm run perf:smoke`: local latency + bundle snapshot report.
- `npm run analyze`: build with bundle visualizer (`frontend/build/bundle-analysis.html`).

## Data operations

- `npm run migrate`: DB migrations.
- `npm run db:seed`: seed demo admin user into auth DB.
- `npm run admin:create-master -- --email=<email> --password=<password>`: create or promote master admin.
- `npm run tiles:build`: run PMTiles build pipeline ([`scripts/sync-osm-buildings.js`](../../scripts/sync-osm-buildings.js)).
- `npm run sync:city`: OSM sync/import pipeline.
