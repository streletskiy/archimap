# Security

## CSP
- Implemented in `src/lib/server/infra/csp.infra.js`, applied via `security-headers.infra.js`.
- Prod profile:
  - `default-src 'self'`
  - `script-src 'self'` (no `unsafe-inline`)
  - `style-src 'self'`
  - `style-src-attr 'unsafe-inline'`
  - `img-src 'self' data: blob: <extra-origins>`
  - `font-src 'self' data: <extra-origins>`
  - `connect-src 'self' <extra-origins>`
  - `object-src 'none'`
  - `base-uri 'self'`
  - `frame-ancestors 'none'`
  - `form-action 'self'`
  - `worker-src 'self' blob:` (required for MapLibre worker compatibility)
- Dev profile allows local tooling/HMR websocket origins.

## Security headers
- `X-Content-Type-Options: nosniff`
- `Referrer-Policy: strict-origin-when-cross-origin`
- `X-Frame-Options: DENY`
- `Permissions-Policy: camera=(), geolocation=(), microphone=(), payment=(), usb=()`
- `Strict-Transport-Security` enabled for HTTPS production deployments.

## Cookies/session
- `httpOnly=true`
- `sameSite=lax`
- `secure=true` in production by default (override only for local HTTP via `SESSION_COOKIE_SECURE=false`).

## CSRF
- Mutating routes require `x-csrf-token`.
- Token is session-bound and validated by `requireCsrfSession`.
- Integration coverage includes negative path (`mutation without CSRF -> 403`).

## Logging and redaction
- Logger: `src/lib/server/services/logger.service.js`.
- URL sanitization: query values stripped (`sanitizeUrl`).
- Sensitive fields masked (`maskSensitive`): tokens, passwords, csrf, cookies, auth headers.

## Bootstrap admin
- Production default: `BOOTSTRAP_ADMIN_ENABLED=false`.
- Optional hardening:
  - `BOOTSTRAP_ADMIN_SECRET`
  - `BOOTSTRAP_ADMIN_ALLOWED_IPS`
- Runbook procedure documented in `docs/runbook.md`.
