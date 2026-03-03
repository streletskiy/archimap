# Client Performance

## Implemented
- Lazy map runtime:
  - Map component is dynamically imported in `frontend/src/routes/+page.svelte`.
  - MapLibre + PMTiles libraries are dynamically imported inside `MapCanvas.svelte`.
- Request cancellation:
  - Search requests now use `AbortController` in `+page.svelte`.
  - BBox filter requests in map layer logic also cancel stale requests.
- Debounce:
  - Map filter reload on `moveend/zoomend` is debounced (`180ms`) in `MapCanvas.svelte`.
- Client cache:
  - `apiJsonCached` in `frontend/src/lib/services/http.js`.
  - Search and bbox responses reuse short-lived in-memory cache.
- Reduced unnecessary redraws:
  - Filter updates guarded by request token and abort semantics.
  - Theme switching keeps custom PMTiles layers and applies style repaint instead of layer drop.

## Optional lite mode (next)
- Disable clustering and detailed bbox filtering on low-end devices.
- Lower `limit` for filter bbox and map label density under performance budget flags.
