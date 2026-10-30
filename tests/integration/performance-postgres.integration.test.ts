const test = require('node:test');
const assert = require('node:assert/strict');
const { Client } = require('pg');
const { createDbRuntime } = require('../../src/lib/server/infra/db-runtime.infra');
const { createBuildingFiltersService } = require('../../src/lib/server/services/building-filters.service');

test('PostgreSQL: 20k-building floor filters preserve overrides within a latency budget during writes', { skip: !process.env.PERF_DATABASE_URL, timeout: 120000 }, async () => {
  const admin = new Client({ connectionString: process.env.PERF_DATABASE_URL });
  await admin.connect();
  const databaseName = `archimap_perf_${process.pid}_${Date.now()}`;
  const url = new URL(process.env.PERF_DATABASE_URL); url.pathname = `/${databaseName}`;
  let runtime;
  try {
    await admin.query(`CREATE DATABASE "${databaseName}"`);
    runtime = await createDbRuntime({ runtimeEnv: { dbProvider: 'postgres', databaseUrl: url.toString() }, rawEnv: { PG_STATEMENT_TIMEOUT_MS: '10000' } });
    const db = runtime.db;
    await db.exec(`INSERT INTO osm.building_contours(osm_type,osm_id,tags_json,geom,min_lon,min_lat,max_lon,max_lat)
      SELECT 'way',n,json_build_object('building:levels',(n%30+1)::text)::text,
        ST_MakeEnvelope(44+(n%200)*0.001,56+(n/200)*0.001,44+(n%200)*0.001+0.0002,56+(n/200)*0.001+0.0002,4326),
        44+(n%200)*0.001,56+(n/200)*0.001,44+(n%200)*0.001+0.0002,56+(n/200)*0.001+0.0002
      FROM generate_series(1,20000) n`);
    await db.exec("INSERT INTO local.architectural_info(osm_type,osm_id,levels) VALUES ('way',1,99)");
    await db.exec('ANALYZE osm.building_contours');
    const service = createBuildingFiltersService({ db, applyPersonalEditsToFilterItems: async (items) => items });
    const samples = [];
    let body;
    for (let i = 0; i < 4; i++) {
      body = { bbox: { west: 43.9-i*0.001, south: 55.9, east: 44.3, north: 56.3 }, includeLocations: false, requests: [
        { id: 'all', rules: [{ key: 'building:levels', op: 'greater_or_equals', value: '1' }], maxResults: 20000 },
        { id: 'override', rules: [{ key: 'building:levels', op: 'equals', value: '99' }], maxResults: 10 }
      ] };
      const started = performance.now();
      const [result] = await Promise.all([service.getBatchFilterMatches(body), db.exec('UPDATE osm.building_contours SET updated_at=now() WHERE osm_id BETWEEN 100 AND 1000')]);
      samples.push(performance.now()-started);
      assert.equal(result.payload.items[0].matchedKeys.length,20000);
      assert.deepEqual(result.payload.items[1].matchedKeys,['way/1']);
      assert.equal(result.payload.items[0].meta.truncated,false);
    }
    const warm = performance.now();
    assert.equal((await service.getBatchFilterMatches(body)).payload.meta.cacheHit,true);
    const cachedMs = performance.now()-warm;
    const slowest = Math.max(...samples);
    console.log(JSON.stringify({ fixtureBuildings: 20000, coldMaxMs: Math.round(slowest), cachedMs: Math.round(cachedMs), concurrentWrites: true }));
    assert.ok(slowest < 5000, `20k filter exceeded 5s budget: ${slowest}ms`);
    assert.ok(cachedMs < 250, `Cached filter exceeded 250ms budget: ${cachedMs}ms`);
  } finally {
    await runtime?.close();
    if (/^archimap_perf_\d+_\d+$/.test(databaseName)) await admin.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
    await admin.end();
  }
});
