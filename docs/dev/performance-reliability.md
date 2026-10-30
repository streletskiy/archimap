# Performance and reliability operations

## Web and import isolation

Compose runs six services. `archimap` runs as UID 1000 without Docker access; the
authenticated, internal-only `sync-worker:3253` owns scheduling, imports and sidecar
execution. The worker derives its RPC credential from `SESSION_SECRET`; an explicit
`SYNC_WORKER_TOKEN` can override it. Do not publish port 3253. Both processes must
share the same credential. Standalone development retains in-process workers when
`SYNC_WORKER_URL` is absent.

The worker publishes administrative boundary archives atomically under
`data/cache/admin-regions.pmtiles`, shared with the web container. The bundled
archive remains a fallback until the shared copy exists. Archive builds execute
inside the existing Planetiler sidecar and copy their inputs explicitly, so Docker
host paths do not need to match paths inside the worker.

The public port binds to loopback by default. Set `ARCHIMAP_BIND_ADDRESS` explicitly
if the reverse proxy is on another host. Existing writable bind mounts must permit
UID 1000 to access `data`; verify this before switching an existing Linux deployment.

Memory ceilings total 14.75 GiB by default: PostgreSQL 8 GiB, web and worker 1.5 GiB
each, Planetiler 2.5 GiB, osm2pgsql 1 GiB and Redis 256 MiB. These are ceilings, not
reservations. Leave headroom for the host. All logs rotate at 20 MiB, keeping three
files per container. PostgreSQL uses 16 MiB `work_mem` per operation; web statements
expire after 15 seconds and imports use a separate four-connection pool.

## Recovery and monitoring

`/readyz` probes both PostgreSQL and Redis with a two-second deadline. Redis
reconnects with bounded backoff after a previously successful connection. Initial
connection failures still obey `SESSION_ALLOW_MEMORY_FALLBACK`; production should
keep fallback disabled. Region failures retry after roughly 5, 10, 20, 40, 80, 160
and 320 minutes (bounded by the configured interval and six hours), with jitter.
After eight consecutive failures automatic retries stop; a manual retry remains
available. Success resets the counter.

Enable `METRICS_ENABLED=true` and set a long random `METRICS_TOKEN`. Scrape with a
Bearer token. Metrics cover request duration buckets, cache hits/misses/evictions,
event-loop delay, database pool pressure and worker queue age. Recommended alerts:
readiness failure, worker down, increasing 5xx, pool waiters, queue age over the
expected import duration and missing backup success. `scripts/ops/collect-metrics.ps1`
stores five-minute snapshots for seven days and fails when readiness or worker
checks fail; Windows Task Scheduler records a nonzero task result. Integrate the
endpoint with the team's alert receiver when one is available.

Compose preloads `pg_stat_statements`; create the extension once in the application
database as an operator. Inspect aggregate duration and temporary I/O, avoiding raw
SQL or query parameters in public reports. `track_io_timing` is enabled.

## Backup and maintenance

`scripts/ops/backup.ps1` creates a consistent custom-format PostgreSQL dump, excludes
rebuildable staging schemas, validates the archive table of contents, writes a SHA256
manifest and retains three days. Store scripts and backups under the ACL-protected
`C:\ProgramData\Archimap` directory. Run daily as SYSTEM. Each manifest also covers
protected copies of `.env` and Compose; the receiver verifies and transfers them
alongside the database. Generated PMTiles can be regenerated. Keep release rollback
image tags until verification finishes.

Copy completed dumps and their manifests to another machine. Verify byte count and
SHA256 after transfer. A backup is not proven recoverable until `pg_restore
--exit-on-error --no-owner --no-acl` succeeds into a separate PostgreSQL/PostGIS
database and row counts, application startup and representative filters are checked.
Never restore over production during verification. Check the off-host copy's age;
a workstation can copy only while it is online.

`node scripts/ops/receive-backup.mjs <private-settings.json>` pulls a completed dump
through an authorized MeshCentral file session, checks freshness and SHA256, and
retains three days locally. Settings contain `connectionFile` (existing private
MeshCentral connection JSON), `meshctrl`, `modulePath` (directory providing `ws` and
`minimist`), exact `nodeId`, `remoteRoot`, and `destination`. Use a MeshCtrl client
with TLS certificate validation enabled and environment-based login-key support.
Protect the destination/settings with ACLs. Schedule with IgnoreNew; a failed or
stale transfer must leave a nonzero task result and preserve the last verified copy.

Run `node --import tsx scripts/postgres-maintenance.ts` for a dry run, then `--apply`
for maintenance. It acquires an advisory lock, drops only recognized staging schemas
older than 24 hours for regions without queued/running jobs, and archives terminal
run history older than 30 days into daily aggregates. Last successful runs and parent
rows referenced by children are preserved. Work is bounded to 200 batches of 5,000.
`--analyze` additionally vacuums/analyzes the two large spatial tables and belongs in
an off-peak maintenance window. Schedule ordinary maintenance daily.

## Filter and client behavior

New region PMTiles contain versioned normalized floor properties. Compatible floor
filters can paint loaded tiles immediately while the authoritative API computes
results including approved and personal edits. The preview is provisional and is
removed on an API failure; old archives use the normal API path until rebuilt.
Backend batches select only required architectural columns. PostgreSQL CI exercises
20,000 buildings during writes, verifies override precedence, and requires uncached
requests under five seconds and cached requests under 250 ms.

Panel code and dictionaries load when needed. Selection details are incremental with
four concurrent requests. Auth/edit revisions invalidate client caches. Overpass
cache entries expire after seven days, refresh in the background after two minutes,
and retain stale data while offline; memory and persistent caches have byte/item
budgets. Logout changes local state only after server confirmation.
