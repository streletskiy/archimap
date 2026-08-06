# AGENTS.md

Entry point for AI coding agents working in this repository. Read
[CONTRIBUTING.md](CONTRIBUTING.md) before changing code. Use
[docs/README.md](docs/README.md) to find the architecture, data-flow, API, security,
testing, and deployment documentation.

## Start With the Knowledge Graph

For questions about architecture, dependencies, file ownership, or change impact, query
`graphify-out/graph.json` before searching the repository blindly:

```powershell
graphify query "Where is the OSM synchronization flow implemented?"
graphify affected "OsmSyncService"
graphify explain "OsmSyncService"
```

The graph is a generated navigation aid, not a source of truth. Confirm conclusions against
the current source and tests. See [docs/dev/graphify.md](docs/dev/graphify.md) for its scope,
tracked artifacts, and refresh workflow.

## Repository Map

- `src/lib/server/`: backend routes, services, infrastructure, and persistence.
- `src/lib/shared/`: shared domain types and helpers.
- `frontend/src/`: SvelteKit application, stores, services, and shared UI controls.
- `db/`: SQLite and PostgreSQL migrations.
- `scripts/`: operational, import, migration, validation, and generation scripts.
- `tests/`: unit and integration tests; browser tests live alongside Playwright setup.
- `docs/`: canonical architecture, API, operational, security, and development guidance.

## Non-Negotiables

- Never commit or print secrets, OAuth tokens, credentials, `.env` files, database dumps, or
  runtime data.
- Treat applied database migrations as append-only. Add a new migration instead of editing or
  reordering an existing one.
- Keep `docs/openapi.yaml` and `docs/api.md` synchronized with HTTP API changes.
- Localize user-facing text in both Russian and English, and run the i18n checks.
- Frontend product code uses shared controls from `frontend/src/lib/components/base`, Svelte
  stores for client state, and services for API access. Follow
  [docs/ui-architecture.md](docs/ui-architecture.md).
- Tag-only OSM synchronization must preserve complete existing way node lists and relation
  member lists. Structural OSM changes require an explicit guarded workflow, version checks,
  a dry run, and tests. Never construct a partial existing OSM object for upload.
- Generated files such as `src/lib/version.generated.json`,
  `frontend/src/lib/version.generated.json`, and Graphify snapshots must be regenerated, not
  hand-edited.
- Preserve unrelated user changes in a dirty worktree and avoid destructive Git operations.

## Before Publishing

Run the quality gates appropriate to the change. Before pushing a code change, the expected
full set is:

```powershell
npm run format:check
npm run lint
npm run frontend:check
npm run test
```

Run `npm run test:e2e` for UI-impacting changes. Document any unrelated pre-existing failure
instead of hiding it.

Use English Conventional Commit messages. Do not add AI attribution or `Co-Authored-By`
trailers for an AI assistant.
