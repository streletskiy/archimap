# Contributing

## Development Setup

1. Install dependencies:
   - `npm ci`
   - `npm --prefix frontend ci`
2. Copy env template:
   - [`.env.example`](.env.example) -> `.env`
3. Run locally:
   - `npm run dev`

## Quality Gates

Before opening a PR, run:

- `npm run format:check`
- `npm run lint`
- `npm run frontend:check`
- `npm run test`
- `npm run test:e2e` for UI-impacting changes

## Frontend Guidelines (Required)

Frontend is implemented in `frontend/` with SvelteKit.

- Use shared controls from `frontend/src/lib/components/base/**` in product code.
- Do not import `frontend/src/lib/components/ui/**` directly outside the base-layer wrappers.
- Keep client state in Svelte stores (`frontend/src/lib/stores`), not in imperative DOM mutation code.
- Put API interaction logic in `frontend/src/lib/services`.
- Avoid duplicated markup/styles across routes; extract shared components.
- Keep shared visual rules in `frontend/src/app.css`; do not duplicate long repeated class chains across feature components.
- For UI work, follow [docs/ui-architecture.md](docs/ui-architecture.md).
- PRs that reintroduce legacy imperative page scripts in `public/` should be considered incomplete.

## Commit Convention

Conventional commit style is recommended:

- `feat: ...`
- `fix: ...`
- `refactor: ...`
- `docs: ...`
- `test: ...`
- `ci: ...`
- `chore: ...`

## Pull Request Checklist

- Scope is focused and clearly described.
- Tests added/updated for behavioral changes.
- Docs updated ([README](README.md), [env docs](docs/dev/env.md), [API docs](docs/api.md), [legal docs](legal/)) when needed.
- No secrets or credentials in code or logs.
