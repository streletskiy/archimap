const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { Client } = require('pg');

const DEFAULT_STAGE_TABLE = 'region_import_stage';
const DEFAULT_OSM2PGSQL_BIN = String(process.env.OSM2PGSQL_BIN || 'osm2pgsql').trim() || 'osm2pgsql';
const DEFAULT_OSM2PGSQL_CONTAINER = 'archimap-osm2pgsql';
const FLEX_CONFIG_PATH = path.resolve(__dirname, 'osm2pgsql-flex.lua');
const CONTAINER_DATA_ROOT = '/data';
const HOST_DATA_ROOT = '/app/data';
const CONTAINER_FLEX_CONFIG_PATH = '/tmp/archimap-osm2pgsql-flex.lua';

function toContainerPath(hostPath) {
  const normalizedPath = String(hostPath || '').replace(/\\/g, '/');
  if (normalizedPath.startsWith(HOST_DATA_ROOT + '/') || normalizedPath === HOST_DATA_ROOT) {
    return CONTAINER_DATA_ROOT + normalizedPath.slice(HOST_DATA_ROOT.length);
  }
  return normalizedPath;
}

function quoteIdentifier(value) {
  const text = String(value || '').trim();
  if (!/^[a-z_][a-z0-9_]*$/i.test(text)) {
    throw new Error(`Invalid PostgreSQL identifier: ${text || '<empty>'}`);
  }
  return `"${text.replace(/"/g, '""')}"`;
}

function resolveOsm2pgsqlBin(env: LooseRecord = process.env) {
  return String(env.OSM2PGSQL_BIN || DEFAULT_OSM2PGSQL_BIN).trim() || DEFAULT_OSM2PGSQL_BIN;
}

function detectOsm2pgsqlNative(env: LooseRecord = process.env) {
  const bin = resolveOsm2pgsqlBin(env);
  const probe = spawnSync(bin, ['--version'], { stdio: 'pipe', shell: false });
  if (probe.status === 0 && !probe.error) return bin;
  return null;
}

function detectOsm2pgsqlContainer(env: LooseRecord = process.env) {
  const container = String(env.OSM2PGSQL_CONTAINER || DEFAULT_OSM2PGSQL_CONTAINER).trim();
  if (!container) return null;
  const probe = spawnSync('docker', ['exec', container, 'osm2pgsql', '--version'], { stdio: 'pipe', shell: false });
  if (probe.status === 0 && !probe.error) return container;
  return null;
}

function ensureOsm2pgsqlContainerFlexConfig(
  containerName: string,
  env: LooseRecord = process.env,
  spawnSyncRef = spawnSync
) {
  const copyResult = spawnSyncRef(
    'docker',
    ['cp', FLEX_CONFIG_PATH, `${containerName}:${CONTAINER_FLEX_CONFIG_PATH}`],
    {
      stdio: 'pipe',
      shell: false,
      env
    }
  );
  if (copyResult.error) {
    throw copyResult.error;
  }
  if ((copyResult.status ?? 1) !== 0) {
    const stdout = String(copyResult.stdout || '').trim();
    const stderr = String(copyResult.stderr || '').trim();
    const detail = [stdout, stderr].filter(Boolean).join('\n');
    throw new Error(
      `Failed to copy osm2pgsql flex config into container "${containerName}"${
        detail ? `:\n${detail}` : ''
      }`
    );
  }
  return CONTAINER_FLEX_CONFIG_PATH;
}

function resolveOsm2pgsqlJobs(env: LooseRecord = process.env) {
  const explicit = Number(env.REGION_SYNC_OSM2PGSQL_JOBS);
  if (Number.isInteger(explicit) && explicit > 0) return explicit;
  return Math.max(1, Math.min(8, os.cpus()?.length || 1));
}

function resolveOsm2pgsqlCacheMb(env: LooseRecord = process.env) {
  const explicit = Number(env.REGION_SYNC_OSM2PGSQL_CACHE_MB);
  if (Number.isInteger(explicit) && explicit > 0) return explicit;
  return 1024;
}

function buildOsm2pgsqlArgs({
  databaseUrl,
  pbfPath,
  stageSchema,
  flexConfigPath,
  jobs,
  cacheMb
}: {
  databaseUrl: string;
  pbfPath: string;
  stageSchema: string;
  flexConfigPath: string;
  jobs: number;
  cacheMb: number;
}) {
  return [
    '--create',
    '--slim',
    '--drop',
    '-O',
    'flex',
    '-S',
    flexConfigPath,
    '--middle-schema',
    stageSchema,
    '-d',
    databaseUrl,
    '--number-processes',
    String(jobs),
    '-C',
    String(cacheMb),
    String(pbfPath)
  ];
}

function buildStageSchemaName(region, _env: LooseRecord = process.env) {
  const regionId = Number(region?.id || 0);
  const suffix = `${Date.now().toString(36)}${Math.round(Math.random() * 0xffffff)
    .toString(36)
    .padStart(4, '0')}`;
  return `region_sync_stage_r${Number.isInteger(regionId) && regionId > 0 ? regionId : 'x'}_${suffix}`.replace(
    /[^a-z0-9_]+/gi,
    '_'
  );
}

async function createStageSchema(databaseUrl, stageSchema) {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query(`CREATE SCHEMA IF NOT EXISTS ${quoteIdentifier(stageSchema)}`);
  } finally {
    await client.end();
  }
}

async function dropStageSchema(databaseUrl, stageSchema) {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(stageSchema)} CASCADE`);
  } finally {
    await client.end();
  }
}

function resolveDatabaseUrlForContainer(databaseUrl) {
  // Inside docker compose, osm2pgsql sidecar uses the same network.
  // The DATABASE_URL from archimap already uses the docker service hostname (db-postgres).
  return databaseUrl;
}

async function importPbfToPostgresStage({
  region,
  databaseUrl,
  pbfPath,
  stageSchema = null,
  stageTable = DEFAULT_STAGE_TABLE,
  env = process.env,
  onStage = null
}: LooseRecord) {
  const schemaName = String(stageSchema || buildStageSchemaName(region, env)).trim();
  const tableName = String(stageTable || DEFAULT_STAGE_TABLE).trim() || DEFAULT_STAGE_TABLE;
  const jobs = resolveOsm2pgsqlJobs(env);
  const cacheMb = resolveOsm2pgsqlCacheMb(env);

  if (typeof onStage === 'function') {
    await onStage('extract', `importing ${path.basename(String(pbfPath || 'source.osm.pbf'))} with osm2pgsql`);
  }

  // Decide: native binary or container sidecar
  const nativeBin = detectOsm2pgsqlNative(env);
  const containerName = nativeBin ? null : detectOsm2pgsqlContainer(env);

  if (!nativeBin && !containerName) {
    throw new Error(
      'osm2pgsql is not available. Install osm2pgsql, set OSM2PGSQL_BIN, or ensure the osm2pgsql sidecar container is running.'
    );
  }

  await createStageSchema(databaseUrl, schemaName);
  try {
    const stageEnv = {
      OSM2PGSQL_STAGE_TABLE: tableName,
      OSM2PGSQL_OUTPUT_SCHEMA: schemaName
    };

    if (containerName) {
      // Docker exec on the sidecar container
      const containerPbfPath = toContainerPath(String(pbfPath));
      const containerDbUrl = resolveDatabaseUrlForContainer(databaseUrl);
      const containerFlexConfigPath = ensureOsm2pgsqlContainerFlexConfig(containerName, env);

      const osm2pgsqlArgs = buildOsm2pgsqlArgs({
        databaseUrl: containerDbUrl,
        pbfPath: containerPbfPath,
        stageSchema: schemaName,
        flexConfigPath: containerFlexConfigPath,
        jobs,
        cacheMb
      });

      const dockerArgs = [
        'exec',
        '-e', `OSM2PGSQL_STAGE_TABLE=${tableName}`,
        '-e', `OSM2PGSQL_OUTPUT_SCHEMA=${schemaName}`,
        containerName,
        'osm2pgsql',
        ...osm2pgsqlArgs
      ];

      const result = spawnSync('docker', dockerArgs, {
        stdio: 'inherit',
        shell: false,
        env
      });
      if (result.error) {
        throw result.error;
      }
      if ((result.status ?? 1) !== 0) {
        throw new Error(`osm2pgsql (container) failed with exit code ${result.status ?? 1}`);
      }
    } else {
      // Native execution
      const args = buildOsm2pgsqlArgs({
        databaseUrl,
        pbfPath: String(pbfPath),
        stageSchema: schemaName,
        flexConfigPath: FLEX_CONFIG_PATH,
        jobs,
        cacheMb
      });

      const result = spawnSync(nativeBin, args, {
        stdio: 'inherit',
        shell: false,
        env: {
          ...env,
          ...stageEnv
        }
      });
      if (result.error) {
        throw result.error;
      }
      if ((result.status ?? 1) !== 0) {
        throw new Error(`osm2pgsql failed with exit code ${result.status ?? 1}`);
      }
    }

    return {
      stageSchema: schemaName,
      stageTable: tableName
    };
  } catch (error) {
    try {
      await dropStageSchema(databaseUrl, schemaName);
    } catch {
      // ignore best-effort stage cleanup on failure
    }
    throw error;
  }
}

module.exports = {
  DEFAULT_STAGE_TABLE,
  FLEX_CONFIG_PATH,
  buildStageSchemaName,
  buildOsm2pgsqlArgs,
  ensureOsm2pgsqlContainerFlexConfig,
  dropStageSchema,
  importPbfToPostgresStage,
  resolveOsm2pgsqlBin
};
