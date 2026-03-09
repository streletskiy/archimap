# Client Performance

## Implemented

- Lazy map runtime:
  - Map component is dynamically imported in `frontend/src/routes/+page.svelte`.
  - MapLibre + PMTiles libraries are dynamically imported in `frontend/src/lib/services/map-runtime.js`.
  - `MapCanvas.svelte` stays focused on render/bind concerns and delegates non-UI logic to `frontend/src/lib/services/map/**`.
- Request cancellation:
  - Search requests now use `AbortController` in `+page.svelte`.
  - Building filter match requests (`POST /api/buildings/filter-matches`) cancel stale requests through `MapFilterService`.
- Debounce:
  - Map filter reload on `moveend/zoomend` is debounced (`180ms`) in the extracted `MapFilterService`.
  - Rule-change refresh applies optimistic state immediately and debounces authoritative fetch (default `90ms`, heavy contains rules `500ms`).
- Client cache:
  - `apiJsonCached` in `frontend/src/lib/services/http.js`.
  - Search and bbox responses reuse short-lived in-memory cache.
  - Map filter keeps a short-lived in-memory match cache for `/api/buildings/filter-matches` (`rulesHash+bboxHash+zoomBucket`), and per-building cache for fallback `/api/buildings/filter-data`.
- Reduced unnecessary redraws:
  - Filter updates guarded by request token, abort semantics, and worker-built diff plans.
  - Filter highlight updates dedicated highlight layers via feature-state; base building layers are not re-filtered/hid.
  - Feature-state diff apply is chunked per animation frame to smooth map interactions under large diffs.
  - Primary filter path is bbox server-matching (not rendered-feature enumeration), reducing request fan-out.
  - Authoritative fetch uses adaptive coverage-window and skips refetch while viewport stays inside active window.
  - Optional low-priority directional prefetch warms cache without competing with main requests.
  - Theme switching keeps custom PMTiles layers and applies style repaint instead of layer drop.
  - Theme, layer, search, debug, and bbox math helpers are split into dedicated map service modules instead of living in one Svelte component.

## Filter tech note

- See [docs/performance/filter-coverage-window.md](filter-coverage-window.md) for full filter pipeline details, tunable parameters and telemetry fields.

## Optional lite mode (next)

- Disable clustering and detailed bbox filtering on low-end devices.
- Lower `limit` for filter bbox and map label density under performance budget flags.
