const test = require('node:test');
const assert = require('node:assert/strict');
const { Client } = require('pg');
const { createDbRuntime } = require('../../src/lib/server/infra/db-runtime.infra');
const { SEARCH_INDEX_LOCK, refreshPostgresSearchChanges, reclaimEmptyPostgresSearchQueue } = require('../../src/lib/server/services/search-index-postgres.service');

test('empty search queue reclaims disk without waiting for or losing concurrent writers', {
  skip: !process.env.SEARCH_TEST_DATABASE_URL, timeout: 120000
}, async () => {
  const admin = new Client({ connectionString: process.env.SEARCH_TEST_DATABASE_URL });
  await admin.connect();
  const name = `archimap_search_queue_test_${process.pid}_${Date.now()}`;
  const url = new URL(process.env.SEARCH_TEST_DATABASE_URL); url.pathname = `/${name}`;
  const worker = new Client({ connectionString: url.toString() });
  const writer = new Client({ connectionString: url.toString() });
  let runtime;
  const begin = async () => {
    await worker.query('BEGIN ISOLATION LEVEL READ COMMITTED');
    await worker.query('SELECT pg_advisory_xact_lock($1)', [SEARCH_INDEX_LOCK]);
  };
  const enqueue = async (id) => writer.query(`INSERT INTO building_data_changes(osm_type,osm_id)
    VALUES ('way',$1) RETURNING generation`, [id]);
  try {
    await admin.query(`CREATE DATABASE "${name}"`);
    runtime = await createDbRuntime({ runtimeEnv: { dbProvider: 'postgres', databaseUrl: url.toString() }, rawEnv: {} });
    await worker.connect(); await writer.connect();
    await worker.query('ALTER TABLE building_data_changes SET (autovacuum_enabled=false)');
    await worker.query(`INSERT INTO building_data_changes(osm_type,osm_id)
      SELECT 'way', id FROM generate_series(1000000,1250000) id`);
    await worker.query('DELETE FROM building_data_changes');
    const bytes = async () => Number((await worker.query("SELECT pg_total_relation_size('building_data_changes') AS bytes")).rows[0].bytes);
    const before = await bytes();
    assert.ok(before > 16 * 1024 * 1024, 'fixture retains more than the production reclamation threshold');
    const lastGeneration = BigInt((await worker.query('SELECT last_value FROM building_data_change_generation_seq')).rows[0].last_value);
    assert.equal(await refreshPostgresSearchChanges(worker), 0);
    const after = await bytes();
    assert.ok(after < 1024 * 1024, `empty queue should release its storage: ${before} -> ${after}`);
    assert.equal(BigInt((await worker.query('SELECT last_value FROM building_data_change_generation_seq')).rows[0].last_value), lastGeneration);

    await enqueue(1);
    await begin();
    assert.equal(await reclaimEmptyPostgresSearchQueue(worker, { minBytes: 0 }), false, 'never truncate a nonempty queue');
    await worker.query('COMMIT');
    assert.equal(Number((await writer.query('SELECT count(*) FROM building_data_changes')).rows[0].count), 1);
    await writer.query('DELETE FROM building_data_changes');

    // A writer that already holds the queue lock makes compaction skip, not wait.
    await writer.query('BEGIN');
    await enqueue(2);
    await begin();
    await worker.query("SET LOCAL statement_timeout = '1s'");
    assert.equal(await reclaimEmptyPostgresSearchQueue(worker, { minBytes: 0 }), false);
    await worker.query('COMMIT');
    await writer.query('COMMIT');
    assert.equal(Number((await writer.query('SELECT osm_id FROM building_data_changes')).rows[0].osm_id), 2);
    await writer.query('DELETE FROM building_data_changes');

    // A commit between the optimistic precheck and the exclusive lock must be
    // caught by the fresh READ COMMITTED check under the lock.
    await begin();
    const racingClient = { query: async (sql, params) => {
      if (sql === 'SAVEPOINT search_queue_compaction') await enqueue(3);
      return worker.query(sql, params);
    } };
    assert.equal(await reclaimEmptyPostgresSearchQueue(racingClient, { minBytes: 0 }), false);
    await worker.query('COMMIT');
    assert.equal(Number((await writer.query('SELECT osm_id FROM building_data_changes')).rows[0].osm_id), 3);
    await writer.query('DELETE FROM building_data_changes');

    // A later writer waits for compaction's commit, then inserts with a new
    // generation; it must not be swept away by the preceding TRUNCATE.
    await begin();
    assert.equal(await reclaimEmptyPostgresSearchQueue(worker, { minBytes: 0 }), true);
    const pendingWrite = enqueue(4);
    pendingWrite.catch(() => {});
    try {
      const deadline = Date.now() + 3000;
      while (true) {
        const blocked = await worker.query('SELECT cardinality(pg_blocking_pids($1)) > 0 AS blocked', [writer.processID]);
        if (blocked.rows[0].blocked) break;
        assert.ok(Date.now() < deadline, 'late writer must wait for the queue lock');
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      await worker.query('COMMIT');
      const inserted = await pendingWrite;
      assert.ok(BigInt(inserted.rows[0].generation) > lastGeneration);
      assert.equal(Number((await writer.query('SELECT osm_id FROM building_data_changes')).rows[0].osm_id), 4);
    } catch (error) {
      await worker.query('ROLLBACK');
      await pendingWrite.catch(() => {});
      throw error;
    }
    console.log(JSON.stringify({ emptyQueueBytesBefore: before, emptyQueueBytesAfter: after }));
  } finally {
    await worker.end(); await writer.end(); await runtime?.close();
    if (/^archimap_search_queue_test_\d+_\d+$/.test(name)) await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await admin.end();
  }
});
