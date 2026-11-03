const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { gzipSync } = require('node:zlib');
const { spawn, spawnSync } = require('node:child_process');
const {
  applyReplicationChanges,
  commandForOsmium,
  filterBuildingSource,
  readPbfReplicationMetadata
} = require('../../scripts/region-sync/osmium-tool');

const enabled = Boolean(process.env.OSMIUM_BIN || process.env.OSMIUM_CONTAINER);

test(
  'real Osmium preserves dependencies, all tags, node movement, deletes and equal-version diff order',
  {
    skip: !enabled,
    timeout: 60000
  },
  async () => {
    const env = { ...process.env };
    const baseDir = env.OSMIUM_HOST_DATA_ROOT || env.ARCHIMAP_DATA_DIR || os.tmpdir();
    const dir = fs.mkdtempSync(path.join(baseDir, 'archimap-osmium-test-'));
    const paths = ['base.osm', 'base.osm.pbf', '001.osc.gz', '002.osc.gz', 'next.osm.pbf', 'buildings.osm.pbf'];
    const [xml, base, first, second, target, filtered] = paths.map((name) => path.join(dir, name));
    const state = {
      baseUrl: 'https://download.openstreetmap.fr/replication/example/minute',
      sequence: 100,
      timestamp: '2026-11-03T00:00:00.000Z'
    };
    function run(args, filePaths) {
      const command = commandForOsmium(args, filePaths, env);
      const result = spawnSync(command.executable, command.args, { env, encoding: 'utf8', windowsHide: true });
      assert.equal(result.status, 0, result.stderr || String(result.error));
      return result.stdout;
    }
    const nodes = '<nd ref="1"/><nd ref="2"/><nd ref="3"/><nd ref="1"/>';
    try {
      fs.writeFileSync(
        xml,
        `<?xml version="1.0"?><osm version="0.6">
      <node id="1" version="1" lat="56" lon="44"><tag k="node:custom" v="kept"/></node>
      <node id="2" version="1" lat="56" lon="44.01"/>
      <node id="3" version="1" lat="56.01" lon="44"/>
      <node id="4" version="1" lat="56.02" lon="44"/>
      <node id="5" version="1" lat="56.02" lon="44"/>
      <way id="10" version="1">${nodes}<tag k="building" v="yes"/></way>
      <way id="20" version="7">${nodes}<tag k="building" v="yes"/><tag k="custom:key" v="kept"/></way>
      <way id="21" version="1">${nodes}<tag k="member:custom" v="kept"/></way>
      <way id="22" version="1"><nd ref="4"/><nd ref="5"/><tag k="highway" v="service"/></way>
      <way id="23" version="1">${nodes}<tag k="building:part" v="roof"/></way>
      <relation id="40" version="3"><member type="way" ref="20" role="outer"/>
        <member type="way" ref="21" role="inner"/>
        <tag k="type" v="multipolygon"/><tag k="building" v="yes"/><tag k="another:custom" v="kept"/>
      </relation></osm>`
      );
      run(
        [
          'cat',
          xml,
          '-o',
          base,
          `--output-header=osmosis_replication_base_url=${state.baseUrl}`,
          '--output-header=osmosis_replication_sequence_number=100',
          `--output-header=osmosis_replication_timestamp=${state.timestamp}`
        ],
        [xml, base]
      );
      assert.deepEqual(await readPbfReplicationMetadata(base, { env }), state);
      fs.writeFileSync(
        first,
        gzipSync(`<?xml version="1.0"?><osmChange version="0.6">
      <modify><node id="2" version="2" lat="56" lon="44.02"/></modify>
      <create><way id="30" version="1" timestamp="2026-11-03T00:01:00Z">${nodes}
        <tag k="building" v="yes"/><tag k="name" v="first"/></way></create></osmChange>`)
      );
      fs.writeFileSync(
        second,
        gzipSync(`<?xml version="1.0"?><osmChange version="0.6">
      <delete><node id="4" version="2"/><way id="10" version="2"/></delete>
      <modify><way id="30" version="1" timestamp="2026-11-03T00:01:00Z">${nodes}
        <tag k="building" v="yes"/><tag k="name" v="last"/></way></modify></osmChange>`)
      );
      const nextState = { ...state, sequence: 102, timestamp: '2026-11-03T00:02:00.000Z' };
      assert.deepEqual(
        await applyReplicationChanges({
          basePath: base,
          changePaths: [first, second],
          targetPath: target,
          state: nextState,
          env
        }),
        nextState
      );
      const output = run(['cat', target, '-f', 'osm'], [target]);
      const movedNode = output.match(/<node id="2"[^>]*>/)?.[0] || '';
      assert.match(movedNode, /version="2"/);
      assert.equal(Number(movedNode.match(/lon="([^"]+)"/)?.[1]), 44.02);
      assert.doesNotMatch(output, /<(?:node id="4"|way id="10")(?:\s|>)/);
      assert.match(output, /<way id="20" version="7"/);
      assert.match(output, /k="custom:key" v="kept"/);
      assert.match(output, /k="another:custom" v="kept"/);
      assert.match(output, /<member type="way" ref="20" role="outer"/);
      assert.match(output, /<way id="30"[\s\S]*?<nd ref="1"\/>[\s\S]*?<nd ref="2"\/>[\s\S]*?<nd ref="3"\/>/);
      assert.match(output, /k="name" v="last"/);
      assert.doesNotMatch(output, /v="first"/);
      const paddingDiff = path.join(dir, 'padding.osc.gz');
      const batchedTarget = path.join(dir, 'batched.osm.pbf');
      fs.writeFileSync(paddingDiff, gzipSync('<osmChange version="0.6"/>'));
      const batchCalls = [];
      await applyReplicationChanges({
        basePath: base,
        changePaths: [first, ...Array(80).fill(paddingDiff), second],
        targetPath: batchedTarget,
        state: nextState,
        env,
        _argumentBudgetBytes: 2048,
        spawnRef: (exe, args, options) => {
          if (args.includes('apply-changes')) batchCalls.push(args);
          return spawn(exe, args, options);
        }
      });
      assert.ok(batchCalls.length > 1);
      assert.ok(batchCalls[0].some((arg) => arg.endsWith('/001.osc.gz') || arg.endsWith('\\001.osc.gz')));
      assert.ok(!batchCalls[0].some((arg) => arg.endsWith('002.osc.gz')));
      assert.equal(run(['cat', batchedTarget, '-f', 'osm'], [batchedTarget]), output);
      assert.ok(!fs.readdirSync(dir).some((name) => name.startsWith('.replication-')));
      await filterBuildingSource({ basePath: target, targetPath: filtered, env });
      const buildingOutput = run(['cat', filtered, '-f', 'osm'], [filtered]);
      assert.ok(buildingOutput.includes(movedNode));
      assert.match(buildingOutput, /<way id="30"/);
      assert.match(buildingOutput, /<way id="21"/);
      assert.match(buildingOutput, /<way id="23"/);
      assert.match(buildingOutput, /<relation id="40"/);
      for (const key of ['custom:key', 'another:custom', 'node:custom', 'member:custom']) {
        assert.ok(buildingOutput.includes(`k="${key}" v="kept"`));
      }
      assert.doesNotMatch(buildingOutput, /<(?:node id="5"|way id="22")(?:\s|>)/);
      await assert.rejects(filterBuildingSource({ basePath: target, targetPath: filtered, env }), /failed/);
      const metadataDiff = path.join(dir, '003.osc.gz');
      const advanced = path.join(dir, 'advanced.osm.pbf');
      const advancedFiltered = path.join(dir, 'advanced-buildings.osm.pbf');
      fs.writeFileSync(metadataDiff, gzipSync('<osmChange version="0.6"/>'));
      const advancedState = { ...nextState, sequence: 103, timestamp: '2026-11-03T00:03:00.000Z' };
      await applyReplicationChanges({
        basePath: target,
        changePaths: [metadataDiff],
        targetPath: advanced,
        state: advancedState,
        env
      });
      await filterBuildingSource({ basePath: advanced, targetPath: advancedFiltered, env });
      assert.deepEqual(await readPbfReplicationMetadata(advanced, { env }), advancedState);
      assert.notDeepEqual(fs.readFileSync(target), fs.readFileSync(advanced));
      assert.equal(
        run(['cat', advancedFiltered, '-f', 'opl'], [advancedFiltered]),
        run(['cat', filtered, '-f', 'opl'], [filtered])
      );
      // Applying never overwrites an existing target or mutates the base snapshot.
      await assert.rejects(
        applyReplicationChanges({
          basePath: base,
          changePaths: [first],
          targetPath: target,
          state: nextState,
          env
        }),
        /failed/
      );
      assert.deepEqual(await readPbfReplicationMetadata(base, { env }), state);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
);
