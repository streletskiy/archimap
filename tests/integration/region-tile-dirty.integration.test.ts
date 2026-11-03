const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Client } = require('pg');
const { exportRegionMembersToGeojsonNdjson } = require('../../scripts/region-sync/region-db');

const databaseUrl = String(process.env.ARCHIMAP_TILE_DIRTY_TEST_DATABASE_URL || '').trim();
const testOptions = { skip: !databaseUrl && 'ARCHIMAP_TILE_DIRTY_TEST_DATABASE_URL requires a migrated loopback test_* database' };

async function fixture() {
  const target = new URL(databaseUrl);
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname) && target.pathname.startsWith('/test_'));
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  const base = 8400000000000 + Date.now();
  const regionIds = [];
  const ids = [];
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'archimap-dirty-tiles-'));
  for (const label of ['a', 'b']) {
    const result = await client.query('INSERT INTO public.data_sync_regions (slug,name) VALUES ($1,$1) RETURNING id',
      [`dirty-tiles-${process.pid}-${base}-${label}`]);
    regionIds.push(Number(result.rows[0].id));
  }
  const add = async (offset, bounds, tags: LooseRecord = { building: 'yes' }, regions = regionIds) => {
    const id = base + offset;
    ids.push(id);
    await client.query(`INSERT INTO osm.building_contours (osm_type,osm_id,tags_json,min_lon,min_lat,max_lon,max_lat,geom)
      VALUES ('way',$1,$2,$3,$4,$5,$6,ST_Multi(ST_MakeEnvelope($3,$4,$5,$6,4326)))`, [id, JSON.stringify(tags), ...bounds]);
    for (const region of regions) {
      await client.query("INSERT INTO public.data_region_memberships (region_id,osm_type,osm_id) VALUES ($1,'way',$2)", [region, id]);
    }
    return id;
  };
  const clean = () => client.query("UPDATE public.data_region_tile_state SET full_rebuild_required=false,dirty_bounds='[]' WHERE region_id=ANY($1::bigint[])", [regionIds]);
  const state = async (region = regionIds[0]) => (await client.query('SELECT * FROM public.data_region_tile_state WHERE region_id=$1', [region])).rows[0];
  const exportRows = async (name, tileWindows = null) => {
    const outputPath = path.join(directory, `${name}.ndjson`);
    const result = await exportRegionMembersToGeojsonNdjson({ dbProvider: 'postgres', databaseUrl, regionId: regionIds[0], outputPath, tileWindows });
    const text = fs.readFileSync(outputPath, 'utf8').trim();
    return { result, rows: text ? text.split('\n').map(row => JSON.parse(row)) : [], text };
  };
  return { client, base, ids, regionIds, add, clean, state, exportRows,
    async close() {
      await client.query('ROLLBACK');
      await client.query('DELETE FROM public.data_sync_regions WHERE id=ANY($1::bigint[])', [regionIds]);
      await client.query('DELETE FROM user_edits.building_user_edits WHERE osm_id=ANY($1::bigint[])', [ids]);
      await client.query('DELETE FROM osm.building_contours WHERE osm_id=ANY($1::bigint[])', [ids]);
      await client.query('DELETE FROM public.building_data_changes WHERE osm_id=ANY($1::bigint[])', [ids]);
      await client.end();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  };
}

function containsBounds(state, [west, south, east, north]: number[]) {
  assert.equal(state.full_rebuild_required, false);
  assert.ok(state.dirty_bounds.some(bounds => bounds.west === west && bounds.south === south && bounds.east === east && bounds.north === north),
    `Missing changed footprint ${[west, south, east, north].join(',')}`);
}

test('dirty bounds preserve old/new footprints, whole parents, shared memberships and user edits', testOptions, async () => {
  const f = await fixture();
  try {
    const firstParent = await f.add(1, [10, 10, 20, 20]);
    await f.add(2, [30, 10, 40, 20]);
    const part = await f.add(3, [11, 11, 12, 12], { 'building:part': 'yes', height: '9' });
    await f.client.query("INSERT INTO user_edits.building_user_edits (osm_type,osm_id,created_by,name) VALUES ('way',$1,'tile-test','preserved edit')", [part]);
    const originalEdit = (await f.client.query('SELECT to_jsonb(e) AS row FROM user_edits.building_user_edits e WHERE osm_id=$1', [part])).rows;
    await f.clean();
    const originalRevision = (await f.state()).data_revision;
    await f.client.query(`UPDATE osm.building_contours SET tags_json=(tags_json::jsonb || '{"name":"metadata only"}')::text WHERE osm_id=$1`, [firstParent]);
    assert.equal((await f.state()).data_revision, originalRevision);
    assert.deepEqual((await f.state()).dirty_bounds, []);
    await f.client.query(`UPDATE osm.building_contours SET min_lon=31,min_lat=11,max_lon=32,max_lat=12,
      geom=ST_Multi(ST_MakeEnvelope(31,11,32,12,4326)) WHERE osm_id=$1`, [part]);
    for (const region of f.regionIds) {
      const state = await f.state(region);
      for (const bounds of [[11, 11, 12, 12], [31, 11, 32, 12], [10, 10, 20, 20], [30, 10, 40, 20]]) containsBounds(state, bounds);
      assert.notEqual(state.data_revision, originalRevision);
    }
    await f.clean();
    await f.client.query(`UPDATE osm.building_contours SET tags_json='{"building":"yes"}' WHERE osm_id=$1`, [part]);
    containsBounds(await f.state(), [30, 10, 40, 20]);
    await f.client.query(`UPDATE osm.building_contours SET tags_json='{"building_part":"yes"}' WHERE osm_id=$1`, [part]);
    await f.clean();
    await f.client.query('DELETE FROM public.data_region_memberships WHERE region_id=$1 AND osm_id=$2', [f.regionIds[0], part]);
    containsBounds(await f.state(), [30, 10, 40, 20]);
    assert.deepEqual((await f.state(f.regionIds[1])).dirty_bounds, []);
    await f.clean();
    await f.client.query('DELETE FROM osm.building_contours WHERE osm_id=$1', [part]);
    containsBounds(await f.state(f.regionIds[1]), [30, 10, 40, 20]);
    assert.deepEqual((await f.state()).dirty_bounds, []);
    assert.deepEqual((await f.client.query('SELECT to_jsonb(e) AS row FROM user_edits.building_user_edits e WHERE osm_id=$1', [part])).rows, originalEdit);
    await f.clean();
    await f.client.query('DELETE FROM public.data_region_memberships WHERE region_id=$1', [f.regionIds[0]]);
    containsBounds(await f.state(), [10, 10, 20, 20]);
    containsBounds(await f.state(), [30, 10, 40, 20]);
    const empty = await f.exportRows('deleted-region', [{ west: 0, south: 0, east: 50, north: 50 }]);
    assert.equal(empty.result.importedFeatureCount, 0);
    assert.equal(empty.result.emptySubsetAllowed, true);
  } finally { await f.close(); }
});

test('dirty tracking skips cold spatial capture and falls back for unknown or overflowing bounds', testOptions, async () => {
  const f = await fixture();
  try {
    const id = await f.add(1, [1, 1, 2, 2]);
    assert.equal((await f.state()).full_rebuild_required, true);
    await f.client.query('BEGIN');
    await f.client.query(`CREATE OR REPLACE FUNCTION osm.region_tile_dirty_input(tags_text TEXT,shape geometry,
      min_lon DOUBLE PRECISION,min_lat DOUBLE PRECISION,max_lon DOUBLE PRECISION,max_lat DOUBLE PRECISION)
      RETURNS JSONB LANGUAGE plpgsql IMMUTABLE AS $$ BEGIN RAISE EXCEPTION 'cold import must skip spatial capture'; END; $$`);
    await f.client.query("UPDATE osm.building_contours SET tags_json='{}' WHERE osm_id=$1", [id]);
    await f.client.query('DELETE FROM public.data_region_memberships WHERE osm_id=$1', [id]);
    await f.client.query('ROLLBACK');
    await f.clean();
    await f.client.query("INSERT INTO public.data_region_memberships (region_id,osm_type,osm_id) VALUES ($1,'way',$2)", [f.regionIds[0], f.base + 999]);
    assert.equal((await f.state()).full_rebuild_required, true);
    assert.deepEqual((await f.state()).dirty_bounds, []);
    await f.clean();
    const bounds = Array.from({ length: 257 }, (_, index) => ({ west: index / 1000, south: 0, east: index / 1000 + 0.0001, north: 0.001,
      min_lon: index / 1000, min_lat: 0, max_lon: index / 1000 + 0.0001, max_lat: 0.001, is_part: false }));
    await f.client.query('SELECT osm.append_region_tile_dirty_inputs($1,$2::jsonb)', [f.regionIds[0], JSON.stringify(bounds.slice(0, 256))]);
    assert.equal((await f.state()).dirty_bounds.length, 256);
    await f.client.query('SELECT osm.append_region_tile_dirty_inputs($1,$2::jsonb)', [f.regionIds[0], JSON.stringify(bounds.slice(256))]);
    assert.equal((await f.state()).full_rebuild_required, true);
    assert.deepEqual((await f.state()).dirty_bounds, []);
  } finally { await f.close(); }
});

test('subset export matches full canonical geometry/properties with off-window parts and stable ordering', testOptions, async () => {
  const f = await fixture();
  try {
    const parent = await f.add(1, [10, 10, 20, 20], { building: 'yes', height: '21', 'building:levels': '6', 'building:min_level': '1' });
    const inside = await f.add(2, [11, 11, 12, 12], { 'building:part': 'yes', height: '9' });
    await f.add(3, [17, 17, 19, 19], { 'building:part': 'yes', height: '40' });
    await f.add(4, [30, 30, 40, 40]);
    await f.add(5, [13, 13, 14, 14], { 'building:part': 'yes' }, [f.regionIds[1]]);
    const windows = [{ west: 10.5, south: 10.5, east: 12.5, north: 12.5 }];
    const full = await f.exportRows('full');
    const subset = await f.exportRows('subset', windows);
    assert.deepEqual(subset.rows, full.rows.filter(row => [parent, inside].includes(row.properties.osm_id)));
    assert.equal(subset.rows.length, 3);
    assert.equal(subset.rows[0].properties.render_hide_base_when_parts, 1);
    assert.equal(subset.rows[0].properties.render_height_m, 21);
    assert.equal(subset.rows[2].properties.feature_kind, 'building_remainder');
    assert.deepEqual(subset.result.regionBounds, full.result.bounds);
    assert.equal((await f.exportRows('repeat', [...windows, ...windows])).text, subset.text);
    const empty = await f.exportRows('empty', []);
    assert.deepEqual(empty.rows, []);
    assert.equal(empty.result.emptySubsetAllowed, true);
    await assert.rejects(f.exportRows('invalid', [{ west: 10, south: 0, east: 9, north: 1 }]), /Invalid region export tile window/);
  } finally { await f.close(); }
});

test('export uses one database snapshot for parts, base rows and derived remainders', testOptions, async () => {
  const f = await fixture();
  const originalQuery = Client.prototype.query;
  try {
    await f.add(1, [10, 10, 20, 20]);
    const part = await f.add(2, [11, 11, 12, 12], { 'building:part': 'yes', height: '9' });
    const before = await f.exportRows('before');
    let concurrentChange = false;
    Client.prototype.query = async function (sql, ...args) {
      if (!concurrentChange && typeof sql === 'string' && sql.includes('DECLARE region_members_base_geojson_export_cursor')) {
        concurrentChange = true;
        await originalQuery.call(f.client, `UPDATE osm.building_contours SET tags_json='{"building:part":"yes","height":"80"}',
          min_lon=15,max_lon=16,geom=ST_Multi(ST_MakeEnvelope(15,11,16,12,4326)) WHERE osm_id=$1`, [part]);
      }
      return originalQuery.call(this, sql, ...args);
    };
    const snapshot = await f.exportRows('snapshot');
    assert.equal(concurrentChange, true);
    assert.equal(snapshot.text, before.text);
    Client.prototype.query = originalQuery;
    assert.notEqual((await f.exportRows('after')).text, before.text);
  } finally { Client.prototype.query = originalQuery; await f.close(); }
});
