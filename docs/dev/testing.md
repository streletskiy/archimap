# Testing

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

## E2E
- `npm run test:e2e`
- Playwright smoke:
  - opens `/app`
  - waits for map canvas
  - checks runtime console/page errors

## Security + smoke checks
- `npm run test:security` (CSP/no-CDN/header checks)
- `npm run test:smoke` (high-level API + auth flow sanity)
