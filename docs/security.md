# Security

## CSP

- Implemented in two runtime layers:
  - internal app/API runtime: `src/lib/server/infra/csp.infra.js`, applied via `security-headers.infra.js`
  - SvelteKit-rendered pages: `frontend/src/hooks.server.ts`
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

- Applied by both the internal app runtime and the SvelteKit hook.
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

- CSRF is enforced on session-authenticated mutating routes such as:
  - `POST /api/logout`
  - `POST /api/account/*`
  - `POST /api/building-info`
  - `POST /api/admin/**`
- Token is session-bound and validated by `requireCsrfSession`.
- Login/registration/password-reset flows do not require CSRF; they rely on rate limits, session rotation, and one-time email tokens.
- Integration coverage includes negative path (`mutation without CSRF -> 403`).

## Logging and redaction

- Logger: `src/lib/server/services/logger.service.js`.
- URL sanitization: query values stripped (`sanitizeUrl`).
- Sensitive fields masked (`maskSensitive`): tokens, passwords, csrf, cookies, auth headers.

## Master admin provisioning

- First master admin is created by explicit CLI command.
- Recommended command:
  - `npm run admin:create-master -- --email=admin@example.com --password=<strong-password>`
- The command can also promote an existing user to `is_admin=1` and `is_master_admin=1`.
- Operational procedure is documented in [docs/runbook.md](runbook.md).
