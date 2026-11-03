const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Client } = require('pg');
const { readRegionTileState, publishRegionTiles, canReuseRegionArchive, canPatchRegionArchive } = require('../../scripts/region-sync/tile-state');

const databaseUrl = String(process.env.ARCHIMAP_IMPORT_TEST_DATABASE_URL || '').trim();
const testOptions = { skip: !databaseUrl && 'ARCHIMAP_IMPORT_TEST_DATABASE_URL requires a migrated loopback test_* database' };
const dirtyBounds = [{ west: 10, south: 20, east: 11, north: 21 }];

async function publicationFixture() {
  const target = new URL(databaseUrl);
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname) && target.pathname.startsWith('/test_'));
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  const suffix = `${process.pid}_${Date.now()}`;
  const regionId = Number((await client.query('INSERT INTO public.data_sync_regions(slug,name) VALUES ($1,$1) RETURNING id',
    [`tile-publication-${suffix}`])).rows[0].id);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'archimap-dirty-publication-'));
  const archivePath = path.join(directory, 'region.pmtiles');
  const builtArchivePath = path.join(directory, 'built.pmtiles');
  const signature = 'publication-test';
  const read = () => readRegionTileState(databaseUrl, regionId);
  const publish = (options: LooseRecord = {}) => publishRegionTiles({ databaseUrl, regionId, signature, archivePath, builtArchivePath, ...options });
  await read();
  fs.writeFileSync(builtArchivePath, 'published baseline');
  await publish({ revision: '0' });
  return { client, suffix, regionId, directory, archivePath, builtArchivePath, signature, read, publish,
    async dirty(fullRebuildRequired = false) {
      await client.query(`UPDATE public.data_region_tile_state SET data_revision=data_revision+1,
        full_rebuild_required=$2,dirty_bounds=$3::jsonb WHERE region_id=$1`, [regionId, fullRebuildRequired, JSON.stringify(dirtyBounds)]);
      return read();
    },
    async close() {
      await client.query('DELETE FROM public.data_sync_regions WHERE id=$1', [regionId]);
      await client.end();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  };
}

test('successful full and patch publication commit archive identity and clear all dirty state together', testOptions, async () => {
  const f = await publicationFixture();
  try {
    for (const fullRebuildRequired of [true, false]) {
      const before = await f.dirty(fullRebuildRequired);
      assert.equal(canPatchRegionArchive({ state: before, signature: f.signature, archivePath: f.archivePath }), !fullRebuildRequired);
      fs.writeFileSync(f.builtArchivePath, `published revision ${before.data_revision}`);
      let observedCommit = false;
      await f.publish({ revision: before.data_revision, expectedBase: fullRebuildRequired ? null : before,
        afterCommit: async () => {
          const committed = await f.read();
          observedCommit = true;
          assert.equal(committed.published_revision, before.data_revision);
          assert.equal(committed.full_rebuild_required, false);
          assert.deepEqual(committed.dirty_bounds, []);
          assert.equal(canReuseRegionArchive({ state: committed, signature: f.signature, archivePath: f.archivePath }), true);
          assert.equal(fs.readFileSync(f.archivePath, 'utf8'), `published revision ${before.data_revision}`);
        }
      });
      assert.equal(observedCommit, true);
      assert.equal(fs.existsSync(`${f.archivePath}.bak`), false);
    }
  } finally { await f.close(); }
});

test('stale revisions and changed patch base identity preserve the current archive and dirty state', testOptions, async () => {
  const f = await publicationFixture();
  try {
    const base = await f.dirty();
    fs.writeFileSync(f.builtArchivePath, 'stale partial build');
    await assert.rejects(f.publish({ revision: base.data_revision, expectedBase: base, signal: AbortSignal.abort() }), { name: 'AbortError' });
    assert.deepEqual(await f.read(), base);
    assert.equal(fs.readFileSync(f.archivePath, 'utf8'), 'published baseline');
    assert.equal(fs.readFileSync(f.builtArchivePath, 'utf8'), 'stale partial build');
    const newer = await f.dirty();
    await assert.rejects(f.publish({ revision: base.data_revision, expectedBase: base }), /refusing to publish a stale archive/);
    assert.deepEqual(await f.read(), newer);
    assert.equal(fs.readFileSync(f.archivePath, 'utf8'), 'published baseline');
    assert.equal(fs.readFileSync(f.builtArchivePath, 'utf8'), 'stale partial build');

    const changes = [
      ['published_revision', '999'],
      ['published_signature', 'another-builder'],
      ['published_archive_bytes', Number(base.published_archive_bytes) + 10],
      ['published_archive_mtime_ms', Number(base.published_archive_mtime_ms) + 1000]
    ];
    for (const [column, changed] of changes) {
      await f.client.query(`UPDATE public.data_region_tile_state SET ${column}=$2 WHERE region_id=$1`, [f.regionId, changed]);
      const before = await f.read();
      await assert.rejects(f.publish({ revision: before.data_revision, expectedBase: base }), /patch base changed during build/);
      assert.deepEqual(await f.read(), before);
      assert.equal(fs.readFileSync(f.archivePath, 'utf8'), 'published baseline');
      assert.equal(fs.readFileSync(f.builtArchivePath, 'utf8'), 'stale partial build');
      await f.client.query(`UPDATE public.data_region_tile_state SET ${column}=$2 WHERE region_id=$1`, [f.regionId, base[column]]);
    }

    fs.writeFileSync(f.archivePath, 'externally replaced archive must survive');
    const beforeExternalReplacement = await f.read();
    await assert.rejects(f.publish({ revision: beforeExternalReplacement.data_revision, expectedBase: base }), /patch base changed during build/);
    assert.deepEqual(await f.read(), beforeExternalReplacement);
    assert.equal(fs.readFileSync(f.archivePath, 'utf8'), 'externally replaced archive must survive');
    assert.equal(fs.existsSync(`${f.archivePath}.bak`), false);
  } finally { await f.close(); }
});

test('database publication failure restores the prior file without acknowledging dirty bounds or a full rebuild', testOptions, async () => {
  const f = await publicationFixture();
  const schema = `tile_publish_failure_${f.suffix}`;
  const trigger = `tile_publish_failure_${f.suffix}`;
  try {
    await f.client.query(`CREATE SCHEMA ${schema}`);
    await f.client.query(`CREATE FUNCTION ${schema}.fail_publish() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.region_id=${f.regionId} AND NEW.published_signature='failure' THEN
        RAISE EXCEPTION 'simulated dirty-state publication failure'; END IF; RETURN NEW; END; $$`);
    await f.client.query(`CREATE TRIGGER ${trigger} BEFORE UPDATE ON public.data_region_tile_state
      FOR EACH ROW EXECUTE FUNCTION ${schema}.fail_publish()`);
    for (const fullRebuildRequired of [true, false]) {
      const before = await f.dirty(fullRebuildRequired);
      fs.writeFileSync(f.builtArchivePath, 'must not be acknowledged');
      await assert.rejects(f.publish({ revision: before.data_revision, signature: 'failure' }), /simulated dirty-state publication failure/);
      assert.deepEqual(await f.read(), before);
      assert.equal(canReuseRegionArchive({ state: await f.read(), signature: f.signature, archivePath: f.archivePath }), false);
      assert.equal(fs.readFileSync(f.archivePath, 'utf8'), 'published baseline');
      assert.equal(fs.existsSync(`${f.archivePath}.bak`), false);
    }
  } finally {
    await f.client.query(`DROP TRIGGER IF EXISTS ${trigger} ON public.data_region_tile_state`);
    await f.client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await f.close();
  }
});
