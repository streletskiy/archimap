# Changelog

## v0.10.2

### ⚡ Performance

- **Regional PMTiles Regeneration:** Export intermediate GeoJSON to private local scratch storage and stream it into the Planetiler container. Keep the final archive on the regional filesystem for guarded publication. The tile schema, geometry rules, and shared-storage opt-out are unchanged.

### 🔧 Operations

- Update the web and sync-worker services together. The build signature changes, so each existing regional archive receives one complete rebuild on its next refresh. No database migration is required.

[Full comparison](https://github.com/streletskiy/archimap/compare/0.10.1...0.10.2)

## v0.10.1

### ⚡ Performance

- **Continuous Search Refresh:** Start the PostgreSQL refresh worker without waiting for a user edit. Check durable changes every five seconds and process bounded batches independently of the regional queue, yielding between batches and retrying busy imports without losing changes ([3810ca2](https://github.com/streletskiy/archimap/commit/3810ca2)).
- **Search Projection:** Compute resolved fields and weighted vectors once per object in bounded refreshes. A paired warm query over 5,000 Nizhny Novgorod identities decreased from 157.113 ms to 94.285 ms with identical output; full rebuild behavior is unchanged.

### 🐛 Bug Fixes

- **Search Freshness:** Invalidate server search caches after committed background refreshes; preserve the existing browser cache lifetime. Recover from connection failures and retain importer-locked rows for a later pass.
- **Startup Scheduling:** Avoid repeating a region refresh already completed successfully during the same worker startup. Explicit manual, scheduled, and recovery work remains available.

### ✅ Validation

- Passed 576 unit tests and 38 integration tests with no skips, including PostgreSQL, Osmium, and Planetiler checks; formatting, lint, frontend/type checks, security, and smoke checks also passed.
- No database migrations or source-cache/map-format changes are required.

[Full comparison](https://github.com/streletskiy/archimap/compare/0.10.0...0.10.1)

## v0.10.0

### ⚡ Performance

- **Incremental Regional Sources:** Retain one dependency-complete regional PBF and apply validated replication diffs instead of downloading the full extract for every update. Reuse unchanged building input without repeating import, and keep cache publication atomic with canonical data ([4f8bf2f](https://github.com/streletskiy/archimap/commit/4f8bf2f)).
- **Incremental Map Archives:** Rebuild complete changed tiles, remove tiles that become empty, and preserve untouched compressed payloads. Track old and new footprints, affected parent buildings, and shared-region membership changes; fall back to a complete build when the base or spatial history cannot be trusted.
- **Archive Build Storage:** Keep Planetiler sorting and temporary output on local storage inside its existing container. Preserve the same geometry, zoom, simplification and compression settings, and derive stable feature IDs from OSM identity so partial and complete builds agree.
- **Canonical Export:** Index temporary building-part geometry before clipping and stream the base/remainder export without buffering the whole region ([951c295](https://github.com/streletskiy/archimap/commit/951c295)).

### 🐛 Bug Fixes

- **Complete Tag Search and Filters:** Include all building tag keys and values in search, preserve architectural and personal overrides, and align custom JSON value handling with application semantics ([3b3b61c](https://github.com/streletskiy/archimap/commit/3b3b61c)).
- **Update Consistency:** Consume durable search changes incrementally, maintain tag-key counts during imports, and prevent older overlapping source observations from replacing newer shared contours. Preserve complete geometry dependencies and user edits ([3b3b61c](https://github.com/streletskiy/archimap/commit/3b3b61c), [4f8bf2f](https://github.com/streletskiy/archimap/commit/4f8bf2f)).
- **Archive Publication:** Reject stale revisions and changed patch bases before publication. Commit archive identity and covered spatial invalidations together; keep the previous archive and pending changes after failed or cancelled builds.
- **Archive File Safety:** Keep the exclusively created output file open through copying and flushing, preventing a path-reopen race during archive staging.

### 🔒 Dependency Maintenance

- Pin the patched `minimatch` 11.0.4 in both dependency trees. Remove the unused, unmaintained `depcheck` command and its obsolete transitive dependencies; both clean dependency installations pass the security audit.

### 🔧 Operations

- **Coordinated Upgrade:** Update both `archimap` and `sync-worker` to the same release image. Preserve PostgreSQL, Redis, Planetiler and osm2pgsql sidecars; the application image now includes native Osmium for source replication.
- **Migration and Warm-up:** PostgreSQL migrations 035–042 add durable change tracking, source cursors and tile invalidations. Startup rebuilds the search projection, and each region's first refresh rebuilds its map archive; legacy sources need an initial complete download to establish their persistent cache and replication anchor.
- **Rollback:** Take a protected database backup before upgrading. Migration 036 changes search-vector maintenance, so reverting only to the 0.9.2 image is not a complete rollback; follow the [runbook](docs/runbook.md) and preserve writes made after deployment.

### ✅ Validation

- Passed 559 unit tests, 38 integration tests and 17 browser scenarios with no skips, plus formatting, lint, frontend/type, syntax, security and smoke checks. Integration coverage includes real PostgreSQL, Osmium and Planetiler execution.
- On an isolated Nizhny Novgorod Oblast stand with 742,579 canonical objects, complete map export/build/publication improved from 101.28 seconds to 46.49 seconds with the final safe output-copy path. Before that copy hardening, a fixture with parent/part edits, movement, deletion and a tile-boundary addition took 6.28 seconds through the partial path versus 40.55 seconds for a complete build of the same changed data. These measurements exclude source download and canonical import.
- All 89,324 tiles in the partial result matched the complete build's decompressed MVT bytes, including IDs, properties and geometry. The 89,316 untouched tiles retained their original compressed payloads, and archive compaction left no unreferenced tile bytes. See [PMTiles measurements](docs/performance/pmtiles.md).

[Full comparison](https://github.com/streletskiy/archimap/compare/0.9.2...0.10.0)

## v0.9.2

### 🐛 Bug Fixes

- **Floor Preview Lifecycle:** Preserve provisional floor colors while map layers, theme, or building-part visibility refresh before the authoritative API response. Clear the preview when results arrive, filters reset, or the request fails.
- **Regression Coverage:** Reproduce the production layer-refresh sequence while the filter response is pending and verify that completed or failed requests do not restore provisional colors.
- **Test Startup:** Keep integration and browser fixture port ranges outside ports blocked by browser and Node.js fetch implementations.
- **Backup Retention:** Retain database and configuration files by the backup set timestamp, so copying an older configuration cannot cause a fresh backup to lose its configuration files.

[Full comparison](https://github.com/streletskiy/archimap/compare/0.9.1...0.9.2)

## v0.9.1

### 🐛 Bug Fixes

- **Shared Administrative Tiles:** Publish rebuilt boundary archives atomically in the shared data directory so the web process serves worker updates. Keep the bundled archive as a startup fallback.
- **Archive Builder:** Execute builds inside the existing Planetiler sidecar with explicit file transfer, preserving its resource limits and supporting Docker hosts whose filesystem paths differ from the worker.
- **HTTP Checks:** Avoid browser-blocked ephemeral ports in Windows route tests and retry port conflicts.

[Full comparison](https://github.com/streletskiy/archimap/compare/0.9.0...0.9.1)

## v0.9.0

### ⚡ Performance

- **Map Loading:** Lazy-load panels and their dictionaries, bound Overpass caches, retry failed map-runtime loads, and reuse selected-building details with at most four concurrent loads ([205715f](https://github.com/streletskiy/archimap/commit/205715f)).
- **Floor Filters:** Add normalized floor attributes to new PMTiles archives for immediate provisional coloring; authoritative API results still include architectural and personal overrides. Project only required columns in batch queries ([205715f](https://github.com/streletskiy/archimap/commit/205715f)).
- **Search and Responses:** Query multiple exact style keys with shared pagination, preserve viewport bounds, compress GET responses asynchronously, and cache/compress application configuration ([205715f](https://github.com/streletskiy/archimap/commit/205715f)).

### 🐛 Bug Fixes

- **Account and Edits:** Confirm logout before clearing account state, invalidate browser/server caches after mutations, discard stale selection responses, and preserve per-building IDs and partial failures during bulk saves ([205715f](https://github.com/streletskiy/archimap/commit/205715f), [ca13b1b](https://github.com/streletskiy/archimap/commit/ca13b1b)).
- **Recovery:** Reconnect Redis after outages, probe live database/session readiness, serialize migrations, and replace immediate sync retry loops with bounded backoff and a manual-reset circuit ([ca13b1b](https://github.com/streletskiy/archimap/commit/ca13b1b)).

### 🔧 Operations

- **Import Isolation:** Move scheduling, imports and archive construction into an authenticated internal worker. The web container runs without root privileges or Docker socket access; Compose now has six services ([ca13b1b](https://github.com/streletskiy/archimap/commit/ca13b1b)).
- **Resource Budgets:** Add container memory/CPU limits, log rotation, database query deadlines, PostgreSQL I/O statistics and tuned autovacuum thresholds ([ca13b1b](https://github.com/streletskiy/archimap/commit/ca13b1b)).
- **Maintenance:** Add protected backup/off-host verification tools, metrics snapshots, stale-stage cleanup and bounded sync-history aggregation. Existing deployments must apply the new Compose configuration and review writable data permissions ([ca13b1b](https://github.com/streletskiy/archimap/commit/ca13b1b)).

### ✅ Validation

- Passed 483 unit tests, integration/security/smoke checks, 17 browser scenarios, formatting, lint, type checks and localization checks.
- Added PostgreSQL CI budgets for 20,000-building filters during concurrent writes and an isolated-worker authentication/readiness test. Verified Redis/PostgreSQL outage recovery without restarting the application.
- Database migrations are additive. Existing region archives retain API-based coloring until rebuilt with the new floor attributes.

[Full comparison](https://github.com/streletskiy/archimap/compare/0.8.5...0.9.0)

## v0.8.5

### ⚡ Performance

- **Dense Building Filters:** Replaced linear membership scans with indexed MapLibre lookups; the 6,976-building benchmark dropped from 300 ms to 9 ms for 55,808 membership evaluations ([7fede48](https://github.com/streletskiy/archimap/commit/7fede488d0317ba807e5c5ac07a10f819cbc5977)).
- **Filter Loading:** Omitted unused marker coordinates for contour views, added asynchronous Brotli/gzip compression, and coalesced duplicate initial requests while preserving URL filter identities ([7fede48](https://github.com/streletskiy/archimap/commit/7fede488d0317ba807e5c5ac07a10f819cbc5977)).
- **Cache Reuse:** Reused equivalent rule sets across client layer IDs and derived cache identity from validated rules instead of caller-supplied hashes ([7fede48](https://github.com/streletskiy/archimap/commit/7fede488d0317ba807e5c5ac07a10f819cbc5977)).

### 🐛 Bug Fixes

- **Highlight Lifecycle:** Prevented stale worker responses from restoring cleared highlights and restored paint after map style recreation ([7fede48](https://github.com/streletskiy/archimap/commit/7fede488d0317ba807e5c5ac07a10f819cbc5977)).
- **Filter Correctness:** Preserved architectural overrides and derived levels in PostgreSQL filters, corrected exact-limit truncation, and kept personal filter responses out of shared HTTP caches ([7fede48](https://github.com/streletskiy/archimap/commit/7fede488d0317ba807e5c5ac07a10f819cbc5977)).

### 🔧 Validation

- Passed formatting, lint, frontend checks, unit/integration, security, smoke, localization, and all 15 browser tests. No database migrations are required.

[Full comparison](https://github.com/streletskiy/archimap/compare/0.8.4...0.8.5)

## v0.8.4

### 🐛 Bug Fixes

- **Dependency Security:** Resolved server and browser dependency advisories, including MapLibre HTML sanitization, SMTP delivery, XML parsing, SvelteKit, and serialization issues ([732bfbd](https://github.com/streletskiy/archimap/commit/732bfbdb995147e98859ef657ce93684fa0cda93)).
- **Admin Coverage Tiles:** Serve the admin PMTiles archive with current file size, byte ranges, and cache validators after a startup rebuild ([732bfbd](https://github.com/streletskiy/archimap/commit/732bfbdb995147e98859ef657ce93684fa0cda93)).

### 📦 Dependency Updates

- **Frontend Platform:** Updated to SvelteKit 3, adapter-node 6, and MapLibre GL 6 while preserving navigation, camera state, and map overscaling. Map rendering now requires WebGL2 ([732bfbd](https://github.com/streletskiy/archimap/commit/732bfbdb995147e98859ef657ce93684fa0cda93)).
- **Runtime and Tooling:** Updated Node.js to 24.22.2, moved the application image to Alpine 3.24, pinned npm 12.2.1 with patched Undici and ip-address dependencies, and refreshed both npm lockfiles ([732bfbd](https://github.com/streletskiy/archimap/commit/732bfbdb995147e98859ef657ce93684fa0cda93)).

### 🔧 Maintenance

- **Dependency Monitoring:** Audit both complete npm dependency trees in CI, monitor the frontend with Dependabot, and retain a documented MIT-licensed deepmerge patch until an upstream fixed release is available ([732bfbd](https://github.com/streletskiy/archimap/commit/732bfbdb995147e98859ef657ce93684fa0cda93)).
- **Validation and Operations:** Verified clean npm audits, all 15 browser tests, container smoke checks, and a Trivy scan with no detected vulnerabilities; documented Windows boot startup and recovery ([732bfbd](https://github.com/streletskiy/archimap/commit/732bfbdb995147e98859ef657ce93684fa0cda93)).

[Full comparison](https://github.com/streletskiy/archimap/compare/0.8.3...0.8.4)

## v0.8.3

### 🚀 Features

- **Modern Basemaps and 3D Mapping:** Added a configurable MapTiler basemap, custom PMTiles sources, 3D buildings, URL-backed camera settings, and a visual roof-shape selector ([2d07099](https://github.com/streletskiy/archimap/commit/2d070994835443b5f1de7caed13ed46c444b2d96), [5e5a803](https://github.com/streletskiy/archimap/commit/5e5a803066653902c8f7d40198fd38adf4e8992a), [69eba7f](https://github.com/streletskiy/archimap/commit/69eba7f11f6d198354a7409e0e32184455cac6f7), [925bd5c](https://github.com/streletskiy/archimap/commit/925bd5ce87d47d4c977dd8ec79228cc84be4e762), [4799efd](https://github.com/streletskiy/archimap/commit/4799efd8e4d26e1afc87de440fb7bb84cdef3c85)).
- **Incremental Region Sync:** Added incremental diff and merge primitives, end-to-end incremental synchronization, Geofabrik country subdivisions, and Planetiler-based PMTiles generation ([3c67b65](https://github.com/streletskiy/archimap/commit/3c67b65571541bf8ffc8decdc8ebe76b66a6171f), [785a0e4](https://github.com/streletskiy/archimap/commit/785a0e4604a3abc1459b7c37e268193c19e5a12a), [aef5cfa](https://github.com/streletskiy/archimap/commit/aef5cfa368f4c93eb3a13f554c7cab03d831a2c3), [ffc4b39](https://github.com/streletskiy/archimap/commit/ffc4b39130bdaa3f1ef2b4a9ea17be8202a3d222)).
- **Region Sync Operations:** Added segmented pipeline progress, cancellation, and clearer stage reporting in the admin interface ([fd3eb9a](https://github.com/streletskiy/archimap/commit/fd3eb9aaf82dd21b3ad1ced180755734e536d6ec), [81cf8c2](https://github.com/streletskiy/archimap/commit/81cf8c2981ea5b0dc3510aebd693bc64f8b107a0), [b7b662a](https://github.com/streletskiy/archimap/commit/b7b662a1872f09805a8bee18d00d3bad9f30f7e5)).

### 🛠 Architecture & Refactoring

- **Low-Memory Import Pipeline:** Reworked managed region sync around PostgreSQL, osmium, Planetiler, sharded PMTiles builds, and a low-memory export/apply path for large regions and lower-power hosts ([95d9621](https://github.com/streletskiy/archimap/commit/95d9621c54364d87234511fd41f111f3a79d6a12), [ff14c33](https://github.com/streletskiy/archimap/commit/ff14c33d847c32aa62b4621599facc1b0f14d757), [5091629](https://github.com/streletskiy/archimap/commit/50916295791c24b3a17fc08a281ee1eb48400729), [1e7f6b4](https://github.com/streletskiy/archimap/commit/1e7f6b4ff47c88591158b967003b9b6533a8a863)).
- **Import Performance:** Reduced bulk-upsert work, materialized DuckDB exports, rebuilt indexes around large imports, and avoided unnecessary PostgreSQL re-exports ([b3c259e](https://github.com/streletskiy/archimap/commit/b3c259e61d0c05b40a7b72dd9aee912b195853ea), [5c2e32e](https://github.com/streletskiy/archimap/commit/5c2e32ec6282d01a25aeeccca9f65001d8f98b32), [6ae4bd3](https://github.com/streletskiy/archimap/commit/6ae4bd39c078fa60ff8052a5d02612d48347ce1d), [a30e05e](https://github.com/streletskiy/archimap/commit/a30e05e27223abfc544ff3f481e25e68425f3bc6)).
- **Map Rendering:** Split the 3D stack and MapLibre renderer into isolated services while preserving map layer behavior ([db497a0](https://github.com/streletskiy/archimap/commit/db497a0f1430b199c9ae850a4a03cd15e68b57a9), [7da6fc6](https://github.com/streletskiy/archimap/commit/7da6fc6056fc3dd05b56c82b1f74bb252ecf7a46)).

### 🐛 Bug Fixes

- **OSM Relation Safety:** Preserved complete relation member lists during tag-only synchronization and added a guarded structural-repair workflow for already damaged relations ([3ebb966](https://github.com/streletskiy/archimap/commit/3ebb966a935130851d429a38e00d67506b59c1c4), [3b3112d](https://github.com/streletskiy/archimap/commit/3b3112d218e76903cf60ccc5316f569573002606)).
- **Region Sync Reliability:** Prevented duplicate retries and requeues, recovered interrupted jobs correctly, cleaned temporary workspaces, and avoided out-of-memory failures on large PBF inputs ([3a9e361](https://github.com/streletskiy/archimap/commit/3a9e36145bc049ab432d3c77b390cfa91320d284), [33f6073](https://github.com/streletskiy/archimap/commit/33f607332303f55bb5aeff4e434119ba87b58153), [e4bb6ef](https://github.com/streletskiy/archimap/commit/e4bb6ef1932972c8016760bc589d513fc6e7c4a2), [a369e7b](https://github.com/streletskiy/archimap/commit/a369e7bc6bc04d62da36ff1091b7defd82038100), [6feb0fb](https://github.com/streletskiy/archimap/commit/6feb0fbef8e5f63b93592cb73236d77c94c2273d)).
- **Security Hardening:** Protected basemap credentials from cache validators and ETags, hardened SMTP delivery, and resolved dependency security advisories ([4614e82](https://github.com/streletskiy/archimap/commit/4614e82ad573bb2d8525dc5994da967baeaaecf1), [34f8f28](https://github.com/streletskiy/archimap/commit/34f8f28c2bb2b0fa2527e66f528a5a46bb079076), [aba6c26](https://github.com/streletskiy/archimap/commit/aba6c267796da214a19984d7538ef733aa18233f), [648dcc3](https://github.com/streletskiy/archimap/commit/648dcc389ffef88d84d8cfbad700fcc041667fca)).
- **Map and Admin UX:** Restored URL filters, stabilized low-zoom marker ordering and glyph routing, blocked premature sync actions, and kept unchanged OSM tags visually neutral ([9a645f0](https://github.com/streletskiy/archimap/commit/9a645f0c16a63356e15f35e591b78f0bfb3362eb), [1402ed7](https://github.com/streletskiy/archimap/commit/1402ed7a08a7d562d274443dd9454f9d405a8a74), [ae941ec](https://github.com/streletskiy/archimap/commit/ae941ecde4bcbd508e4c5c8a4aa7360279718625), [796f6f3](https://github.com/streletskiy/archimap/commit/796f6f340f3f9d8a916334ad7c84e6383e53dae0), [eb5a181](https://github.com/streletskiy/archimap/commit/eb5a181422eb2572a5e2336d8689fc5c8bcc1acf)).

### 📦 Dependency Updates

- **Runtime and Tooling:** Updated security-sensitive npm dependencies, refreshed both lockfiles, and confirmed clean production and development audits ([1f70cee](https://github.com/streletskiy/archimap/commit/1f70cee3c9ada50a480f6d63b810ee7168929051), [648dcc3](https://github.com/streletskiy/archimap/commit/648dcc389ffef88d84d8cfbad700fcc041667fca)).

### 🔧 Maintenance

- **Container Delivery:** Added automatic `dev` image publication and release automation for versioned multi-architecture images and `latest` ([f39024b](https://github.com/streletskiy/archimap/commit/f39024b108a3e0297c890cc75cd05295a840abe9)).
- **Project Guidance:** Added the Graphify knowledge graph, agent instructions, repository-wide LF rules, and refreshed development and operational documentation ([10642ee](https://github.com/streletskiy/archimap/commit/10642ee0a267130e51fd7a14a787e2c00dc68f72), [9828a9b](https://github.com/streletskiy/archimap/commit/9828a9b9d4bcf3c5fb79668f04d47c11dbd50c82)).

[Full comparison](https://github.com/streletskiy/archimap/compare/0.8.2...0.8.3)
