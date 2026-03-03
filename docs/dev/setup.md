# Setup

## Local
1. Install deps:
   - `npm ci`
   - `npm --prefix frontend ci`
2. Prepare env:
   - copy `.env.example` -> `.env`
3. Build frontend:
   - `npm run build`
4. Start server:
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
