const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Client } = require('pg');
const { applyRegionImportFromPostgresStage } = require('../../scripts/region-sync/import-applier');
const { readRegionTileState, publishRegionTiles, canReuseRegionArchive } = require('../../scripts/region-sync/tile-state');

const databaseUrl = String(process.env.ARCHIMAP_IMPORT_TEST_DATABASE_URL || '').trim();

function assertIsolatedDatabase() {
  const target = new URL(databaseUrl);
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname) && target.pathname.startsWith('/test_'),
    'Import tests require an explicit loopback test_* database');
}

test('incremental region imports preserve tags, overlap, publication retries and part dependencies', {
  skip: !databaseUrl && 'ARCHIMAP_IMPORT_TEST_DATABASE_URL is required for the isolated PostgreSQL test'
}, async () => {
  assertIsolatedDatabase();
  const client = new Client({ connectionString: databaseUrl });
  const suffix = `${process.pid}_${Date.now()}`;
  const schema = `region_import_test_${suffix}`;
  const objectBase = 8000000000000 + Date.now();
  const ids = [objectBase, objectBase + 1, objectBase + 2];
  const regionIds = [];
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'archimap-import-state-'));
  const archivePath = path.join(directory, 'fixture.pmtiles');
  const builtArchivePath = path.join(directory, 'built.pmtiles');
  const publish = async (regionId, revision) => {
    fs.writeFileSync(builtArchivePath, 'fixture archive');
    return publishRegionTiles({ databaseUrl, regionId, revision, signature: 'test', archivePath, builtArchivePath });
  };
  await client.connect();
  try {
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`CREATE TABLE ${schema}.region_import_stage (
      osm_type_code TEXT NOT NULL, osm_id BIGINT NOT NULL, tags_json JSONB,
      min_lon REAL NOT NULL, min_lat REAL NOT NULL, max_lon REAL NOT NULL, max_lat REAL NOT NULL,
      geom geometry(MultiPolygon, 4326) NOT NULL
    )`);
    for (const label of ['a', 'overlap']) {
      const inserted = await client.query(`INSERT INTO public.data_sync_regions (slug, name)
        VALUES ($1, $1) RETURNING id`, [`import-test-${suffix}-${label}`]);
      regionIds.push(Number(inserted.rows[0].id));
    }
    const region = { id: regionIds[0] };
    const apply = () => applyRegionImportFromPostgresStage({
      region, databaseUrl, stageSchema: schema, stageTable: 'region_import_stage', totalFeatureCount: null,
      onProgress: null
    });
    await client.query(`INSERT INTO ${schema}.region_import_stage
      SELECT 'W', id, tags, 10, 20, 11, 21, ST_Multi(ST_MakeEnvelope(10,20,11,21,4326))
      FROM (VALUES ($1::bigint, '{"building":"yes","custom:unlisted":"kept"}'::jsonb),
        ($2::bigint, '{"building:part":"yes","height":"9"}'::jsonb),
        ($3::bigint, '{"building":"yes","name":"orphan fixture"}'::jsonb)) AS source(id,tags)`, ids);
    const initial = await apply();
    assert.equal(initial.changedFeatureCount, 3);
    assert.equal(initial.insertedFeatureCount, 3);
    const tagResult = await client.query('SELECT tags_json::jsonb AS tags FROM osm.building_contours WHERE osm_id = $1', [ids[0]]);
    assert.equal(tagResult.rows[0].tags['custom:unlisted'], 'kept');
    let state = await readRegionTileState(databaseUrl, region.id);
    await publish(region.id, state.data_revision);
    const initialRevision = state.data_revision;
    const initialSummaryUpdatedAt = (await client.query('SELECT last_updated::text FROM osm.building_contours_summary WHERE singleton_id = 1')).rows[0].last_updated;
    await client.query('DELETE FROM public.building_data_changes WHERE osm_id = ANY($1::bigint[])', [ids]);

    const unchanged = await apply();
    assert.equal(unchanged.changedFeatureCount, 0);
    assert.equal(unchanged.insertedFeatureCount, 0);
    assert.equal((await client.query('SELECT last_updated::text FROM osm.building_contours_summary WHERE singleton_id = 1')).rows[0].last_updated, initialSummaryUpdatedAt);
    state = await readRegionTileState(databaseUrl, region.id);
    assert.equal(state.data_revision, initialRevision);
    assert.equal(canReuseRegionArchive({ state, signature: 'test', archivePath }), true);
    assert.equal((await client.query('SELECT 1 FROM public.building_data_changes WHERE osm_id = ANY($1::bigint[])', [ids])).rowCount, 0);

    await client.query(`UPDATE ${schema}.region_import_stage SET tags_json = tags_json || '{"custom:unlisted":"updated","name":"new name"}'::jsonb WHERE osm_id = $1`, [ids[0]]);
    const metadata = await apply();
    assert.equal(metadata.changedFeatureCount, 1);
    state = await readRegionTileState(databaseUrl, region.id);
    assert.equal(state.data_revision, initialRevision);
    assert.equal(canReuseRegionArchive({ state, signature: 'test', archivePath }), true);
    const generation = (await client.query('SELECT generation FROM public.building_data_changes WHERE osm_id = $1', [ids[0]])).rows[0].generation;

    await client.query(`UPDATE ${schema}.region_import_stage SET tags_json = tags_json || '{"height":"20"}'::jsonb WHERE osm_id = $1`, [ids[0]]);
    await apply();
    state = await readRegionTileState(databaseUrl, region.id);
    assert.notEqual(state.data_revision, initialRevision);
    assert.equal(canReuseRegionArchive({ state, signature: 'test', archivePath }), false);
    assert.equal((await client.query('DELETE FROM public.building_data_changes WHERE osm_id = $1 AND generation = $2', [ids[0], generation])).rowCount, 0);
    assert.equal((await apply()).changedFeatureCount, 0);
    state = await readRegionTileState(databaseUrl, region.id);
    assert.equal(canReuseRegionArchive({ state, signature: 'test', archivePath }), false, 'failed publication must stay dirty after no-op import');
    await assert.rejects(publish(region.id, initialRevision), /changed during/);
    await publish(region.id, state.data_revision);

    await client.query(`INSERT INTO public.data_region_memberships (region_id, osm_type, osm_id)
      VALUES ($1, 'way', $2), ($1, 'way', $3)`, [regionIds[1], ids[0], ids[1]]);
    const overlapBefore = await readRegionTileState(databaseUrl, regionIds[1]);
    const parentBefore = await readRegionTileState(databaseUrl, region.id);
    await client.query(`UPDATE ${schema}.region_import_stage SET geom = ST_Multi(ST_MakeEnvelope(10,20,10.5,20.5,4326)), max_lon = 10.5, max_lat = 20.5 WHERE osm_id = $1`, [ids[1]]);
    assert.equal((await apply()).changedFeatureCount, 1);
    assert.notEqual((await readRegionTileState(databaseUrl, region.id)).data_revision, parentBefore.data_revision);
    assert.notEqual((await readRegionTileState(databaseUrl, regionIds[1])).data_revision, overlapBefore.data_revision,
      'part geometry must invalidate every shared region and its derived parent remainder');

    await client.query(`DELETE FROM ${schema}.region_import_stage WHERE osm_id = ANY($1::bigint[])`, [[ids[0], ids[2]]]);
    const removed = await apply();
    assert.equal(removed.orphanDeletedCount, 1);
    assert.equal(removed.activeFeatureCount, 1);
    assert.equal((await client.query('SELECT 1 FROM osm.building_contours WHERE osm_id = $1', [ids[0]])).rowCount, 1, 'shared object is retained');
    assert.equal((await client.query('SELECT 1 FROM osm.building_contours WHERE osm_id = $1', [ids[2]])).rowCount, 0, 'true orphan is deleted');
    assert.equal((await client.query('SELECT 1 FROM public.building_data_changes WHERE osm_id = $1', [ids[2]])).rowCount, 1, 'search deletion is durable');

    await client.query(`TRUNCATE ${schema}.region_import_stage`);
    await assert.rejects(apply(), /0 building contours/);
    assert.equal((await client.query('SELECT 1 FROM public.data_region_memberships WHERE region_id = $1', [region.id])).rowCount, 1);
  } finally {
    await client.query('DELETE FROM public.data_sync_regions WHERE id = ANY($1::bigint[])', [regionIds]);
    await client.query('DELETE FROM osm.building_contours WHERE osm_id = ANY($1::bigint[])', [ids]);
    await client.query('DELETE FROM public.building_data_changes WHERE osm_id = ANY($1::bigint[])', [ids]);
    await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await client.query(`UPDATE osm.building_contours_summary SET total = (SELECT COUNT(*) FROM osm.building_contours) WHERE singleton_id = 1`);
    await client.end();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('concurrent archive publication rejects stale builds and restores files on database failure', {
  skip: !databaseUrl && 'ARCHIMAP_IMPORT_TEST_DATABASE_URL is required for the isolated PostgreSQL test'
}, async () => {
  assertIsolatedDatabase();
  const client = new Client({ connectionString: databaseUrl });
  const suffix = `${process.pid}_${Date.now()}`;
  const schema = `region_publish_test_${suffix}`;
  const trigger = `region_publish_failure_${suffix}`;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'archimap-publish-race-'));
  const archivePath = path.join(directory, 'region.pmtiles');
  const stalePath = path.join(directory, 'stale.pmtiles');
  const freshPath = path.join(directory, 'fresh.pmtiles');
  const failingPath = path.join(directory, 'failing.pmtiles');
  let regionId = null;
  await client.connect();
  try {
    regionId = Number((await client.query(`INSERT INTO public.data_sync_regions(slug, name)
      VALUES($1, $1) RETURNING id`, [`publish-test-${suffix}`])).rows[0].id);
    await readRegionTileState(databaseUrl, regionId);
    fs.writeFileSync(archivePath, 'previous archive');
    fs.writeFileSync(stalePath, 'stale revision zero');
    fs.writeFileSync(freshPath, 'current revision one');
    fs.writeFileSync(failingPath, 'must roll back');
    await client.query('BEGIN');
    await client.query('UPDATE public.data_region_tile_state SET data_revision = 1 WHERE region_id = $1', [regionId]);
    const contenders = Promise.allSettled([
      publishRegionTiles({ databaseUrl, regionId, revision: '0', signature: 'stale', archivePath, builtArchivePath: stalePath }),
      publishRegionTiles({ databaseUrl, regionId, revision: '1', signature: 'fresh', archivePath, builtArchivePath: freshPath })
    ]);
    await client.query('COMMIT');
    const outcomes = await contenders;
    assert.equal(outcomes[0].status, 'rejected');
    if (outcomes[0].status === 'rejected') {
      assert.match(String(outcomes[0].reason), /refusing to publish a stale archive/);
    }
    assert.equal(outcomes[1].status, 'fulfilled');
    assert.equal(fs.readFileSync(archivePath, 'utf8'), 'current revision one');
    let state = await readRegionTileState(databaseUrl, regionId);
    assert.equal(canReuseRegionArchive({ state, signature: 'fresh', archivePath }), true);

    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`CREATE FUNCTION ${schema}.fail_publish() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.region_id = ${regionId} AND NEW.published_signature = 'fail' THEN
        RAISE EXCEPTION 'simulated publication state failure'; END IF; RETURN NEW; END; $$`);
    await client.query(`CREATE TRIGGER ${trigger} BEFORE UPDATE ON public.data_region_tile_state
      FOR EACH ROW EXECUTE FUNCTION ${schema}.fail_publish()`);
    await assert.rejects(publishRegionTiles({ databaseUrl, regionId, revision: '1', signature: 'fail',
      archivePath, builtArchivePath: failingPath }), /simulated publication state failure/);
    assert.equal(fs.readFileSync(archivePath, 'utf8'), 'current revision one');
    state = await readRegionTileState(databaseUrl, regionId);
    assert.equal(canReuseRegionArchive({ state, signature: 'fresh', archivePath }), true);
    assert.equal(fs.existsSync(`${archivePath}.bak`), false);

    // Pause after COMMIT has released row locks, before backup cleanup. A second
    // publisher must still be excluded, otherwise its backup can be deleted by
    // the first publisher and a later rollback loses the published archive.
    fs.writeFileSync(freshPath, 'archive committed before cleanup');
    fs.writeFileSync(failingPath, 'second publisher must roll back');
    let releaseCleanup = () => {};
    let signalCommit = () => {};
    const cleanupGate = new Promise<void>((resolve) => { releaseCleanup = resolve; });
    const committed = new Promise<void>((resolve) => { signalCommit = resolve; });
    const firstPublisher = publishRegionTiles({ databaseUrl, regionId, revision: '1', signature: 'fresh',
      archivePath, builtArchivePath: freshPath, afterCommit: async () => { signalCommit(); await cleanupGate; } });
    await committed;
    let acquired;
    let secondPublisher;
    try {
      const publicationLock = `archimap:region-pmtiles:${regionId}`;
      acquired = (await client.query('SELECT pg_try_advisory_lock(hashtextextended($1::text, 0)) AS acquired', [publicationLock])).rows[0].acquired;
      if (acquired) await client.query('SELECT pg_advisory_unlock(hashtextextended($1::text, 0))', [publicationLock]);
      secondPublisher = assert.rejects(publishRegionTiles({ databaseUrl, regionId, revision: '1', signature: 'fail',
        archivePath, builtArchivePath: failingPath }), /simulated publication state failure/);
    } finally {
      releaseCleanup();
    }
    await Promise.all([firstPublisher, secondPublisher]);
    assert.equal(acquired, false, 'publication lock must survive COMMIT until backup cleanup');
    assert.equal(fs.readFileSync(archivePath, 'utf8'), 'archive committed before cleanup');
    state = await readRegionTileState(databaseUrl, regionId);
    assert.equal(canReuseRegionArchive({ state, signature: 'fresh', archivePath }), true);
    assert.equal(fs.existsSync(`${archivePath}.bak`), false);
  } finally {
    await client.query('ROLLBACK');
    await client.query(`DROP TRIGGER IF EXISTS ${trigger} ON public.data_region_tile_state`);
    await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    if (regionId != null) await client.query('DELETE FROM public.data_sync_regions WHERE id = $1', [regionId]);
    await client.end();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
