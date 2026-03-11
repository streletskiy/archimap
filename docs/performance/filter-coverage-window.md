# Filter Coverage Window and Prefetch

## Goal

Keep filter highlight stable during active panning and reduce repeated `POST /api/buildings/filter-matches` calls for short map moves.

## Pipeline

1. Filter input is still prepared in worker (`prepare-rules`) and diff plans are built in worker (`build-apply-plan`).
2. For each viewport, client builds a coverage window (expanded bbox).
3. Authoritative request is made for coverage window, not exact viewport bbox.
4. While viewport remains fully inside active coverage window:
   - no new authoritative request is sent;
   - existing highlight is reused (superset of viewport is allowed).
5. If viewport exits active window, a new window is requested.

## Cache keys

- Match cache key:
  - `rulesHash:coverageHash:zoomBucket`
  - `coverageHash` is built from expanded bbox (`buildBboxHash`).
- TTL and limits are unchanged:
  - match cache: `8s`, max `90`
  - fallback data cache: `45s`, max `25k`, request chunk `5k`

## Coverage margin

- Dynamic margin range: `20%..35%` from viewport width/height.
- Margin adapts by last match count:
  - low match count -> larger window;
  - high match count -> smaller window.

## Chunked feature-state apply

- Diff (`toDisable`, `toEnable`) is applied in chunks (`requestAnimationFrame`) to avoid long main-thread stalls.
- Default chunk size: `540`.
- For dense diffs (`toEnable + toDisable >= 1200`) a burst mode increases per-frame budget (`~8.5ms`) to reduce first visible update latency.
- Dense burst can be toggled for profiling with URL param: `?filterDenseBurst=0|1`.
- Each frame checks `latestFilterToken`; stale apply is cancelled early.
- On cancellation, local tracked feature-state set is kept consistent with already applied partial changes.

## Prefetch

- Optional low-priority prefetch of neighbor window.
- Direction: based on last pan vector.
- Throttled: at most once per `900ms`.
- Prefetch is cancelled immediately when a new main request starts.
- Prefetch never applies state directly; it only warms match cache.

## UX

- Apply model stays local-first (`FilterPanel` drafts -> `setBuildingFilterLayers`), and shareable URLs can restore the same camera + filter stack through query params.
- Filter panel now shows runtime status and stats:
  - status (`Applied`, `Refining`, `Too many matches`, etc.)
  - count
  - elapsed ms
- Degrade mode (`>20k matches`) keeps current highlight and shows clear action hint, without forced hard reset.

## Dev/Test telemetry

Enabled only in `DEV`/`test`.

`window.__MAP_DEBUG__.filterTelemetry` includes:

- request lifecycle (`request_start`, `request_finish`, `request_abort`)
- prefetch lifecycle (`prefetch_start`, `prefetch_finish`, `prefetch_abort`)
- apply lifecycle (`apply_plan_start`, `apply_plan_finish`, `apply_plan_cancelled`)
- timing fields, including moveend-to-apply delay
- counters for reset/clear events and setFeatureState activity
