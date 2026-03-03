# Security Guide

## CSP

- CSP is generated in [`src/lib/server/infra/csp.infra.js`](/e:/Projects/Self/archimap/src/lib/server/infra/csp.infra.js) and applied centrally by [`src/lib/server/infra/security-headers.infra.js`](/e:/Projects/Self/archimap/src/lib/server/infra/security-headers.infra.js).
- Profiles:
  - `production`: strict, no `unsafe-inline` in `script-src` and `style-src`.
  - `development`/`test`: keeps `style-src 'self'`, allows `unsafe-eval` only for tooling compatibility.
- Current baseline directives:
  - `default-src 'self'`
  - `script-src 'self'` (prod)
  - `style-src 'self'`
  - `style-src-attr 'unsafe-inline'` (required for MapLibre runtime style attributes)
  - `img-src 'self' data: blob: ...extraOrigins`
  - `font-src 'self' data: ...extraOrigins`
  - `connect-src 'self' ...extraOrigins`
  - `worker-src 'self' blob:`
  - `object-src 'none'`
  - `base-uri 'self'`
  - `frame-ancestors 'none'`
  - `form-action 'self'`
- Optional external origins are passed via `CSP_CONNECT_SRC_EXTRA` (comma-separated), defaulting to Carto basemap origin.

## Security Headers

Centralized in `src/lib/server/infra/security-headers.infra.js`:

- `Content-Security-Policy`
- `X-Content-Type-Options: nosniff`
- `X-Frame-Options: DENY`
- `Referrer-Policy: strict-origin-when-cross-origin`
- `Permissions-Policy: camera=(), geolocation=(), microphone=(), payment=(), usb=()`
- `Strict-Transport-Security` only in production over secure transport.

## Logging Redaction

- URL logging strips query string via [`sanitizeUrl`](/e:/Projects/Self/archimap/src/lib/shared/log-sanitizer.js).
- Sensitive fields are masked by [`maskSensitive`](/e:/Projects/Self/archimap/src/lib/shared/log-sanitizer.js):
  - `token`, `password`, `secret`, `email`, `session`, `csrf`, `authorization`, `cookie`, `set-cookie`.
- Request logs are emitted in `src/lib/server/infra/observability.infra.js`; logger-level redaction is enforced in `src/lib/server/services/logger.service.js`.

## Bootstrap Admin Hardening

- First-admin bootstrap path (`/api/register/start` when DB has zero users) is controlled by:
  - `BOOTSTRAP_ADMIN_ENABLED`
  - `BOOTSTRAP_ADMIN_SECRET`
  - `BOOTSTRAP_ADMIN_ALLOWED_IPS`
- In production:
  - bootstrap must stay disabled by default;
  - if enabled explicitly, a secret is mandatory and IP allowlist should be restricted.

## Verification

- Unit tests:
  - `tests/services/csp.infra.test.js`
  - `tests/services/log-sanitizer.service.test.js`
  - `tests/services/env.infra.test.js`
- Integration checks:
  - `tests/integration/api.integration.test.js`
  - `scripts/check-csp-security.js` (`npm run test:security`)
