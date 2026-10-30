require('dotenv').config({ quiet: true });
const { Client } = require('pg');
const { resolvePostgresConnectionString } = require('../src/lib/server/infra/db-runtime.infra');

function stageCreatedAt(name) {
  const match = /^region_sync_stage_r\d+_([a-z0-9]{8})[a-z0-9]{4,5}$/.exec(name);
  if (!match) return null;
  const timestamp = parseInt(match[1], 36);
  return timestamp >= Date.UTC(2020, 0, 1) && timestamp <= Date.now() ? timestamp : null;
}

async function maintain({ apply = false, analyze = false, retentionDays = 30, staleHours = 24, client }) {
  const report = { apply, droppedSchemas: 0, reclaimedBytes: 0, archivedRuns: 0, candidates: 0, activeSync: false };
  const lock = await client.query('SELECT pg_try_advisory_lock(814217, 900) AS locked');
  if (!lock.rows[0]?.locked) throw new Error('Maintenance is already running');
  try {
    await client.query("SET lock_timeout = '1s'");
    await client.query("SET statement_timeout = '20s'");
    const active = await client.query("SELECT DISTINCT region_id FROM public.data_region_sync_runs WHERE status IN ('queued', 'running')");
    report.activeSync = active.rowCount > 0;
    const activeRegions = new Set(active.rows.map((row) => Number(row.region_id)));
    const schemas = await client.query(`SELECT n.nspname AS name, COALESCE(sum(pg_total_relation_size(c.oid)),0)::bigint AS bytes
      FROM pg_namespace n LEFT JOIN pg_class c ON c.relnamespace=n.oid AND c.relkind='r'
      WHERE n.nspname LIKE 'region_sync_stage_%' GROUP BY n.nspname`);
    for (const schema of schemas.rows) {
      const created = stageCreatedAt(schema.name);
      if (!created || Date.now() - created < Math.max(24, staleHours) * 3600000) continue;
      report.candidates++;
      const regionId = Number(/^region_sync_stage_r(\d+)_/.exec(schema.name)?.[1]);
      if (apply && !activeRegions.has(regionId)) {
        await client.query(`DROP SCHEMA "${schema.name}" CASCADE`);
        report.droppedSchemas++; report.reclaimedBytes += Number(schema.bytes);
      }
    }
    if (apply) {
      for (let batch = 0; batch < 200; batch++) {
        const result = await client.query(`WITH keep AS (
          SELECT DISTINCT ON (region_id) id FROM public.data_region_sync_runs
          WHERE status='success' ORDER BY region_id,id DESC
        ), candidates AS (
          SELECT r.id FROM public.data_region_sync_runs r
          WHERE r.status IN ('success','failed','abandoned') AND r.created_at < now()-($1::int * interval '1 day')
            AND r.id NOT IN (SELECT id FROM keep)
            AND NOT EXISTS (SELECT 1 FROM public.data_region_sync_runs child WHERE child.parent_run_id=r.id)
          ORDER BY r.id LIMIT 5000
        ), deleted AS (
          DELETE FROM public.data_region_sync_runs WHERE id IN (SELECT id FROM candidates)
          RETURNING region_id,status,created_at,started_at,finished_at
        ), archived AS (
          INSERT INTO public.data_region_sync_daily(day,region_id,status,run_count,duration_seconds)
          SELECT (created_at AT TIME ZONE 'UTC')::date,region_id,status,count(*),
            sum(greatest(0,coalesce(extract(epoch FROM finished_at-started_at),0))) FROM deleted GROUP BY 1,2,3
          ON CONFLICT(day,region_id,status) DO UPDATE SET
            run_count=data_region_sync_daily.run_count+EXCLUDED.run_count,
            duration_seconds=data_region_sync_daily.duration_seconds+EXCLUDED.duration_seconds
        ) SELECT count(*)::int AS count FROM deleted`, [Math.max(7, retentionDays)]);
        const count = Number(result.rows[0].count); report.archivedRuns += count;
        if (!count) break;
      }
      await client.query('VACUUM (ANALYZE) public.data_region_sync_runs');
      if (analyze) {
        await client.query("SET statement_timeout = '15min'");
        await client.query('VACUUM (ANALYZE) osm.building_contours');
        await client.query('VACUUM (ANALYZE) public.data_region_memberships');
      }
    }
    return report;
  } finally { await client.query('SELECT pg_advisory_unlock(814217, 900)'); }
}

async function main() {
  const client = new Client({ connectionString: resolvePostgresConnectionString({}, process.env), application_name: 'archimap-maintenance' });
  await client.connect();
  try { console.log(JSON.stringify(await maintain({ client, apply: process.argv.includes('--apply'), analyze: process.argv.includes('--analyze') }))); }
  finally { await client.end(); }
}
if (require.main === module) main().catch((error) => { console.error('Maintenance failed:', error.message); process.exitCode = 1; });
module.exports = { stageCreatedAt, maintain };
