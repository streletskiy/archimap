# Filter Coverage Window and Prefetch

## Goal

Keep filter highlight stable during active panning and reduce repeated `POST /api/buildings/filter-matches` calls for short map moves.

## Pipeline

1. Filter input is prepared in worker (`build-request-plan`) and resolved highlight payloads are composed in worker (`build-resolved-payload`).
2. For each viewport, client builds a coverage window (expanded bbox).
3. Authoritative request is made for coverage window, not exact viewport bbox.
4. While viewport remains fully inside active coverage window:
   - no new authoritative request is sent;
   - existing highlight is reused (superset of viewport is allowed).
   - render mode must also stay the same; zoom changes across the low-zoom marker fallback threshold force a fresh apply even if the coverage window itself is still reusable.
5. If viewport exits active window, a new window is requested.

## Cache keys

- Match cache key:
  - `rulesHash:coverageHash:zoomBucket:renderMode`
  - `coverageHash` is built from expanded bbox (`buildBboxHash`).
- Render mode is part of the client-side reuse boundary:
  - contour and marker fallback payloads are cached separately, so the low-zoom marker path does not reuse a contour payload;
  - marker fallback uses a larger `maxResults` budget on lower zooms so clustered circles do not hit the truncation cap too early;
  - marker fallback uses search-like clustering plus a tiny deterministic point jitter so low-zoom circles do not stack on top of each other or disappear during zoom transitions.
  - below zoom `5`, marker-mode requests also let the backend aggregate matches into viewport-relative cells so the client never needs the full building list for the densest views.
- TTL and limits are unchanged:
  - match cache: `8s`, max `90`
  - fallback data cache: `45s`, max `25k`, request chunk `5k`

## Coverage margin

- Dynamic margin range: `20%..35%` from viewport width/height.
- Margin adapts by last match count:
  - low match count -> larger window;
  - high match count -> smaller window.

## Highlight apply

- The current contour path uses dedicated highlight layers with `match` expressions for membership and color. MapLibre compiles membership into a lookup table rather than scanning an ID array for every feature.
- Reapplying equal groups skips unchanged paint work; recreating a style forces repaint.
- `latestFilterToken` rejects stale request and worker results, including results that arrive after a clear.
- Identical pending applies share their request. URL replay retains layer IDs, preserving client and server cache reuse.
- Contour requests use `includeLocations=false`; marker requests retain coordinates. Both endpoints compress responses off the server event loop.

### Dense-filter measurement (2026-10-30)

The Nizhny Novgorod levels filter at `56.319684, 44.004552`, zoom `13.59`,
returned 6,976 matches at a 1440×900 viewport. In the installed MapLibre expression
engine, evaluating those keys and an equal number of non-matches four times
(55,808 evaluations) took 300 ms with `in` and 9 ms with `match`; compilation
took 1 ms and 2 ms respectively. Both returned the same 27,904 positive results.
This is an isolated membership benchmark, not a claim about total page-load time.

The 0.8.4 browser trace also recorded three repeated batch requests on one deep-link
load, each carrying about 890 KB of uncompressed JSON including unused marker
coordinates. Pending-request coalescing and contour-only payloads address those
separate network costs.

## Prefetch

- Optional low-priority prefetch of neighbor window.
- Direction: based on last pan vector.
- Throttled: at most once per `900ms`.
- Prefetch is cancelled immediately when a new main request starts.
- Prefetch never applies state directly; it only warms match cache.

## UX

- Apply model stays local-first (`FilterPanel` drafts -> `setBuildingFilterLayers`), and shareable URLs can restore the same camera + filter stack through query params.
- Filter panel shows runtime status and stats:
  - status (`Applied`, `Refining`, `Too many matches`, etc.)
  - count
  - elapsed ms
- The centered map apply loader is quiet on contour zooms (`z13+`) and only becomes prominent for low-zoom marker fallback, where the loader is actually useful.
- Degrade mode (`>20k matches`) keeps the existing highlight and shows a clear action hint, without forced hard reset.

## Dev/Test telemetry

Enabled only in `DEV`/`test`.

`window.__MAP_DEBUG__.filterTelemetry` includes:

- request lifecycle (`request_start`, `request_finish`, `request_abort`)
- prefetch lifecycle (`prefetch_start`, `prefetch_finish`, `prefetch_abort`)
- apply lifecycle (`apply_plan_start`, `apply_plan_finish`, `apply_plan_cancelled`)
- timing fields, including moveend-to-apply delay
- counters for reset/clear events and setFeatureState activity
