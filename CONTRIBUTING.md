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
