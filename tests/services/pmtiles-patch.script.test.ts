const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { createRequire } = require('node:module');
const frontendRequire = createRequire(path.resolve(__dirname, '../../frontend/package.json'));
const { PMTiles, tileIdToZxy } = frontendRequire('pmtiles');
const { patchPmtilesArchive, readPmtilesArchiveIndex, _test_ } = require('../../scripts/region-sync/pmtiles-patch');

// Independent minimal v3 fixture encoder. The production encoder is not used.
function varints(values) {
  const bytes = [];
  for (let value of values) {
    while (value >= 128) {
      bytes.push((value % 128) + 128);
      value = Math.floor(value / 128);
    }
    bytes.push(value);
  }
  return Buffer.from(bytes);
}
function directory(entries) {
  let previous = 0;
  return varints([
    entries.length,
    ...entries.map((entry) => {
      const delta = entry.tileId - previous;
      previous = entry.tileId;
      return delta;
    }),
    ...entries.map((entry) => entry.runLength),
    ...entries.map((entry) => entry.length),
    ...entries.map((entry) => entry.offset + 1)
  ]);
}
function fixture(file, rows, options: LooseRecord = {}) {
  const payloads = [],
    pointers = new Map();
  let offset = 0;
  const entries = rows.map((row) => {
    const raw = Buffer.from(row.data),
      key = raw.toString('hex');
    if (!pointers.has(key)) {
      const bytes = options.tileCompression === 2 ? zlib.gzipSync(raw) : raw;
      pointers.set(key, { offset, length: bytes.length });
      payloads.push(bytes);
      offset += bytes.length;
    }
    return { tileId: row.tileId, runLength: row.runLength ?? 1, ...pointers.get(key) };
  });
  let root,
    leaves = Buffer.alloc(0);
  if (options.leafSize && entries.length) {
    const chunks = [],
      refs = [];
    let leafOffset = 0;
    for (let i = 0; i < entries.length; i += options.leafSize) {
      const chunk = directory(entries.slice(i, i + options.leafSize));
      refs.push({ tileId: entries[i].tileId, runLength: 0, offset: leafOffset, length: chunk.length });
      chunks.push(chunk);
      leafOffset += chunk.length;
    }
    root = directory(refs);
    leaves = Buffer.concat(chunks);
  } else root = directory(entries);
  const metadata = Buffer.from(
    JSON.stringify(
      options.metadata ?? {
        name: 'Whole region',
        attribution: 'retained',
        vector_layers: [{ id: 'buildings', fields: { osm_key: 'String' }, minzoom: 0, maxzoom: 26 }]
      }
    )
  );
  const tileData = Buffer.concat([...payloads, Buffer.from(options.unreferenced ?? '')]);
  const header = Buffer.alloc(127);
  header.write('PMTiles');
  header[7] = 3;
  const values = [
    127,
    root.length,
    127 + root.length,
    metadata.length,
    127 + root.length + metadata.length,
    leaves.length,
    127 + root.length + metadata.length + leaves.length,
    tileData.length,
    rows.reduce((n, row) => n + (row.runLength ?? 1), 0),
    rows.length,
    options.unreferenced ? 0 : pointers.size
  ];
  values.forEach((value, index) => header.writeBigUInt64LE(BigInt(value), 8 + index * 8));
  header[96] = 0;
  header[97] = 1;
  header[98] = options.tileCompression ?? 1;
  header[99] = 1;
  header[100] = 0;
  header[101] = 26;
  header.writeInt32LE(-1800000000, 102);
  header.writeInt32LE(-850000000, 106);
  header.writeInt32LE(1800000000, 110);
  header.writeInt32LE(850000000, 114);
  fs.writeFileSync(file, Buffer.concat([header, root, metadata, leaves, tileData]));
  return { entries, root, header };
}
function workspace(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'archimap-pmtiles-patch-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return {
    root,
    base: path.join(root, 'base.pmtiles'),
    patch: path.join(root, 'patch.pmtiles'),
    output: path.join(root, 'output.pmtiles')
  };
}
function officialReader(file) {
  const bytes = fs.readFileSync(file);
  return new PMTiles({
    getKey: () => file,
    getBytes: async (offset, length) => ({ data: Uint8Array.from(bytes.subarray(offset, offset + length)).buffer })
  });
}
async function tile(reader, id) {
  const result = await reader.getZxy(...tileIdToZxy(id));
  return result ? Buffer.from(result.data).toString() : undefined;
}

test('patch replaces/adds/deletes only authoritative dirty IDs and keeps full-region metadata', async (t) => {
  const w = workspace(t),
    last = _test_.MAX_TILE_ID;
  fixture(
    w.base,
    [
      { tileId: 0, data: 'first' },
      { tileId: 1, data: 'delete' },
      { tileId: 2, data: 'keep' },
      { tileId: last, data: 'last' }
    ],
    { tileCompression: 2 }
  );
  fixture(
    w.patch,
    [
      { tileId: 0, data: 'new' },
      { tileId: 2, data: 'must ignore' },
      { tileId: 3, data: 'added' }
    ],
    {
      tileCompression: 2,
      metadata: {
        name: 'Subset',
        vector_layers: [
          { id: 'buildings', fields: { osm_key: 'String', filter_levels_num: 'Number' }, minzoom: 0, maxzoom: 26 }
        ]
      }
    }
  );
  const result = await patchPmtilesArchive({
    basePath: w.base,
    patchPath: w.patch,
    outputPath: w.output,
    dirtyTileIds: [last, 0, 1, 3, 0]
  });
  assert.deepEqual(
    [result.retainedTileCount, result.replacedTileCount, result.deletedTileCount, result.addedTileCount],
    [1, 1, 2, 1]
  );
  const reader = officialReader(w.output);
  assert.deepEqual(await Promise.all([0, 1, 2, 3, last].map((id) => tile(reader, id))), [
    'new',
    undefined,
    'keep',
    'added',
    undefined
  ]);
  const metadata = await reader.getMetadata();
  assert.equal(metadata.name, 'Whole region');
  assert.equal(metadata.attribution, 'retained');
  assert.equal(metadata.vector_layers[0].fields.filter_levels_num, 'Number');
  const header = await reader.getHeader();
  assert.equal(header.minLon, -180);
  assert.equal(header.maxLon, 180);
  assert.equal(header.clustered, false);
});

test('huge RLE runs split without enumerating tiles and preserve deduplicated payloads', async (t) => {
  const w = workspace(t),
    last = _test_.MAX_TILE_ID,
    middle = Math.floor(last / 2);
  fixture(w.base, [{ tileId: 0, runLength: last + 1, data: 'one shared payload' }]);
  const result = await patchPmtilesArchive({ basePath: w.base, outputPath: w.output, dirtyTileIds: [0, middle, last] });
  assert.equal(result.addressedTileCount, last - 2);
  assert.equal(result.tileEntryCount, 2);
  assert.equal(result.tileContentCount, 1);
  const reader = officialReader(w.output);
  assert.deepEqual(await Promise.all([0, 1, middle, middle + 1, last].map((id) => tile(reader, id))), [
    undefined,
    'one shared payload',
    undefined,
    'one shared payload',
    undefined
  ]);
  assert.ok(result.bytes < 1000);
});

test('null patch can delete the last tile; official reader accepts an empty archive', async (t) => {
  const w = workspace(t);
  fixture(w.base, [{ tileId: 0, data: 'only' }]);
  const result = await patchPmtilesArchive({
    basePath: w.base,
    patchPath: null,
    outputPath: w.output,
    dirtyTileIds: [0]
  });
  assert.equal(result.addressedTileCount, 0);
  assert.equal(result.tileContentCount, 0);
  assert.equal(await tile(officialReader(w.output), 0), undefined);
  assert.deepEqual((await readPmtilesArchiveIndex(w.output)).entries, []);
});

test('all entries survive leaf-directory roundtrip and root stays inside the first 16KiB', async (t) => {
  const w = workspace(t);
  const rows = Array.from({ length: 18000 }, (_, i) => ({ tileId: i * 2, data: `tile${i}` }));
  fixture(w.base, rows, { leafSize: 3000 });
  const result = await patchPmtilesArchive({ basePath: w.base, outputPath: w.output, dirtyTileIds: [] });
  const index = await readPmtilesArchiveIndex(w.output);
  assert.equal(result.tileEntryCount, rows.length);
  assert.ok(index.header.leafDirectoryLength > 0);
  assert.ok(index.header.rootDirectoryOffset + index.header.rootDirectoryLength <= 16384);
  const reader = officialReader(w.output);
  for (const id of [0, 5998, 6000, 17998, 35998]) assert.equal(await tile(reader, id), `tile${id / 2}`);
  assert.deepEqual(
    index.entries.map((entry) => entry.tileId),
    rows.map((row) => row.tileId)
  );
});

test('RLE patch is intersected with dirty ranges and unreferenced input bytes are compacted', async (t) => {
  const w = workspace(t);
  fixture(w.base, [{ tileId: 0, runLength: 10, data: 'old' }], { unreferenced: 'x'.repeat(100000) });
  fixture(w.patch, [{ tileId: 0, runLength: 10, data: 'new' }]);
  const result = await patchPmtilesArchive({
    basePath: w.base,
    patchPath: w.patch,
    outputPath: w.output,
    dirtyTileIds: [2, 3, 7]
  });
  assert.equal(result.replacedTileCount, 3);
  assert.equal(result.tileContentCount, 2);
  assert.ok(result.bytes < 1000);
  const reader = officialReader(w.output);
  assert.deepEqual(await Promise.all(Array.from({ length: 10 }, (_, id) => tile(reader, id))), [
    'old',
    'old',
    'new',
    'new',
    'old',
    'old',
    'old',
    'new',
    'old',
    'old'
  ]);
});

test('updates bounds only when explicitly given full-region bounds', async (t) => {
  const w = workspace(t);
  fixture(w.base, [{ tileId: 0, data: 'tile' }]);
  await patchPmtilesArchive({
    basePath: w.base,
    outputPath: w.output,
    dirtyTileIds: [],
    bounds: { west: 40, south: 50, east: 48, north: 60 }
  });
  const reader = officialReader(w.output);
  assert.equal((await reader.getHeader()).minLon, 40);
  assert.deepEqual((await reader.getMetadata()).bounds, [40, 50, 48, 60]);
});

test('rejects incompatible zoom, compression, layer identity and field types without output', async (t) => {
  const w = workspace(t);
  fixture(w.base, [{ tileId: 0, data: 'tile' }]);
  const variants = [
    { tileCompression: 2 },
    { metadata: { vector_layers: [{ id: 'other', fields: { osm_key: 'String' } }] } },
    { metadata: { vector_layers: [{ id: 'buildings', fields: { osm_key: 'Number' } }] } },
    { metadata: { vector_layers: [{ id: 'buildings', fields: { surprise: 'String' } }] } }
  ];
  for (const options of variants) {
    fixture(w.patch, [{ tileId: 0, data: 'new' }], options);
    await assert.rejects(
      patchPmtilesArchive({ basePath: w.base, patchPath: w.patch, outputPath: w.output, dirtyTileIds: [0] }),
      /Incompatible|Unknown/
    );
    assert.equal(fs.existsSync(w.output), false);
  }
  fixture(w.patch, [{ tileId: 0, data: 'new' }]);
  const bytes = fs.readFileSync(w.patch);
  bytes[101] = 25;
  fs.writeFileSync(w.patch, bytes);
  await assert.rejects(
    patchPmtilesArchive({ basePath: w.base, patchPath: w.patch, outputPath: w.output, dirtyTileIds: [0] }),
    /Incompatible/
  );
});

test('rejects truncated, overlapping, unsafe, malformed and unsupported archive structures', async (t) => {
  const w = workspace(t);
  fixture(w.base, [
    { tileId: 0, data: 'one' },
    { tileId: 2, data: 'two' }
  ]);
  const valid = fs.readFileSync(w.base);
  const mutations = [
    (bytes) => bytes.subarray(0, 126),
    (bytes) => bytes.subarray(0, bytes.length - 1),
    (bytes) => {
      bytes.writeBigUInt64LE(1n << 54n, 56);
      return bytes;
    },
    (bytes) => {
      bytes[97] = 4;
      return bytes;
    },
    (bytes) => {
      bytes[98] = 3;
      return bytes;
    },
    (bytes) => {
      bytes.writeBigUInt64LE(127n, 24);
      return bytes;
    },
    (bytes) => {
      bytes.writeBigUInt64LE(99n, 80);
      return bytes;
    },
    (bytes) => {
      bytes[129] = 0;
      return bytes;
    }, // Duplicate delta tile ID.
    (bytes) => {
      bytes[127] = 127;
      return bytes;
    }, // Impossible directory count.
    (bytes) => {
      bytes[133] = 0;
      return bytes;
    } // Zero content length.
  ];
  for (const mutate of mutations) {
    fs.writeFileSync(w.patch, mutate(Buffer.from(valid)));
    await assert.rejects(readPmtilesArchiveIndex(w.patch));
  }
  await assert.rejects(readPmtilesArchiveIndex(w.base, { limits: { entries: 1 } }), /limit/);
  await assert.rejects(readPmtilesArchiveIndex(w.base, { limits: { metadataBytes: 1 } }), /limit/);
  await assert.rejects(readPmtilesArchiveIndex(w.base, { limits: { totalDirectoryBytes: 1 } }), /limit/);
  fixture(w.patch, [{ tileId: 0, data: 'one' }], { leafSize: 1 });
  const brokenLeaf = fs.readFileSync(w.patch);
  brokenLeaf.writeBigUInt64LE(0n, 48);
  fs.writeFileSync(w.patch, brokenLeaf);
  await assert.rejects(readPmtilesArchiveIndex(w.patch), /leaf outside/);
});

test('refuses overwrite, input aliases and invalid dirty IDs', async (t) => {
  const w = workspace(t);
  fixture(w.base, [{ tileId: 0, data: 'tile' }]);
  const original = fs.readFileSync(w.base);
  await assert.rejects(patchPmtilesArchive({ basePath: w.base, outputPath: w.base, dirtyTileIds: [] }), /differ/);
  fs.writeFileSync(w.output, 'caller file');
  await assert.rejects(
    patchPmtilesArchive({ basePath: w.base, outputPath: w.output, dirtyTileIds: [] }),
    /already exists/
  );
  assert.equal(fs.readFileSync(w.output, 'utf8'), 'caller file');
  assert.deepEqual(fs.readFileSync(w.base), original);
  for (const ids of [[-1], [1.5], [_test_.MAX_TILE_ID + 1], [Number.MAX_SAFE_INTEGER + 1], ['1']]) {
    await assert.rejects(
      patchPmtilesArchive({ basePath: w.base, outputPath: path.join(w.root, 'invalid'), dirtyTileIds: ids }),
      /Invalid|exceeds/
    );
  }
});

test('cancellation while reading or after output creation cleans only the owned output', async (t) => {
  const w = workspace(t);
  fixture(w.base, [{ tileId: 0, data: 'tile' }]);
  await assert.rejects(
    patchPmtilesArchive({ basePath: w.base, outputPath: w.output, dirtyTileIds: [], signal: AbortSignal.abort() }),
    { name: 'AbortError' }
  );
  assert.equal(fs.existsSync(w.output), false);
  let sawCreatedOutput = false;
  const signal = {
    get aborted() {
      if (fs.existsSync(w.output)) sawCreatedOutput = true;
      return sawCreatedOutput;
    }
  };
  await assert.rejects(patchPmtilesArchive({ basePath: w.base, outputPath: w.output, dirtyTileIds: [], signal }), {
    name: 'AbortError'
  });
  assert.equal(sawCreatedOutput, true);
  assert.equal(fs.existsSync(w.output), false);
  assert.equal(fs.existsSync(w.base), true);
});
