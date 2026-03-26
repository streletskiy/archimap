# Setup

## Local

1. Install deps:
   - use Node.js 24 LTS
   - `npm ci`
   - `npm --prefix frontend ci`
2. Prepare env:
   - copy [`.env.example`](../../.env.example) -> `.env`
3. Start dev runtime:
   - `npm run dev`
4. Optional production-like local run:
   - `npm run build`
   - `npm run start`
5. Recommended verification after changes:
   - `npm run lint`
   - `npm run typecheck`
   - `npm run frontend:check`
   - `npm run frontend:build` for frontend-only or shared UI changes
   - `npm test`
   - `npm run test:e2e` for UI-impacting changes
   - `npm run test:integration:postgres` when validating PostgreSQL-specific behavior with `DATABASE_URL`

   Frontend bootstrap note:
   - `frontend/src/bootstrap/svelte.config.ts` is compiled into `frontend/svelte.config.js` by the frontend `generate:bootstrap` step.
   - `frontend/src/theme-init.ts` is compiled into `frontend/static/theme-init.js` by the frontend `generate:bootstrap` step.

For frontend work, read [UI Architecture](../ui-architecture.md) before changing shared controls, app-level styling, dialogs, filters, or route shells.

## Development loop

- Backend + built frontend:
  - `npm run dev`
- Frontend only (Vite):
  - `npm run frontend:dev`

## Docker

- Build and run:
  - `docker compose up --build`
- Ensure `SESSION_COOKIE_SECURE=false` for plain HTTP local docker.
- If Redis is not available locally:
  - set `SESSION_ALLOW_MEMORY_FALLBACK=true`.
