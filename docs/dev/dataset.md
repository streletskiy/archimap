# Dataset

## Sample dataset

- Location: `data/sample/`
- Purpose: fast local sanity checks without full city import.

## Build PMTiles locally

1. Configure OSM source in `.env`:
   - `OSM_EXTRACT_QUERY=...` or `OSM_EXTRACT_QUERIES=...`
   - or `OSM_PBF_PATH=/path/to/file.osm.pbf`
2. Run:
   - `npm run tiles:build`
3. Result:
   - PMTiles file under `data/` (default `buildings.pmtiles`).

## Search index refresh

- After major data update, rebuild index workers via existing sync flow.
- Verify:
  - `/api/contours-status`
  - `/api/search-buildings?q=<query>`
