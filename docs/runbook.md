# Runbook

## Local Dev

1. Install dependencies:
```bash
npm install
```
2. Copy `.env.example` to `.env` and set at least:
```bash
SESSION_SECRET=...
APP_BASE_URL=http://localhost:3252
SESSION_ALLOW_MEMORY_FALLBACK=true
BOOTSTRAP_ADMIN_ENABLED=true
```
3. Start app:
```bash
npm start
```

## Docker

1. Prepare `.env`.
2. Start:
```bash
docker compose up -d
```
3. Check readiness:
```bash
curl http://localhost:3252/readyz
```

## Safe First Admin Creation

Recommended production sequence:

1. Keep `BOOTSTRAP_ADMIN_ENABLED=false` by default.
2. For one-time bootstrap, temporarily set:
```bash
BOOTSTRAP_ADMIN_ENABLED=true
BOOTSTRAP_ADMIN_SECRET=<one-time-secret>
BOOTSTRAP_ADMIN_ALLOWED_IPS=<admin-ip-only>
```
3. Call registration endpoint with header `x-bootstrap-admin-secret`.
4. Verify admin user exists.
5. Immediately set `BOOTSTRAP_ADMIN_ENABLED=false` and restart.

## Common Issues

### CSP blocks map resources

- Inspect browser CSP violation logs.
- Add only required origins via `CSP_CONNECT_SRC_EXTRA`.
- Re-run:
```bash
npm run test:security
```

### Sessions do not persist locally

- For local HTTP, set:
```bash
SESSION_COOKIE_SECURE=false
```

### Redis unavailable in production

- Keep `SESSION_ALLOW_MEMORY_FALLBACK=false`.
- Restore Redis; do not switch to memory sessions in production.
