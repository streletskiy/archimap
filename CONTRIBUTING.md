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

## UI Kit Reuse (Required)

When changing or adding frontend UI, reuse shared UI primitives from `public/shared/ui.js`.

- Use `ArchiMapUI.tabButtonClass(active)` for tabs.
- Use `ArchiMapUI.fieldClass(kind, size?)` for inputs/selects/textarea.
- Use `ArchiMapUI.buttonClass(variant, size?)` for buttons.
- Use shared classes from `public/styles.css` (`ui-*`) instead of creating one-off utility combinations.
- If a needed visual pattern does not exist, extend UI kit first (`ui.js` + `styles.css`) and then consume it in pages/modules.
- Avoid duplicating similar Tailwind class strings across pages (this is treated as UI “ai slop” and should be refactored).
- PRs that introduce new manual UI patterns without UI kit reuse should be considered incomplete.

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
