const test = require('node:test');
const assert = require('node:assert/strict');
const { Client } = require('pg');
const { createDbRuntime } = require('../../src/lib/server/infra/db-runtime.infra');
const { rebuildPostgresSearchIndex, refreshPostgresSearchChanges } = require('../../src/lib/server/services/search-index-postgres.service');
const { createSearchIndexRefreshService } = require('../../src/lib/server/services/search-index-refresh.service');

test('PostgreSQL search publication, durable changes, all tags and exact tag counts', {
  skip: !process.env.SEARCH_TEST_DATABASE_URL, timeout: 120000
}, async () => {
  const admin = new Client({ connectionString: process.env.SEARCH_TEST_DATABASE_URL });
  await admin.connect();
  const name = `archimap_search_test_${process.pid}_${Date.now()}`;
  const url = new URL(process.env.SEARCH_TEST_DATABASE_URL);
  url.pathname = `/${name}`;
  let runtime;
  let retryChild = null;
  const worker = new Client({ connectionString: url.toString() });
  const reader = new Client({ connectionString: url.toString() });
  try {
    await admin.query(`CREATE DATABASE "${name}"`);
    runtime = await createDbRuntime({ runtimeEnv: { dbProvider: 'postgres', databaseUrl: url.toString() }, rawEnv: {} });
    await worker.connect(); await reader.connect();
    const insert = async (id, tags) => reader.query(`INSERT INTO osm.building_contours
      (osm_type,osm_id,tags_json,geom,min_lon,min_lat,max_lon,max_lat)
      VALUES ('way',$1,$2,ST_Multi(ST_MakeEnvelope(44,56,44.001,56.001,4326)),44,56,44.001,56.001)`, [id, JSON.stringify(tags)]);
    const matches = async (value) => (await reader.query(`SELECT osm_id::integer FROM public.building_search_source
      WHERE search_tsv @@ plainto_tsquery('simple',$1) ORDER BY osm_id`, [value])).rows.map((row) => row.osm_id);
    await insert(1, { building: 'yes', name: 'oldname', 'name:en': 'oldalias', 'custom:art': 'fresco', ' rare ': 'x', rare: 'y' });
    await insert(2, { 'building:part': 'yes', name: 'partonly' });
    await insert(3, { building: 'yes', 'building:part': 'yes', name: 'mixedbuilding' });
    await insert(4, { building: 'yes', 'custom:art': 'rarevalue' });
    await reader.query("INSERT INTO local.architectural_info(osm_type,osm_id,name) VALUES ('way',1,'renamed')");
    await rebuildPostgresSearchIndex(worker);
    assert.deepEqual(await matches('fresco'), [1]);
    assert.deepEqual(await matches('rarevalue'), [4]);
    assert.deepEqual(await matches('renamed'), [1]);
    assert.deepEqual(await matches('oldname'), []);
    assert.deepEqual(await matches('oldalias'), []);
    assert.deepEqual(await matches('partonly'), []);
    assert.deepEqual(await matches('mixedbuilding'), [3]);
    assert.equal(Number((await reader.query("SELECT feature_count FROM filter_tag_key_counts WHERE tag_key='rare'")).rows[0].feature_count), 1);
    assert.equal((await reader.query("SELECT tags_json FROM osm.building_contours WHERE osm_id=1")).rows[0].tags_json.includes('oldname'), true);
    const untouched = (await reader.query('SELECT updated_at FROM building_search_source WHERE osm_id=1')).rows[0].updated_at;
    await reader.query("UPDATE osm.building_contours SET tags_json='{" + '"building":"yes","custom:new":"newvalue"' + "}' WHERE osm_id=4");
    await reader.query('DELETE FROM osm.building_contours WHERE osm_id=3');
    assert.equal(await refreshPostgresSearchChanges(worker), 2);
    assert.deepEqual(await matches('rarevalue'), []);
    assert.deepEqual(await matches('newvalue'), [4]);
    assert.deepEqual(await matches('mixedbuilding'), []);
    assert.equal((await reader.query('SELECT updated_at FROM building_search_source WHERE osm_id=1')).rows[0].updated_at.getTime(), untouched.getTime());
    await rebuildPostgresSearchIndex(worker, { afterBuild: async () => {
      assert.deepEqual(await matches('renamed'), [1], 'old published table remains available during build');
      await reader.query("UPDATE local.architectural_info SET name='newest' WHERE osm_id=1");
    } });
    assert.deepEqual(await matches('newest'), [1], 'concurrent public edit is replayed after publication');
    assert.deepEqual(await matches('renamed'), []);
    await assert.rejects(rebuildPostgresSearchIndex(worker, { afterBuild: async () => {
      await reader.query("UPDATE local.architectural_info SET name='survivesfailure' WHERE osm_id=1");
      throw new Error('simulated rebuild failure');
    } }), /simulated rebuild failure/);
    assert.deepEqual(await matches('newest'), [1], 'failed build leaves published table intact');
    const failingClient = { query: async (sql, params) => {
      if (String(sql).startsWith('DELETE FROM public.building_data_changes pending')) throw new Error('simulated ack failure');
      return worker.query(sql, params);
    } };
    await assert.rejects(refreshPostgresSearchChanges(failingClient), /simulated ack failure/);
    assert.deepEqual(await matches('newest'), [1], 'failed acknowledgement rolls back the search update too');
    assert.equal(Number((await reader.query('SELECT count(*) FROM building_data_changes')).rows[0].count), 1);
    await refreshPostgresSearchChanges(worker);
    assert.deepEqual(await matches('survivesfailure'), [1]);
    await reader.query("UPDATE local.architectural_info SET material='granite' WHERE osm_id=1");
    await createSearchIndexRefreshService({ db: runtime.db }).refreshSearchIndexForBuilding('way', 1);
    assert.deepEqual(await matches('granite'), [1], 'direct public edit refresh uses the same all-tag projection');
    assert.equal(Number((await reader.query('SELECT count(*) FROM building_data_changes')).rows[0].count), 0);
    await reader.query('DELETE FROM osm.building_contours WHERE osm_id=1');
    assert.equal((await reader.query("SELECT 1 FROM filter_tag_keys_cache WHERE tag_key='rare'")).rowCount, 0);
    assert.equal((await reader.query("SELECT 1 FROM filter_tag_key_counts WHERE tag_key='rare'")).rowCount, 0);
    assert.equal(await refreshPostgresSearchChanges(worker), 1);
    assert.deepEqual(await matches('survivesfailure'), []);
    assert.equal(await refreshPostgresSearchChanges(worker), 0);
    // Repair an upgrade-window mismatch while concurrent canonical writes wait.
    await reader.query('UPDATE filter_tag_key_counts SET feature_count = feature_count + 100');
    await worker.query('BEGIN');
    const reconcileSql = require('fs').readFileSync(require('path').join(__dirname, '../../db/postgres/migrations/039_reconcile_filter_tag_counts.sql'), 'utf8');
    await worker.query(reconcileSql);
    await reader.query("SET lock_timeout = '100ms'");
    await assert.rejects(insert(5, { building: 'yes', repairconcurrent: 'value' }), (error) => error.code === '55P03');
    await worker.query('COMMIT');
    await reader.query("SET lock_timeout = '5s'");
    await insert(5, { building: 'yes', repairconcurrent: 'value' });
    const mismatches = await reader.query(`WITH actual AS (
      SELECT key AS tag_key, count(*) AS feature_count FROM osm.building_contours bc
      CROSS JOIN LATERAL unnest(public.archimap_filter_tag_keys(bc.tags_json)) key GROUP BY key
    ) SELECT * FROM ((SELECT * FROM actual EXCEPT SELECT * FROM filter_tag_key_counts)
      UNION ALL (SELECT * FROM filter_tag_key_counts EXCEPT SELECT * FROM actual)) differences`);
    assert.equal(mismatches.rowCount, 0, 'reconciliation and subsequent trigger deltas have exact counts');
    assert.equal((await reader.query("SELECT 1 FROM filter_tag_keys_cache WHERE tag_key='repairconcurrent'")).rowCount, 1);
    // Oldest generation order is deliberately the reverse of import key order.
    await refreshPostgresSearchChanges(worker);
    await insert(6, { building: 'yes', lockorder: 'first' });
    await insert(7, { building: 'yes', lockorder: 'second' });
    await reader.query("UPDATE osm.building_contours SET tags_json='{" + '"building":"yes","lockorder":"requeued"' + "}' WHERE osm_id=6");
    await reader.query('BEGIN');
    await reader.query("UPDATE building_data_changes SET generation=nextval('building_data_change_generation_seq') WHERE osm_id=6");
    const concurrentDrain = refreshPostgresSearchChanges(worker);
    concurrentDrain.catch(() => {});
    try {
      const deadline = Date.now() + 3000;
      while (true) {
        const blocked = await reader.query('SELECT cardinality(pg_blocking_pids($1)) > 0 AS blocked', [worker.processID]);
        if (blocked.rows[0].blocked) break;
        assert.ok(Date.now() < deadline, 'consumer must wait for the earlier key');
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      // A consumer holding key 7 before waiting for 6 would deadlock here.
      await reader.query("UPDATE building_data_changes SET generation=nextval('building_data_change_generation_seq') WHERE osm_id=7");
      await reader.query('COMMIT');
      assert.equal(await concurrentDrain, 2);
      assert.equal(Number((await reader.query('SELECT count(*) FROM building_data_changes')).rows[0].count), 0);
    } catch (error) {
      await reader.query('ROLLBACK');
      await concurrentDrain.catch(() => {});
      throw error;
    }
    // A background slice commits only its budget and leaves both the untouched
    // objects and a newer generation of an already consumed object durable.
    await insert(80, { building: 'yes', slicetest: 'firstslicevalue' });
    await insert(81, { building: 'yes', slicetest: 'secondslicevalue' });
    await insert(82, { building: 'yes', slicetest: 'thirdslicevalue' });
    assert.equal(await refreshPostgresSearchChanges(worker, {
      batchSize: 1, maxBatches: 1,
      onBatch: () => reader.query('UPDATE osm.building_contours SET tags_json=$1 WHERE osm_id=80',
        [JSON.stringify({ building: 'yes', slicetest: 'newerslicevalue' })])
    }), 1);
    assert.deepEqual(await matches('firstslicevalue'), [80]);
    assert.deepEqual(await matches('newerslicevalue'), []);
    assert.equal(Number((await reader.query('SELECT count(*) FROM building_data_changes')).rows[0].count), 3);
    await reader.query('SELECT pg_advisory_lock(87423619)');
    try {
      await worker.query("SET statement_timeout = '250ms'");
      assert.equal(await refreshPostgresSearchChanges(worker, { maxBatches: 1, waitForLock: false }), 0,
        'a busy background consumer yields without waiting for the publisher lock');
      assert.equal(Number((await worker.query('SELECT count(*) FROM building_data_changes')).rows[0].count), 3);
    } finally {
      await worker.query('SET statement_timeout = 0');
      await reader.query('SELECT pg_advisory_unlock(87423619)');
    }
    assert.equal(await refreshPostgresSearchChanges(worker, { batchSize: 1, maxBatches: 2 }), 2);
    assert.equal(Number((await reader.query('SELECT count(*) FROM building_data_changes')).rows[0].count), 1);
    assert.equal(await refreshPostgresSearchChanges(worker), 1);
    assert.deepEqual(await matches('newerslicevalue'), [80]);
    assert.deepEqual(await matches('firstslicevalue'), []);

    // A regional transaction can hold some queue rows while other committed
    // changes are ready. Background slices leave its generations untouched.
    await insert(90, { building: 'yes', rowlocktest: 'lockedchange' });
    await insert(91, { building: 'yes', rowlocktest: 'availablechange' });
    await reader.query('BEGIN');
    await reader.query("UPDATE building_data_changes SET generation=nextval('building_data_change_generation_seq') WHERE osm_id=90");
    try {
      await worker.query("SET statement_timeout = '500ms'");
      assert.equal(await refreshPostgresSearchChanges(worker, { batchSize: 2, maxBatches: 1, waitForLock: false }), 1);
      assert.deepEqual(await matches('availablechange'), [91]);
      assert.deepEqual(await matches('lockedchange'), []);
      assert.equal(Number((await worker.query('SELECT count(*) FROM building_data_changes')).rows[0].count), 1);
    } finally {
      await worker.query('SET statement_timeout = 0');
      await reader.query('COMMIT');
    }
    assert.equal(await refreshPostgresSearchChanges(worker, { maxBatches: 1, waitForLock: false }), 1);
    assert.deepEqual(await matches('lockedchange'), [90]);

    // A long-lived worker must discover durable imports without an IPC edit or
    // the regional queue becoming idle, and must survive a busy publisher.
    await reader.query("UPDATE local.architectural_info SET material='retryvalue' WHERE osm_id=1");
    await insert(8, { building: 'yes', startupretry: 'recovered' });
    await worker.query('SELECT pg_advisory_lock(87423619)');
    retryChild = require('child_process').spawn(process.execPath, ['--import', 'tsx', 'workers/refresh-search-index.worker.ts'], {
      cwd: require('path').join(__dirname, '../..'), windowsHide: true,
      env: { ...process.env, DB_PROVIDER: 'postgres', DATABASE_URL: url.toString() },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc']
    });
    const yielded = new Promise<void>((resolve) => retryChild.on('message', (message) => {
      if (message?.type === 'drained' && message.processed === 0) resolve();
    }));
    const recovered = new Promise<void>((resolve) => retryChild.on('message', (message) => {
      if (message?.type === 'drained' && message.processed > 0) resolve();
    }));
    const bounded = async (promise) => {
      let timeout;
      try { await Promise.race([promise, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('worker recovery timed out')), 10000); })]); }
      finally { clearTimeout(timeout); }
    };
    await bounded(yielded);
    await worker.query('SELECT pg_advisory_unlock(87423619)');
    await bounded(recovered);
    assert.deepEqual(await matches('recovered'), [8]);
    assert.equal(Number((await reader.query('SELECT count(*) FROM building_data_changes')).rows[0].count), 0);
    const nextDrain = new Promise<void>((resolve) => retryChild.on('message', (message) => {
      if (message?.type === 'drained' && message.processed > 0) resolve();
    }));
    await insert(9, { building: 'yes', periodicimport: 'discoveredwithoutwake' });
    await bounded(nextDrain);
    assert.deepEqual(await matches('discoveredwithoutwake'), [9]);
    assert.equal(Number((await reader.query('SELECT count(*) FROM building_data_changes')).rows[0].count), 0);
  } finally {
    if (retryChild && retryChild.exitCode === null && retryChild.signalCode === null) {
      const exited = new Promise((resolve) => retryChild.once('exit', resolve));
      retryChild.kill('SIGTERM');
      await exited;
    }
    await worker.end(); await reader.end(); await runtime?.close();
    if (/^archimap_search_test_\d+_\d+$/.test(name)) await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await admin.end();
  }
});
