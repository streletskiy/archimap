# Graphify Knowledge Graph

Graphify turns the backend TypeScript source into a navigable dependency graph. It is useful
for locating an implementation, tracing call paths, estimating change impact, and onboarding
without loading the entire repository into an AI agent's context.

The committed graph is generated from `src/`. It complements the hand-written documentation;
it does not replace source inspection, tests, or the contracts in `docs/`.

## Using the Graph

Run commands from the repository root:

```powershell
graphify query "How does an approved building edit reach OpenStreetMap?"
graphify explain "OsmSyncService"
graphify affected "OsmSyncService" --depth 3
graphify path "AdminRoute" "OsmSyncService"
```

Open `graphify-out/graph.html` in a browser for interactive exploration. Query answers and
community names are navigation hints; verify important conclusions in the current source.

## Refreshing the Snapshot

For normal source changes, use the repository wrapper:

```powershell
npm run graphify:update
```

It updates the `src` code graph and copies only the portable review artifacts into the tracked
root snapshot. The CLI's working output under `src/graphify-out/` remains local and ignored.
Review the reported node and edge changes, then inspect the Git diff.

If Graphify is not installed yet, install its CLI first and make sure `graphify` is available on
`PATH`. For direct experimentation that should not change the committed snapshot, run:

```powershell
graphify update src
```

Regenerate the graph after architectural changes, new backend modules, or substantial changes
to dependencies and call paths. Do not hand-edit generated Graphify files.

## Version-Control Policy

The repository keeps only artifacts that are useful and portable across machines:

| Tracked artifact                     | Purpose                                                     |
| ------------------------------------ | ----------------------------------------------------------- |
| `graphify-out/graph.json`            | Machine-readable knowledge graph used by queries and agents |
| `graphify-out/graph.html`            | Interactive visualization                                   |
| `graphify-out/GRAPH_REPORT.md`       | Human-readable graph summary and health report              |
| `graphify-out/.graphify_labels.json` | Stable community labels                                     |

The following stay local and are ignored:

- interpreter and workspace markers such as `.graphify_python` and `.graphify_root`;
- extraction intermediates named `.graphify_*.json`, except the labels file above;
- `cache/`, `.vocab.txt`, manifests, cost accounting, and temporary analysis state;
- `memory/` and `reflections/`, because they may contain task-specific questions, answers, or
  local working context;
- Graphify output directories accidentally created below the repository root.

Before committing a refreshed snapshot, check the tracked artifacts for credentials, private
URLs, absolute local paths, or task-specific context. A knowledge graph can expose names and
relationships from its input even when the original source file is ignored later.
