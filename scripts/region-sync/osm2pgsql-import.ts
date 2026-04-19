const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { Client } = require('pg');

const DEFAULT_STAGE_TABLE = 'region_import_stage';
const DEFAULT_OSM2PGSQL_BIN = String(process.env.OSM2PGSQL_BIN || 'osm2pgsql').trim() || 'osm2pgsql';
const FLEX_CONFIG_PATH = path.resolve(__dirname, 'osm2pgsql-flex.lua');

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
  jobs,
  cacheMb
}: {
  databaseUrl: string;
  pbfPath: string;
  stageSchema: string;
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
    FLEX_CONFIG_PATH,
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

function buildStageSchemaName(region, env: LooseRecord = process.env) {
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
  const osm2pgsqlBin = resolveOsm2pgsqlBin(env);
  const jobs = resolveOsm2pgsqlJobs(env);
  const cacheMb = resolveOsm2pgsqlCacheMb(env);

  if (typeof onStage === 'function') {
    await onStage('extract', `importing ${path.basename(String(pbfPath || 'source.osm.pbf'))} with osm2pgsql`);
  }

  await createStageSchema(databaseUrl, schemaName);
  try {
    const args = buildOsm2pgsqlArgs({
      databaseUrl,
      pbfPath: String(pbfPath),
      stageSchema: schemaName,
      jobs,
      cacheMb
    });

    const result = spawnSync(osm2pgsqlBin, args, {
      stdio: 'inherit',
      shell: false,
      env: {
        ...env,
        OSM2PGSQL_STAGE_TABLE: tableName,
        OSM2PGSQL_OUTPUT_SCHEMA: schemaName
      }
    });
    if (result.error) {
      throw result.error;
    }
    if ((result.status ?? 1) !== 0) {
      throw new Error(`osm2pgsql failed with exit code ${result.status ?? 1}`);
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
  dropStageSchema,
  importPbfToPostgresStage,
  resolveOsm2pgsqlBin
};
