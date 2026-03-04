# Client Performance

## Implemented

- Lazy map runtime:
  - Map component is dynamically imported in `frontend/src/routes/+page.svelte`.
  - MapLibre + PMTiles libraries are dynamically imported inside `MapCanvas.svelte`.
- Request cancellation:
  - Search requests now use `AbortController` in `+page.svelte`.
  - Building filter data requests (`POST /api/buildings/filter-data`) cancel stale requests.
- Debounce:
  - Map filter reload on `moveend/zoomend` is debounced (`180ms`) in `MapCanvas.svelte`.
  - Rule-change refresh for building filter is additionally debounced (`110ms`) to avoid noisy `setFeatureState`/network requests while typing.
- Client cache:
  - `apiJsonCached` in `frontend/src/lib/services/http.js`.
  - Search and bbox responses reuse short-lived in-memory cache.
  - Map filter keeps a short-lived in-memory per-building cache for `/api/buildings/filter-data` payloads (`osmKey -> sourceTags`), reducing repeated POST bursts.
- Reduced unnecessary redraws:
  - Filter updates guarded by request token and abort semantics.
  - Filter highlight updates dedicated highlight layers via feature-state; base building layers are not re-filtered/hid.
  - Filter requests are chunked by visible/loaded map features (large chunks) to reduce request count and avoid rate-limit noise.
  - Theme switching keeps custom PMTiles layers and applies style repaint instead of layer drop.

## Optional lite mode (next)

- Disable clustering and detailed bbox filtering on low-end devices.
- Lower `limit` for filter bbox and map label density under performance budget flags.
