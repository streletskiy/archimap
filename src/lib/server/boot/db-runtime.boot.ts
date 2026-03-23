const { createDbRuntime } = require('../infra/db-runtime.infra');

function createDeferredDb(runtimePromise, provider) {
  return {
    provider,
    prepare(sql) {
      return {
        get: async (...args) => {
          const runtime = await runtimePromise;
          return runtime.db.prepare(sql).get(...args);
        },
        all: async (...args) => {
          const runtime = await runtimePromise;
          return runtime.db.prepare(sql).all(...args);
        },
        run: async (...args) => {
          const runtime = await runtimePromise;
          return runtime.db.prepare(sql).run(...args);
        }
      };
    },
    exec: async (sql) => {
      const runtime = await runtimePromise;
      return runtime.db.exec(sql);
    },
    transaction(fn) {
      return async (...args) => {
        const runtime = await runtimePromise;
        const tx = runtime.db.transaction(fn);
        return tx(...args);
      };
    },
    withNativeTransaction(fn) {
      return async (...args) => {
        const runtime = await runtimePromise;
        const tx = runtime.db.transaction(() => fn(runtime.db, ...args));
        return tx();
      };
    }
  };
}

function createDbRuntimeBoot(options: LooseRecord = {}) {
  const {
    runtimeEnv,
    rawEnv = process.env,
    sqlite = {},
    postgres = {},
    logger,
    provider
  } = options;

  const rtreeState = { supported: false, ready: false, rebuilding: false };
  let dbRuntimeReady = false;
  let scheduleBuildingContoursRtreeRebuild: (...args: any[]) => any = () => {};

  const dbRuntimePromise = createDbRuntime({
    runtimeEnv,
    rawEnv,
    sqlite,
    postgres,
    logger
  });
  const db = createDeferredDb(dbRuntimePromise, provider);

  dbRuntimePromise.then((runtime) => {
    dbRuntimeReady = true;
    if (runtime?.rtreeState && typeof runtime.rtreeState === 'object') {
      rtreeState.supported = Boolean(runtime.rtreeState.supported);
      rtreeState.ready = Boolean(runtime.rtreeState.ready);
      rtreeState.rebuilding = Boolean(runtime.rtreeState.rebuilding);
    }
    scheduleBuildingContoursRtreeRebuild = typeof runtime?.scheduleBuildingContoursRtreeRebuild === 'function'
      ? runtime.scheduleBuildingContoursRtreeRebuild
      : (() => {});
  }).catch((error) => {
    logger.error('db_runtime_init_failed', { error: String(error?.message || error) });
    process.exit(1);
  });

  async function closeDbRuntime() {
    try {
      const runtime = await dbRuntimePromise;
      if (runtime && typeof runtime.close === 'function') {
        await runtime.close();
      }
    } catch {
      // ignore shutdown cleanup errors
    }
  }

  return {
    db,
    dbRuntimePromise,
    closeDbRuntime,
    rtreeState,
    isDbRuntimeReady: () => dbRuntimeReady,
    scheduleBuildingContoursRtreeRebuild: (...args: any[]) => scheduleBuildingContoursRtreeRebuild(...args)
  };
}

module.exports = {
  createDbRuntimeBoot
};
