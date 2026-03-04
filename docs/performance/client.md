# Client Performance

## Implemented

- Lazy map runtime:
  - Map component is dynamically imported in `frontend/src/routes/+page.svelte`.
  - MapLibre + PMTiles libraries are dynamically imported inside `MapCanvas.svelte`.
- Request cancellation:
  - Search requests now use `AbortController` in `+page.svelte`.
  - Building filter match requests (`POST /api/buildings/filter-matches`) cancel stale requests.
- Debounce:
  - Map filter reload on `moveend/zoomend` is debounced (`180ms`) in `MapCanvas.svelte`.
  - Rule-change refresh applies optimistic state immediately and debounces authoritative fetch (default `90ms`, heavy contains rules `500ms`).
- Client cache:
  - `apiJsonCached` in `frontend/src/lib/services/http.js`.
  - Search and bbox responses reuse short-lived in-memory cache.
  - Map filter keeps a short-lived in-memory match cache for `/api/buildings/filter-matches` (`rulesHash+bboxHash+zoomBucket`), and legacy per-building cache for fallback `/api/buildings/filter-data`.
- Reduced unnecessary redraws:
  - Filter updates guarded by request token, abort semantics, and worker-built diff plans.
  - Filter highlight updates dedicated highlight layers via feature-state; base building layers are not re-filtered/hid.
  - Primary filter path is bbox server-matching (not rendered-feature enumeration), reducing request fan-out.
  - Theme switching keeps custom PMTiles layers and applies style repaint instead of layer drop.

## Optional lite mode (next)

- Disable clustering and detailed bbox filtering on low-end devices.
- Lower `limit` for filter bbox and map label density under performance budget flags.
