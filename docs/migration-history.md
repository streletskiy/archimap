# Migration History

## Stage 1: SvelteKit migration
- UI moved to SvelteKit-based frontend.
- Legacy static frontend artifacts moved under `legacy/`.
- Unified app shell and route handling for `/`, `/app`, `/admin`, `/account`, `/info`.

## Stage 2: Security hardening
- Strict CSP profiles (dev/prod), no `unsafe-inline` in prod for script/style.
- Centralized security headers middleware.
- URL/log sanitization and sensitive field redaction.
- CSRF checks and session hardening validated by tests/CI.

## Stage 3: Performance and DX
- Added HTTP cache validators (`ETag`, `Last-Modified`) for key GET routes.
- Added PMTiles streaming byte-range implementation with validators.
- Added server/client caches, debounce, and request cancellation.
- Added bundle analysis pipeline and perf smoke script.
- Standardized docs structure and trimmed README for fast onboarding.
