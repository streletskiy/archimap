# Frontend Architecture (SvelteKit)

## Current state

Legacy static frontend has been removed from runtime routes. All user-facing pages are served by a single SvelteKit application entrypoint:

- `/`
- `/info`
- `/account`
- `/admin`

## Principles

- Declarative UI composition with Svelte components.
- Reactive state via stores (`auth`, `map`, `ui`).
- Explicit API clients for backend contracts.
- Reusable map integration (MapLibre + PMTiles) encapsulated in components.

## Build and runtime

- Source: `frontend/`
- Build target: `frontend/build/` (SvelteKit static adapter, SPA fallback)
- Express serves static assets from `frontend/build` and returns `frontend/build/index.html` for app routes (`/`, `/account`, `/admin`, `/info`, `/app/*`).

## Legacy policy

Legacy `public/*.html` and imperative frontend modules are not part of active architecture and should not be restored.
