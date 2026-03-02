# Frontend (SvelteKit)

This folder contains the reactive frontend migration target for Archimap.

## Commands

- `npm install` (inside `frontend/`)
- `npm run dev` - local Svelte dev server
- `npm run build` - outputs static app into `../public/app`
- `npm run preview` - preview built Svelte app

## Integration

The Node backend serves this app as the primary frontend entrypoint:

- `/`
- `/info`
- `/account`
- `/admin`

Legacy `public/*.html` and legacy frontend modules are removed from runtime.
