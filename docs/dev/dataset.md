# Dataset

## Sample dataset

- Location: `data/sample/`
- Purpose: fast local sanity checks without full city import.

## Build PMTiles locally

1. Create and sync a region in `Admin -> Data`.
2. For CLI-only maintenance, run:
   - `npm run tiles:build -- --region-id=<id>`
3. Result:
   - Region PMTiles file under `data/regions/buildings-region-<slug>.pmtiles`.

## Search index refresh

- After major data update, rebuild index workers via existing sync flow.
- Verify:
  - `/api/contours-status`
  - `/api/search-buildings?q=<query>`
