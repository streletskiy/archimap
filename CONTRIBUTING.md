# Contributing

## Development Setup

1. Install dependencies:
   - `npm install`
2. Copy env template:
   - `.env.example` -> `.env`
3. Run locally:
   - `npm start`

## Quality Gates

Before opening a PR, run:

- `npm run format:check`
- `npm run lint`
- `npm test`

## Frontend Guidelines (Required)

Frontend is implemented in `frontend/` with SvelteKit.

- Use reusable Svelte components from `frontend/src/lib/components`.
- Keep client state in Svelte stores (`frontend/src/lib/stores`), not in imperative DOM mutation code.
- Put API interaction logic in `frontend/src/lib/services`.
- Avoid duplicated markup/styles across routes; extract shared components.
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
- Docs updated (`README`, env docs, API docs, `legal/*.md`) when needed.
- No secrets or credentials in code or logs.
