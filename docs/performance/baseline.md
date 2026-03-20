# Baseline and Result

## Test environment

- Date: 2026-03-03
- Host: local Windows dev machine
- Node: v20.17.0
- Command: `npm run perf:smoke`
- Server mode: `NODE_ENV=test`, autosync disabled, temporary DB files

## Before (Stage 3 start)

- Endpoint latency (ms):
  - `/readyz`: p50 `1.14`, p95 `2.62`
  - `/api/contours-status`: p50 `257.82`, p95 `286.56`
  - `/api/search-buildings`: p50 `1.62`, p95 `2.30`
  - `/api/buildings/filter-data-bbox`: p50 `16.60`, p95 `23.73`
- Frontend bundle (vite output):
  - Largest chunk: `929.62 kB` (gzip `253.67 kB`)
- Browser timing snapshot for `/app`:
  - Historical value was not captured before this stage (gap from earlier instrumentation).

## After (Stage 3 changes)

- Endpoint latency (ms):
  - `/readyz`: p50 `1.10`, p95 `1.63`
  - `/api/contours-status`: p50 `199.12`, p95 `218.95`
  - `/api/search-buildings`: p50 `0.72`, p95 `1.40`
  - `/api/buildings/filter-data-bbox`: p50 `7.69`, p95 `11.99`
- Bundle (from `npm run perf:smoke`):
  - Total chunks: `1073.49 kB`
  - Largest chunk: `893.57 kB` (`_app/immutable/chunks/BsfhqxLh.js`)
- Browser timing snapshot (`Playwright + Performance API`, `/app`):
  - `domContentLoaded`: `274.4 ms`
  - `loadEventEnd`: `274.6 ms`
  - `first-contentful-paint`: `384.0 ms`

## Delta summary

- Search improved (p50 ~56% faster).
- BBox filter improved (p50 ~54% faster, p95 ~49% faster).
- Contours status improved (~23% faster p50) but remains DB aggregate sensitive.
- Largest frontend chunk reduced and remains above the 500k warning threshold.
