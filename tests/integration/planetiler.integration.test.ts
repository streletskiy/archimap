const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { runPlanetilerBuild } = require('../../scripts/region-sync/planetiler');
const { formatRenderedGeojsonFeatureLine } = require('../../scripts/region-sync/common');

const enabled = Boolean(process.env.PLANETILER_BIN || process.env.PLANETILER_CONTAINER);

test(
  'real Planetiler keeps geometry and properties while full/subset builds retain stable OSM IDs',
  {
    skip: !enabled,
    timeout: 120000
  },
  async () => {
    const frontend = path.resolve(__dirname, '../../frontend');
    const { PMTiles } = require(require.resolve('pmtiles', { paths: [frontend] }));
    const { VectorTile } = require(require.resolve('@mapbox/vector-tile', { paths: [frontend] }));
    const { PbfReader } = require(require.resolve('pbf', { paths: [frontend] }));
    const env = { ...process.env };
    const dir = fs.mkdtempSync(
      path.join(env.PLANETILER_HOST_DATA_ROOT || os.tmpdir(), 'archimap-planetiler-integration-')
    );
    function polygon(w, s, e, n) {
      return JSON.stringify({
        type: 'Polygon',
        coordinates: [
          [
            [w, s],
            [e, s],
            [e, n],
            [w, n],
            [w, s]
          ]
        ]
      });
    }
    const first = formatRenderedGeojsonFeatureLine('way', 1, polygon(10, 10, 10.003, 10.003), 'building', 12, 0, 0);
    const parent = formatRenderedGeojsonFeatureLine('way', 100, polygon(44, 56, 44.003, 56.003), 'building', 12, 0, 1);
    const remainder = formatRenderedGeojsonFeatureLine(
      'way',
      100,
      polygon(44, 56, 44.001, 56.003),
      'building_remainder',
      12,
      0,
      0
    );
    const relation = formatRenderedGeojsonFeatureLine(
      'relation',
      200,
      polygon(44.004, 56, 44.007, 56.003),
      'building',
      18,
      3,
      0
    );
    const input = path.join(dir, 'full.ndjson');
    const subset = path.join(dir, 'subset.ndjson');
    const legacy = path.join(dir, 'legacy.pmtiles');
    const full = path.join(dir, 'full.pmtiles');
    const partial = path.join(dir, 'subset.pmtiles');
    const attrs = [
      'filter_schema',
      'filter_levels',
      'filter_levels_num',
      'feature_kind',
      'osm_id',
      'osm_key',
      'osm_type',
      'render_height_m',
      'render_hide_base_when_parts',
      'render_min_height_m'
    ];
    function build(inputPath, outputPath, legacyIds = false) {
      const schemaPath = outputPath + '.yml';
      const spawnSyncRef = (exe, args, options) => {
        // Run the exact old schema on the same tool, without a production legacy-ID switch.
        if (legacyIds && fs.existsSync(schemaPath)) {
          fs.writeFileSync(
            schemaPath,
            fs.readFileSync(schemaPath, 'utf8').replace(/^ {4}id:.*$/m, "    id: '${feature.id}'")
          );
        }
        return spawnSync(exe, args, { ...options, stdio: 'pipe', maxBuffer: 8 * 1024 * 1024 });
      };
      runPlanetilerBuild({
        inputPath,
        outputPath,
        schemaPath,
        schemaName: 'Parity test',
        layer: 'buildings',
        minZoom: 13,
        maxZoom: 16,
        attributeKeys: attrs,
        includeFeatureId: true,
        env,
        spawnSyncRef
      });
    }
    function archive(file) {
      return new PMTiles({
        getKey: () => file,
        async getBytes(offset, length) {
          const fd = fs.openSync(file, 'r');
          try {
            const data = Buffer.alloc(Math.max(0, Math.min(length, fs.fstatSync(fd).size - offset)));
            const size = fs.readSync(fd, data, 0, data.length, offset);
            return { data: data.buffer.slice(data.byteOffset, data.byteOffset + size) };
          } finally {
            fs.closeSync(fd);
          }
        }
      });
    }
    function tilePoint(lon, lat, z) {
      const scale = 2 ** z;
      const radians = (lat * Math.PI) / 180;
      return [
        Math.floor(((lon + 180) / 360) * scale),
        Math.floor(((1 - Math.asinh(Math.tan(radians)) / Math.PI) / 2) * scale)
      ];
    }
    async function readTile(reader, z, x, y, includeIds) {
      const tile = await reader.getZxy(z, x, y);
      if (!tile) return [];
      const layer = new VectorTile(new PbfReader(new Uint8Array(tile.data))).layers.buildings;
      const features = [];
      for (let i = 0; i < layer.length; i++) {
        const feature = layer.feature(i);
        features.push({
          ...(includeIds ? { id: feature.id } : {}),
          type: feature.type,
          extent: feature.extent,
          properties: feature.properties,
          geometry: feature.loadGeometry()
        });
      }
      return features.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    }
    try {
      fs.writeFileSync(input, first + parent + remainder + relation);
      fs.writeFileSync(subset, parent + remainder + relation);
      build(input, legacy, true);
      build(input, full);
      build(subset, partial);
      const [oldReader, fullReader, subsetReader] = [legacy, full, partial].map(archive);
      let checkedFeatures = 0;
      const identities = new Set();
      for (let z = 13; z <= 16; z++) {
        const [west, south] = tilePoint(44, 56, z);
        const [east, north] = tilePoint(44.007, 56.003, z);
        for (let x = west - 1; x <= east + 1; x++) {
          for (let y = north - 1; y <= south + 1; y++) {
            assert.deepEqual(await readTile(fullReader, z, x, y, false), await readTile(oldReader, z, x, y, false));
            const current = await readTile(fullReader, z, x, y, true);
            assert.deepEqual(await readTile(subsetReader, z, x, y, true), current);
            for (const f of current) {
              const expected = Number(f.properties.osm_id) * 2 + (f.properties.osm_type === 'relation' ? 1 : 0);
              assert.equal(f.id, expected);
              identities.add(`${f.id}:${f.properties.feature_kind}`);
              checkedFeatures++;
            }
          }
        }
      }
      assert.ok(checkedFeatures > 0);
      assert.deepEqual([...identities].sort(), ['200:building', '200:building_remainder', '401:building']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
);
