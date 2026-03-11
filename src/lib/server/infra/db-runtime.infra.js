const path = require('path');
const { AsyncLocalStorage } = require('async_hooks');
const { Pool } = require('pg');
const { initDbBootstrapInfra } = require('./db-bootstrap.infra');
const { runPendingPostgresMigrations } = require('./postgres-migrations.infra');

function resolvePostgresConnectionString(runtimeEnv = {}, rawEnv = process.env) {
  const direct = String(runtimeEnv.databaseUrl || rawEnv.DATABASE_URL || '').trim();
  if (direct) return direct;

  const host = String(rawEnv.POSTGRES_HOST || rawEnv.PGHOST || '').trim();
  const port = Number(rawEnv.POSTGRES_PORT || rawEnv.PGPORT || 5432);
  const user = String(rawEnv.POSTGRES_USER || rawEnv.PGUSER || '').trim();
  const password = String(rawEnv.POSTGRES_PASSWORD || rawEnv.PGPASSWORD || '').trim();
  const dbName = String(rawEnv.POSTGRES_DB || rawEnv.PGDATABASE || '').trim();
  if (!host || !user || !dbName) return '';

  const authPart = `${encodeURIComponent(user)}:${encodeURIComponent(password)}@`;
  return `postgresql://${authPart}${host}:${port}/${encodeURIComponent(dbName)}`;
}

function convertNamedParams(sql, namedParams) {
  const values = [];
  const indexByName = new Map();
  const text = String(sql || '').replace(/@([a-zA-Z_][a-zA-Z0-9_]*)/g, (_full, name) => {
    if (!Object.prototype.hasOwnProperty.call(namedParams, name)) {
      throw new Error(`Missing SQL named param: @${name}`);
    }
    if (!indexByName.has(name)) {
      indexByName.set(name, values.length + 1);
      values.push(namedParams[name]);
    }
    return `$${indexByName.get(name)}`;
  });
  return { text, values };
}

function replaceSqlitePositionalPlaceholders(sql, replacer) {
  const source = String(sql || '');
  let out = '';
  let index = 0;
  let cursor = 0;
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let inLineComment = false;
  let inBlockComment = false;
  let dollarQuoteTag = null;

  while (cursor < source.length) {
    const next = source[cursor + 1] || '';

    if (inLineComment) {
      out += source[cursor];
      if (source[cursor] === '\n') {
        inLineComment = false;
      }
      cursor += 1;
      continue;
    }

    if (inBlockComment) {
      if (source[cursor] === '*' && next === '/') {
        out += '*/';
        cursor += 2;
        inBlockComment = false;
        continue;
      }
      out += source[cursor];
      cursor += 1;
      continue;
    }

    if (dollarQuoteTag) {
      if (source.startsWith(dollarQuoteTag, cursor)) {
        out += dollarQuoteTag;
        cursor += dollarQuoteTag.length;
        dollarQuoteTag = null;
        continue;
      }
      out += source[cursor];
      cursor += 1;
      continue;
    }

    if (inSingleQuote) {
      out += source[cursor];
      if (source[cursor] === '\'' && next === '\'') {
        out += next;
        cursor += 2;
        continue;
      }
      if (source[cursor] === '\'') {
        inSingleQuote = false;
      }
      cursor += 1;
      continue;
    }

    if (inDoubleQuote) {
      out += source[cursor];
      if (source[cursor] === '"' && next === '"') {
        out += next;
        cursor += 2;
        continue;
      }
      if (source[cursor] === '"') {
        inDoubleQuote = false;
      }
      cursor += 1;
      continue;
    }

    if (source[cursor] === '-' && next === '-') {
      out += '--';
      cursor += 2;
      inLineComment = true;
      continue;
    }

    if (source[cursor] === '/' && next === '*') {
      out += '/*';
      cursor += 2;
      inBlockComment = true;
      continue;
    }

    if (source[cursor] === '\'') {
      out += source[cursor];
      cursor += 1;
      inSingleQuote = true;
      continue;
    }

    if (source[cursor] === '"') {
      out += source[cursor];
      cursor += 1;
      inDoubleQuote = true;
      continue;
    }

    if (source[cursor] === '$') {
      const remainder = source.slice(cursor);
      const dollarMatch = remainder.match(/^\$[a-zA-Z_][a-zA-Z0-9_]*\$/) || remainder.match(/^\$\$/);
      if (dollarMatch) {
        dollarQuoteTag = dollarMatch[0];
        out += dollarQuoteTag;
        cursor += dollarQuoteTag.length;
        continue;
      }
    }

    if (source[cursor] === '?') {
      index += 1;
      out += replacer(index);
      cursor += 1;
      continue;
    }

    out += source[cursor];
    cursor += 1;
  }

  return out;
}

function convertPositionalParams(sql, positionalParams) {
  const text = replaceSqlitePositionalPlaceholders(sql, (index) => `$${index}`);
  return { text, values: positionalParams };
}

function normalizePostgresSql(sql) {
  return String(sql || '')
    .replace(/datetime\('now'\)/gi, 'NOW()')
    .replace(/\s+COLLATE\s+NOCASE/gi, '');
}

function normalizeStatementArgs(args) {
  if (args.length === 1 && args[0] && typeof args[0] === 'object' && !Array.isArray(args[0])) {
    return { type: 'named', params: args[0] };
  }
  return { type: 'positional', params: args };
}

function pickLastInsertRowId(row) {
  if (!row || typeof row !== 'object') return undefined;
  if (Object.prototype.hasOwnProperty.call(row, 'id')) return row.id;
  const keys = Object.keys(row);
  if (keys.length === 0) return undefined;
  return row[keys[0]];
}

function createPostgresCompatDb(pool) {
  const txStorage = new AsyncLocalStorage();

  function getQueryable() {
    return txStorage.getStore() || pool;
  }

  async function runQuery(sql, args) {
    const normalizedSql = normalizePostgresSql(sql);
    const normalizedArgs = normalizeStatementArgs(args);
    const converted = normalizedArgs.type === 'named'
      ? convertNamedParams(normalizedSql, normalizedArgs.params)
      : convertPositionalParams(normalizedSql, normalizedArgs.params);
    const result = await getQueryable().query(converted.text, converted.values);
    return result;
  }

  return {
    provider: 'postgres',
    prepare(sql) {
      return {
        get: async (...args) => {
          const result = await runQuery(sql, args);
          return result.rows[0] || undefined;
        },
        all: async (...args) => {
          const result = await runQuery(sql, args);
          return result.rows;
        },
        run: async (...args) => {
          const result = await runQuery(sql, args);
          return {
            changes: Number(result.rowCount || 0),
            lastInsertRowid: pickLastInsertRowId(result.rows[0])
          };
        }
      };
    },
    exec: async (sql) => {
      await getQueryable().query(String(sql || ''));
    },
    transaction(fn) {
      return async (...args) => {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          const result = await txStorage.run(client, async () => fn(...args));
          await client.query('COMMIT');
          return result;
        } catch (error) {
          try {
            await client.query('ROLLBACK');
          } catch {
            // ignore rollback failure; keep original error
          }
          throw error;
        } finally {
          client.release();
        }
      };
    }
  };
}

function createSqliteCompatDb(sqliteDb) {
  let txQueue = Promise.resolve();

  return {
    provider: 'sqlite',
    prepare(sql) {
      const statement = sqliteDb.prepare(String(sql || ''));
      return {
        get: (...args) => statement.get(...args),
        all: (...args) => statement.all(...args),
        run: (...args) => statement.run(...args)
      };
    },
    exec(sql) {
      sqliteDb.exec(String(sql || ''));
    },
    transaction(fn) {
      return async (...args) => {
        const run = async () => {
          sqliteDb.exec('BEGIN');
          try {
            const result = await fn(...args);
            sqliteDb.exec('COMMIT');
            return result;
          } catch (error) {
            try {
              sqliteDb.exec('ROLLBACK');
            } catch {
              // ignore rollback failures to keep original error
            }
            throw error;
          }
        };

        const execution = txQueue.then(run, run);
        txQueue = execution.catch(() => {});
        return execution;
      };
    }
  };
}

async function createDbRuntime(options = {}) {
  const {
    runtimeEnv,
    rawEnv = process.env,
    sqlite = {},
    postgres = {},
    logger = console
  } = options;
  const provider = String(runtimeEnv?.dbProvider || 'sqlite').trim().toLowerCase();

  if (provider === 'postgres') {
    const connectionString = resolvePostgresConnectionString(runtimeEnv, rawEnv);
    if (!connectionString) {
      throw new Error('DATABASE_URL (or POSTGRES_* vars) is required for DB_PROVIDER=postgres');
    }
    await runPendingPostgresMigrations({
      connectionString,
      migrationsDir: postgres.migrationsDir,
      logger
    });

    const pool = new Pool({
      connectionString,
      max: Number(rawEnv.PG_POOL_MAX || 20),
      idleTimeoutMillis: Number(rawEnv.PG_IDLE_TIMEOUT_MS || 30000),
      connectionTimeoutMillis: Number(rawEnv.PG_CONNECT_TIMEOUT_MS || 15000)
    });
    const compatDb = createPostgresCompatDb(pool);

    return {
      provider: 'postgres',
      db: compatDb,
      rtreeState: { supported: false, ready: false, rebuilding: false },
      scheduleBuildingContoursRtreeRebuild: () => {},
      close: async () => {
        await pool.end();
      }
    };
  }

  const Database = require('better-sqlite3');
  const {
    db,
    rtreeState,
    scheduleBuildingContoursRtreeRebuild
  } = initDbBootstrapInfra({
    Database,
    dbPath: sqlite.dbPath,
    osmDbPath: sqlite.osmDbPath,
    localEditsDbPath: sqlite.localEditsDbPath,
    userEditsDbPath: sqlite.userEditsDbPath,
    userAuthDbPath: sqlite.userAuthDbPath,
    ensureAuthSchema: sqlite.ensureAuthSchema,
    rtreeRebuildBatchSize: sqlite.rtreeRebuildBatchSize,
    rtreeRebuildPauseMs: sqlite.rtreeRebuildPauseMs,
    migrationsDir: sqlite.migrationsDir || path.join(__dirname, '..', '..', '..', '..', 'db', 'migrations'),
    isSyncInProgress: sqlite.isSyncInProgress,
    logger
  });

  const compatDb = createSqliteCompatDb(db);

  return {
    provider: 'sqlite',
    db: compatDb,
    rtreeState,
    scheduleBuildingContoursRtreeRebuild,
    close: async () => {
      try {
        db.close();
      } catch {
        // ignore close failures during shutdown
      }
    }
  };
}

module.exports = {
  createDbRuntime,
  resolvePostgresConnectionString,
  _test_: {
    replaceSqlitePositionalPlaceholders,
    convertNamedParams,
    convertPositionalParams,
    createPostgresCompatDb
  }
};
