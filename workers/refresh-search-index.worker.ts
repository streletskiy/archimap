require('dotenv').config({ quiet: true });

const path = require('path');
const { createDbRuntime } = require('../src/lib/server/infra/db-runtime.infra');
const { getDbProvider, getPostgresConnectionString } = require('../scripts/lib/postgres-config');
const { createSearchIndexRefreshService } = require('../src/lib/server/services/search-index-refresh.service');

const DB_PROVIDER = getDbProvider(process.env);
const DATABASE_URL = getPostgresConnectionString(process.env);
const ARCHIMAP_DB_PATH = String(
  process.env.DATABASE_PATH
  || process.env.ARCHIMAP_DB_PATH
  || process.env.SQLITE_URL
  || path.join(__dirname, '..', 'data', 'archimap.db')
).trim() || path.join(__dirname, '..', 'data', 'archimap.db');
const OSM_DB_PATH = String(process.env.OSM_DB_PATH || path.join(__dirname, '..', 'data', 'osm.db')).trim() || path.join(__dirname, '..', 'data', 'osm.db');
const LOCAL_EDITS_DB_PATH = String(process.env.LOCAL_EDITS_DB_PATH || path.join(__dirname, '..', 'data', 'local-edits.db')).trim() || path.join(__dirname, '..', 'data', 'local-edits.db');

const queue = [];
let draining = false;
let runtime = null;
let refreshService = null;
let isReady = false;

function sendMessage(message) {
  if (typeof process.send === 'function') {
    try {
      process.send(message);
    } catch {
      // ignore IPC send failures during shutdown
    }
  }
}

function canDrainQueue() {
  return isReady && Boolean(refreshService);
}

function normalizeTargetMessage(message) {
  const osmType = String(message?.osmType || '').trim();
  const osmId = Number(message?.osmId);
  if (!['way', 'relation'].includes(osmType) || !Number.isInteger(osmId) || osmId <= 0) {
    return null;
  }
  return {
    osmType,
    osmId
  };
}

async function drainQueue() {
  if (draining || !canDrainQueue()) return;
  draining = true;
  try {
    while (queue.length > 0) {
      const item = queue.shift();
      if (!item) continue;
      try {
        await refreshService.refreshSearchIndexForBuilding(item.osmType, item.osmId);
      } catch (error) {
        console.error('[search-refresh-worker] refresh_failed', {
          osmType: item.osmType,
          osmId: item.osmId,
          error: String(error?.message || error)
        });
      }
    }
  } finally {
    draining = false;
    if (canDrainQueue() && queue.length > 0) {
      void drainQueue();
    }
  }
}

process.on('message', (message) => {
  const target = normalizeTargetMessage(message);
  if (!target) return;
  queue.push(target);
  void drainQueue();
});

async function main() {
  runtime = await createDbRuntime({
    runtimeEnv: {
      dbProvider: DB_PROVIDER,
      databaseUrl: DATABASE_URL
    },
    rawEnv: process.env,
    sqlite: {
      dbPath: ARCHIMAP_DB_PATH,
      osmDbPath: OSM_DB_PATH,
      localEditsDbPath: LOCAL_EDITS_DB_PATH
    },
    logger: console
  });

  refreshService = createSearchIndexRefreshService({
    db: runtime.db,
    logger: console
  });
  isReady = true;

  if (typeof process.send === 'function') {
    sendMessage({ type: 'ready' });
  }

  void drainQueue();

  const shutdown = async () => {
    try {
      if (runtime) {
        await runtime.close();
      }
    } catch {
      // ignore shutdown cleanup errors
    }
  };

  process.once('SIGTERM', async () => {
    await shutdown();
    process.exit(0);
  });

  process.once('SIGINT', async () => {
    await shutdown();
    process.exit(0);
  });
}

main().catch((error) => {
  console.error('[search-refresh-worker] failed', String(error?.message || error));
  process.exit(1);
});
