const path = require('path');
const { createDbRuntime } = require('../src/lib/server/infra/db-runtime.infra');
const { getDbProvider, getPostgresConnectionString } = require('../scripts/lib/postgres-config');
const { createSearchIndexRefreshService } = require('../src/lib/server/services/search-index-refresh.service');
const { Client } = require('pg');
const { refreshPostgresSearchChanges, SEARCH_PROJECTION_VERSION } = require('../src/lib/server/services/search-index-postgres.service');

function createSearchRefreshWorker(options: LooseRecord = {}) {
  const {
    provider, databaseUrl, runtimeOptions,
    createRuntime = createDbRuntime,
    createRefreshService = createSearchIndexRefreshService,
    createDurableClient = () => new Client({ connectionString: databaseUrl,
      application_name: 'archimap-search-refresh', connectionTimeoutMillis: 10000 }),
    refreshDurableChanges = refreshPostgresSearchChanges,
    sendMessage = () => {},
    logger = console,
    setTimeoutFn = setTimeout,
    clearTimeoutFn = clearTimeout
  } = options;
  const isPostgres = provider === 'postgres';
  const queue = new Map();
  let runtime = null;
  let refreshService = null;
  let activeDrain = null;
  let startPromise = null;
  let stopping = false;
  let stopPromise = null;
  let durableClient = null;
  let durableTimer = null;
  let retryAttempt = 0;
  let durableDrainRequested = isPostgres;

  function clearDurableTimer() {
    if (durableTimer) clearTimeoutFn(durableTimer);
    durableTimer = null;
  }

  function scheduleDurableDrain(delay) {
    if (!isPostgres || stopping) return;
    clearDurableTimer();
    durableTimer = setTimeoutFn(() => {
      durableTimer = null;
      if (stopping) return;
      durableDrainRequested = true;
      void drainQueue();
    }, delay);
    durableTimer?.unref?.();
  }

  function scheduleDurableRetry() {
    scheduleDurableDrain(Math.min(60000, 1000 * (2 ** Math.min(retryAttempt++, 6))));
  }

  async function drainDurableChanges() {
    if (!durableClient) {
      const client = createDurableClient();
      client.on('error', () => {
        if (durableClient !== client) return;
        durableClient = null;
        void client.end().catch(() => {});
        scheduleDurableRetry();
      });
      try { await client.connect(); } catch (error) { await client.end().catch(() => {}); throw error; }
      durableClient = client;
    }
    // A fresh deployment may still be building its initial projection. Do not
    // acknowledge changes against a missing or older search representation.
    const state = await durableClient.query(`SELECT projection_version,
      to_regclass('public.idx_building_search_source_tsv') IS NOT NULL AS index_present
      FROM public.search_index_state WHERE id = 1`);
    if (Number(state.rows[0]?.projection_version) !== SEARCH_PROJECTION_VERSION || !state.rows[0]?.index_present) return 0;
    // Release the writer lock between slices, so edits and full rebuilds are not
    // stuck behind an entire regional import. A busy lock is retried by polling.
    const processed = await refreshDurableChanges(durableClient, { maxBatches: 1, waitForLock: false });
    sendMessage({ type: 'drained', processed });
    return processed;
  }

  function drainQueue() {
    if (activeDrain || stopping || !refreshService) return activeDrain || Promise.resolve();
    activeDrain = Promise.resolve().then(async () => {
      // Prefer explicit edits before each durable batch, while bounding a slice
      // even if more IPC messages arrive continuously.
      const targets = Array.from(queue.values()).slice(0, 100);
      for (const item of targets) {
        if (stopping) break;
        queue.delete(item.osmType + '/' + item.osmId);
        try {
          await refreshService.refreshSearchIndexForBuilding(item.osmType, item.osmId);
          sendMessage({ type: 'refreshed', processed: 1 });
        } catch (error) {
          logger.error('[search-refresh-worker] refresh_failed', {
            osmType: item.osmType, osmId: item.osmId, error: String(error?.message || error)
          });
          scheduleDurableRetry();
        }
      }
      if (durableDrainRequested && !stopping) {
        durableDrainRequested = false;
        try {
          const processed = await drainDurableChanges();
          retryAttempt = 0;
          // Continuous imports must not postpone search until the region queue
          // becomes empty. Poll idle queues; yield briefly between busy slices.
          scheduleDurableDrain(processed > 0 ? 25 : 5000);
        } catch (error) {
          logger.error('[search-refresh-worker] durable_drain_failed', String(error?.message || error));
          const failedClient = durableClient;
          durableClient = null;
          if (failedClient) await failedClient.end().catch(() => {});
          scheduleDurableRetry();
        }
      }
    }).finally(() => {
      activeDrain = null;
      if (!stopping && (queue.size > 0 || durableDrainRequested)) void drainQueue();
    });
    return activeDrain;
  }

  function enqueue(message) {
    const osmType = String(message?.osmType || '').trim();
    const osmId = Number(message?.osmId);
    if (stopping || !['way', 'relation'].includes(osmType) || !Number.isSafeInteger(osmId) || osmId <= 0) return;
    queue.set(osmType + '/' + osmId, { osmType, osmId });
    void drainQueue();
  }

  function start() {
    if (startPromise) return startPromise;
    if (stopping) return Promise.resolve();
    startPromise = (async () => {
      runtime = await createRuntime(runtimeOptions);
      if (stopping) return;
      refreshService = createRefreshService({ db: runtime.db, logger });
      sendMessage({ type: 'ready' });
      void drainQueue();
    })();
    return startPromise;
  }

  function stop() {
    if (stopPromise) return stopPromise;
    stopping = true;
    clearDurableTimer();
    stopPromise = (async () => {
      await startPromise?.catch(() => {});
      await activeDrain?.catch(() => {});
      if (durableClient) await durableClient.end().catch(() => {});
      durableClient = null;
      if (runtime) await runtime.close();
    })();
    return stopPromise;
  }

  return { start, enqueue, stop };
}

async function main() {
  require('dotenv').config({ quiet: true });
  const provider = getDbProvider(process.env);
  const databaseUrl = getPostgresConnectionString(process.env);
  const sqlitePath = (value, name) => String(value || path.join(__dirname, '..', 'data', name)).trim() || path.join(__dirname, '..', 'data', name);
  const worker = createSearchRefreshWorker({
    provider, databaseUrl,
    runtimeOptions: {
      runtimeEnv: { dbProvider: provider, databaseUrl }, rawEnv: process.env,
      sqlite: {
        dbPath: sqlitePath(process.env.DATABASE_PATH || process.env.ARCHIMAP_DB_PATH || process.env.SQLITE_URL, 'archimap.db'),
        osmDbPath: sqlitePath(process.env.OSM_DB_PATH, 'osm.db'),
        localEditsDbPath: sqlitePath(process.env.LOCAL_EDITS_DB_PATH, 'local-edits.db')
      }, logger: console
    },
    sendMessage(message) {
      if (typeof process.send === 'function') {
        try { process.send(message); } catch { /* IPC may close during shutdown. */ }
      }
    }
  });
  process.on('message', worker.enqueue);
  const shutdown = async () => {
    try { await worker.stop(); } finally { process.exit(0); }
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
  process.once('disconnect', shutdown);
  await worker.start();
}

if (require.main === module) {
  main().catch((error) => {
    console.error('[search-refresh-worker] failed', String(error?.message || error));
    process.exit(1);
  });
}

module.exports = { createSearchRefreshWorker };
