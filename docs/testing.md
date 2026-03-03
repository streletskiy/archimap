# Testing

## Test Matrix

- Unit:
  - service logic (edits/search/settings)
  - env validation
  - CSP generator
  - log sanitization/redaction
- Integration:
  - auth flow (register/login/logout)
  - CSRF enforcement (`403` without token on mutation)
  - admin/protected routes
  - search endpoint basic behavior
  - PMTiles `Range` request (`206`, `Content-Range`, `Accept-Ranges`)
- Smoke:
  - server startup
  - core pages and endpoints
  - minimal auth journey
- Security smoke:
  - CSP header presence
  - no `unsafe-inline`
  - no CDN references in rendered HTML

## Commands

```bash
npm run lint
npm test
npm run build
```

Detailed test commands:

```bash
npm run test:unit
npm run test:integration
npm run test:security
npm run test:smoke
npm run test:e2e
```

Dependency hygiene:

```bash
npm run depcheck
```

## Test Environment Notes

- `npm test` builds frontend first (`npm run frontend:build`) to ensure HTML routes are available.
- Integration/security tests use temporary DB files and an ephemeral PMTiles fixture.
- For local tests without Redis, set:
```bash
SESSION_ALLOW_MEMORY_FALLBACK=true
```
- Browser e2e (Playwright):
  - open `/app`
  - wait for map initialization (`.maplibregl-canvas`)
  - optional building modal open attempt
  - fail on unexpected runtime JS errors
