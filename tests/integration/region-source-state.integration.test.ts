const test = require('node:test');
const assert = require('node:assert/strict');
const { Client } = require('pg');
const {
  applyRegionImportFromPostgresStage,
  lockPostgresContourSummary
} = require('../../scripts/region-sync/import-applier');
const {
  acquireRegionSourceLock,
  readActiveRegionSourceState,
  tryRecordUnchangedRegionSource
} = require('../../scripts/region-sync/source-state');

const databaseUrl = String(process.env.ARCHIMAP_SOURCE_STATE_TEST_DATABASE_URL || '').trim();
test(
  'cancelling a real PostgreSQL source-lock waiter does not leave a late lock owner',
  {
    skip: !databaseUrl && 'ARCHIMAP_SOURCE_STATE_TEST_DATABASE_URL requires an isolated migrated test database'
  },
  async () => {
    const target = new URL(databaseUrl);
    assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname) && target.pathname.startsWith('/test_'));
    const regionId = 880000000 + process.pid;
    const release = await acquireRegionSourceLock(databaseUrl, regionId);
    try {
      await assert.rejects(acquireRegionSourceLock(databaseUrl, regionId, { signal: AbortSignal.timeout(100) }), {
        name: 'AbortError'
      });
    } finally {
      await release();
    }
    const releaseNext = await acquireRegionSourceLock(databaseUrl, regionId, { signal: AbortSignal.timeout(2000) });
    await releaseNext();
  }
);

test(
  'committed source cursors advance atomically and unchanged-building reuse rejects changed canonical coverage',
  {
    skip: !databaseUrl && 'ARCHIMAP_SOURCE_STATE_TEST_DATABASE_URL requires an isolated migrated test database'
  },
  async () => {
    const target = new URL(databaseUrl);
    assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname) && target.pathname.startsWith('/test_'));
    const client = new Client({ connectionString: databaseUrl });
    const suffix = `${process.pid}_${Date.now()}`;
    const schema = `region_source_test_${suffix}`;
    const osmId = 8200000000000 + Date.now();
    let regionId;
    const source = {
      persistentSource: true,
      extractSource: 'test',
      extractId: 'region',
      sha256: 'a'.repeat(64),
      sizeBytes: 123,
      localPath: '/cache/immutable-a.pbf',
      downloadUrl: 'https://example.test/region.pbf',
      sourceEtag: '"a"',
      sourceLastModified: 'Thu, 01 Jan 2026 00:00:00 GMT',
      importSignature: 'test-signature',
      buildingInputSha256: 'c'.repeat(64),
      replicationBaseUrl: 'https://example.test/updates/',
      replicationSequence: 100,
      replicationTimestamp: '2026-01-01T00:00:00.000Z',
      lastFullDownloadAt: '2026-01-01T00:00:00.000Z'
    };
    const nextSource = {
      ...source,
      sha256: 'b'.repeat(64),
      localPath: '/cache/immutable-b.pbf',
      sourceEtag: '"b"',
      replicationSequence: 101,
      replicationTimestamp: '2026-01-01T00:01:00.000Z'
    };
    await client.connect();
    try {
      await client.query(`CREATE SCHEMA ${schema}`);
      await client.query(`CREATE TABLE ${schema}.region_import_stage (osm_type_code TEXT NOT NULL, osm_id BIGINT NOT NULL,
      tags_json JSONB, min_lon REAL NOT NULL, min_lat REAL NOT NULL, max_lon REAL NOT NULL, max_lat REAL NOT NULL,
      geom geometry(MultiPolygon,4326) NOT NULL)`);
      await client.query(
        `INSERT INTO ${schema}.region_import_stage VALUES ('W', $1, '{"building":"yes","name":"original"}',
      179.8,-80,179.81,-79.99,ST_Multi(ST_MakeEnvelope(179.8,-80,179.81,-79.99,4326)))`,
        [osmId]
      );
      regionId = Number(
        (
          await client.query(
            `INSERT INTO public.data_sync_regions(slug,name) VALUES ($1,'Source fixture') RETURNING id`,
            [`source-fixture-${suffix}`]
          )
        ).rows[0].id
      );
      const region = { id: regionId, slug: `source-fixture-${suffix}` };
      const apply = (sourceSnapshot) =>
        applyRegionImportFromPostgresStage({
          databaseUrl,
          region,
          stageSchema: schema,
          stageTable: 'region_import_stage',
          sourceSnapshot
        });
      await apply(source);
      const initial = await readActiveRegionSourceState(databaseUrl, regionId);
      assert.equal(initial.buildingInputSha256, source.buildingInputSha256);
      const fast = (
        snapshot,
        previousSnapshotId = initial.id,
        importSignature = source.importSignature,
        sourceInputUnchanged = false
      ) =>
        tryRecordUnchangedRegionSource({
          databaseUrl,
          region,
          previousSnapshotId,
          sourceSnapshot: snapshot,
          importSignature,
          sourceInputUnchanged
        });
      assert.equal((await fast(source)).sourceSnapshotId, initial.id, 'identical cursor creates no history row');
      assert.equal(await fast(nextSource, initial.id, 'new-import-contract'), null);
      assert.equal(await fast({ ...nextSource, buildingInputSha256: 'd'.repeat(64) }), null);

      await client.query(
        `UPDATE ${schema}.region_import_stage SET tags_json = '{"building":"yes","name":"must rollback"}'`
      );
      await assert.rejects(apply({ ...nextSource, downloadUrl: '' }), /complete fingerprint/);
      assert.equal(
        (
          await client.query('SELECT tags_json FROM osm.building_contours WHERE osm_id=$1', [osmId])
        ).rows[0].tags_json.includes('original'),
        true
      );
      assert.equal((await readActiveRegionSourceState(databaseUrl, regionId)).id, initial.id);
      await client.query(`UPDATE ${schema}.region_import_stage SET tags_json = '{"building":"yes","name":"original"}'`);

      const advanced = await fast(nextSource);
      assert.equal(advanced.changedFeatureCount, 0);
      assert.notEqual(advanced.sourceSnapshotId, initial.id);
      let current = await readActiveRegionSourceState(databaseUrl, regionId);
      assert.equal(current.replicationSequence, 101);
      assert.equal(current.sourceMtime, nextSource.replicationTimestamp);
      assert.equal(
        (
          await client.query(
            'SELECT count(*)::int AS count FROM public.data_region_source_snapshots WHERE region_id=$1 AND is_active=1',
            [regionId]
          )
        ).rows[0].count,
        1
      );
      assert.equal(await fast(nextSource), null, 'stale caller cannot advance a replaced active pointer');

      const sourceWithoutBuildingHash = { ...nextSource, buildingInputSha256: null };
      assert.equal(
        await fast(sourceWithoutBuildingHash, current.id),
        null,
        'a missing hash is not proof of unchanged input'
      );
      assert.equal(await fast(sourceWithoutBuildingHash, initial.id, source.importSignature, true), null);
      assert.equal(await fast(sourceWithoutBuildingHash, current.id, 'changed-import-contract', true), null);
      const proven = await fast(sourceWithoutBuildingHash, current.id, source.importSignature, true);
      assert.equal(proven.changedFeatureCount, 0);
      current = await readActiveRegionSourceState(databaseUrl, regionId);
      assert.equal(current.id, proven.sourceSnapshotId);
      assert.equal(current.buildingInputSha256, null);
      assert.equal(
        (await fast(sourceWithoutBuildingHash, current.id, source.importSignature, true)).sourceSnapshotId,
        current.id,
        'validated unchanged input also reuses snapshots whose legacy building hash is null'
      );

      const checkDirty = async (sql) => {
        await client.query(sql, [osmId]);
        assert.equal(await fast(sourceWithoutBuildingHash, current.id, source.importSignature, true), null);
        await client.query(
          "UPDATE osm.building_contours SET updated_at=$2::timestamptz - interval '1 second' WHERE osm_id=$1",
          [osmId, current.createdAt]
        );
      };
      await checkDirty(
        `UPDATE osm.building_contours SET tags_json='{"building":"yes","name":"other region"}',updated_at=clock_timestamp() WHERE osm_id=$1`
      );
      await checkDirty(
        'UPDATE osm.building_contours SET geom=ST_Translate(geom,0.001,0),updated_at=clock_timestamp() WHERE osm_id=$1'
      );
      await client.query('DELETE FROM public.data_region_memberships WHERE region_id=$1', [regionId]);
      assert.equal(
        await fast(sourceWithoutBuildingHash, current.id, source.importSignature, true),
        null,
        'missing memberships invalidate reuse even with proven unchanged source input'
      );

      await client.query('BEGIN');
      await lockPostgresContourSummary(client);
      await client.query('UPDATE public.data_region_source_snapshots SET local_path=$2 WHERE id=$1', [
        current.id,
        '/cache/committing-source.pbf'
      ]);
      let readSettled = false;
      const cleanupRead = readActiveRegionSourceState(databaseUrl, regionId, { synchronizeImport: true }).then(
        (state) => {
          readSettled = true;
          return state;
        }
      );
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal(readSettled, false, 'cleanup waits for an import transaction whose commit outcome is not known yet');
      await client.query('COMMIT');
      assert.equal((await cleanupRead).localPath, '/cache/committing-source.pbf');
    } finally {
      await client.query('ROLLBACK').catch(() => {});
      if (regionId) await client.query('DELETE FROM public.data_sync_regions WHERE id=$1', [regionId]);
      await client.query('DELETE FROM osm.building_contours WHERE osm_id=$1', [osmId]);
      await client.query('DELETE FROM public.building_data_changes WHERE osm_id=$1', [osmId]);
      await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await client.query(
        'UPDATE osm.building_contours_summary SET total=(SELECT count(*) FROM osm.building_contours),refreshed_at=NOW() WHERE singleton_id=1'
      );
      await client.end();
    }
  }
);
