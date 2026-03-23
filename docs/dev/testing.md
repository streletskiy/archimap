# Testing

## Recommended final gate

- `npm run lint`
- `npm run typecheck`
- `npm run frontend:check`
- `npm test`
- `npm run test:e2e`

Notes:

- `npm test` is the main non-E2E gate: it runs frontend build, unit, integration, syntax, security, and smoke checks.
- PostgreSQL-specific integration coverage inside `npm run test:integration` is skipped automatically when `DATABASE_URL` is not set.
- `npm run test:integration:postgres` is the explicit full PostgreSQL/PostGIS gate and requires a working `DATABASE_URL`.

## Unit

- `npm run test:unit`
- Covers:
  - env validation
  - CSP generation
  - logging sanitization/masking
  - ETag/range helpers
  - service-level behavior

## Integration

- `npm run test:integration`
- Boots real server with temp DBs and verifies:
  - auth/bootstrap + CSRF
  - admin access control
  - search endpoint
  - PMTiles range and cache validators

- `npm run test:integration:postgres` (requires `DATABASE_URL`)
- Verifies PostgreSQL schema migration + PostGIS smoke geometry checks.
- Includes runtime auth/admin flow and assertion that sqlite files are not created in `DB_PROVIDER=postgres` mode.

## E2E

- `npm run test:e2e`
- Playwright smoke:
  - opens `/app`
  - waits for map canvas
  - checks runtime console/page errors
  - verifies legal/info deep links
  - verifies language switch updates visible UI strings
  - verifies map camera/deep-link preservation across navigation
  - verifies filter highlight pipeline behavior and request throttling

## i18n checks

- `npm run i18n:extract` - outputs translation keys used in frontend code.
- `npm run i18n:validate` - validates locale key consistency (missing/extra keys).
- `npm run i18n:check` - static check for potential hardcoded UI strings outside i18n.

## Security + smoke checks

- `npm run test:security` (CSP/no-CDN/header checks)
- `npm run test:smoke` (high-level API + auth flow sanity)
- `npm run db:pg:smoke` (PostgreSQL/PostGIS direct smoke)
