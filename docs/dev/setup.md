# Setup

## Local

1. Install deps:
   - `npm ci`
   - `npm --prefix frontend ci`
2. Prepare env:
   - copy [`.env.example`](../../.env.example) -> `.env`
3. Start dev runtime:
   - `npm run dev`
4. Optional production-like local run:
   - `npm run build`
   - `npm run start`

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
