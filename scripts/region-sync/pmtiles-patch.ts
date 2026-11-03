const fs = require('node:fs/promises');
const path = require('node:path');
const zlib = require('node:zlib');

// PMTiles v3: https://github.com/protomaps/PMTiles/blob/main/spec/v3/spec.md
const HEADER_BYTES = 127;
const ROOT_LIMIT = 16384 - HEADER_BYTES;
const MAX_TILE_ID = Number(((1n << 54n) - 1n) / 3n - 1n); // Last tile at z26.
const COPY_BYTES = 1024 * 1024;
const DEFAULT_LIMITS = {
  entries: 2000000,
  directoryBytes: 32 * 1024 * 1024,
  totalDirectoryBytes: 128 * 1024 * 1024,
  metadataBytes: 8 * 1024 * 1024,
  directories: 65536,
  depth: 4
};
const HEADER_FIELDS = [
  'rootDirectoryOffset',
  'rootDirectoryLength',
  'jsonMetadataOffset',
  'jsonMetadataLength',
  'leafDirectoryOffset',
  'leafDirectoryLength',
  'tileDataOffset',
  'tileDataLength',
  'numAddressedTiles',
  'numTileEntries',
  'numTileContents'
];
const KNOWN_FIELDS = {
  feature_kind: 'String',
  filter_levels: 'String',
  filter_levels_num: 'Number',
  filter_schema: 'Number',
  osm_id: 'Number',
  osm_key: 'String',
  osm_type: 'String',
  render_height_m: 'Number',
  render_hide_base_when_parts: 'Number',
  render_min_height_m: 'Number'
};

function checkAbort(signal) {
  if (signal?.aborted) throw Object.assign(new Error('PMTiles patch cancelled'), { name: 'AbortError' });
}
function safe(value, label = 'integer') {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid PMTiles ${label}`);
  return value;
}
function sum(a, b) {
  return safe(a + b, 'range');
}
function zoomStart(zoom) {
  return Number(((1n << BigInt(zoom * 2)) - 1n) / 3n);
}
function range(offset, length, size) {
  if (safe(offset) < HEADER_BYTES || sum(offset, safe(length)) > size) throw new Error('PMTiles section outside file');
}
async function readBytes(handle, offset, length, signal) {
  checkAbort(signal);
  const buffer = Buffer.allocUnsafe(length);
  let done = 0;
  while (done < length) {
    checkAbort(signal);
    const result = await handle.read(buffer, done, length - done, offset + done);
    if (!result.bytesRead) throw new Error('Truncated PMTiles file');
    done += result.bytesRead;
  }
  return buffer;
}
function inflate(buffer, compression, limit) {
  if (buffer.length > limit) throw new Error('PMTiles compressed section exceeds limit');
  if (compression === 1) return buffer;
  if (compression !== 2) throw new Error('Unsupported PMTiles compression');
  return zlib.gunzipSync(buffer, { maxOutputLength: limit });
}
function readHeader(buffer, fileSize) {
  if (buffer.toString('utf8', 0, 7) !== 'PMTiles' || buffer[7] !== 3) throw new Error('PMTiles v3 required');
  const header: LooseRecord = {};
  HEADER_FIELDS.forEach((key, index) => {
    header[key] = safe(Number(buffer.readBigUInt64LE(8 + index * 8)), key);
  });
  Object.assign(header, {
    clustered: buffer[96],
    internalCompression: buffer[97],
    tileCompression: buffer[98],
    tileType: buffer[99],
    minZoom: buffer[100],
    maxZoom: buffer[101],
    minLon: buffer.readInt32LE(102) / 1e7,
    minLat: buffer.readInt32LE(106) / 1e7,
    maxLon: buffer.readInt32LE(110) / 1e7,
    maxLat: buffer.readInt32LE(114) / 1e7,
    centerZoom: buffer[118],
    centerLon: buffer.readInt32LE(119) / 1e7,
    centerLat: buffer.readInt32LE(123) / 1e7
  });
  if (![1, 2].includes(header.internalCompression) || ![1, 2].includes(header.tileCompression))
    throw new Error('Unsupported PMTiles compression');
  if (header.tileType !== 1 || header.clustered > 1 || header.minZoom > header.maxZoom || header.maxZoom > 26)
    throw new Error('Unsupported PMTiles tile type or zoom');
  const sections = [
    [header.rootDirectoryOffset, header.rootDirectoryLength],
    [header.jsonMetadataOffset, header.jsonMetadataLength],
    [header.leafDirectoryOffset, header.leafDirectoryLength],
    [header.tileDataOffset, header.tileDataLength]
  ];
  for (const [offset, length] of sections) range(offset, length, fileSize);
  const nonempty = sections.filter(([, length]) => length).sort((a, b) => a[0] - b[0]);
  for (let i = 1; i < nonempty.length; i++)
    if (nonempty[i][0] < sum(nonempty[i - 1][0], nonempty[i - 1][1])) throw new Error('Overlapping PMTiles sections');
  if (
    !header.rootDirectoryLength ||
    !header.jsonMetadataLength ||
    sum(header.rootDirectoryOffset, header.rootDirectoryLength) > 16384
  )
    throw new Error('Invalid PMTiles root directory');
  return header;
}
function decodeDirectory(buffer, limit) {
  let position = 0;
  function varint() {
    let value = 0,
      factor = 1;
    for (let i = 0; i < 8; i++) {
      if (position >= buffer.length) throw new Error('Truncated PMTiles varint');
      const byte = buffer[position++];
      value += (byte & 127) * factor;
      safe(value, 'varint');
      if (byte < 128) return value;
      factor *= 128;
    }
    throw new Error('Oversized PMTiles varint');
  }
  const count = varint();
  if (count > limit || count * 4 > buffer.length - position) throw new Error('PMTiles directory entry limit exceeded');
  const entries = [];
  let tileId = 0;
  for (let i = 0; i < count; i++) {
    const delta = varint();
    if (i && !delta) throw new Error('Unordered PMTiles directory');
    tileId = sum(tileId, delta);
    if (tileId > MAX_TILE_ID) throw new Error('PMTiles tile ID exceeds z26');
    entries.push({ tileId, runLength: 0, length: 0, offset: 0 });
  }
  for (const entry of entries) entry.runLength = varint();
  for (const entry of entries) {
    entry.length = varint();
    if (!entry.length) throw new Error('Zero PMTiles entry length');
  }
  for (let i = 0; i < count; i++) {
    const value = varint();
    if (!value && !i) throw new Error('Invalid first PMTiles offset');
    entries[i].offset = value ? value - 1 : sum(entries[i - 1].offset, entries[i - 1].length);
  }
  if (position !== buffer.length) throw new Error('Trailing PMTiles directory data');
  return entries;
}

async function openArchive(filePath, { signal = null, limits: overrides = {} }: LooseRecord = {}) {
  const limits = { ...DEFAULT_LIMITS, ...overrides };
  for (const value of Object.values(limits))
    if (!Number.isSafeInteger(value) || Number(value) <= 0) throw new Error('Invalid PMTiles resource limit');
  checkAbort(signal);
  const handle = await fs.open(filePath, 'r');
  try {
    const fileSize = safe((await handle.stat()).size, 'file size');
    if (fileSize < HEADER_BYTES) throw new Error('Truncated PMTiles header');
    const rawHeader = await readBytes(handle, 0, HEADER_BYTES, signal);
    const header = readHeader(rawHeader, fileSize);
    if (header.jsonMetadataLength > limits.metadataBytes) throw new Error('PMTiles metadata limit exceeded');
    const metadata = JSON.parse(
      inflate(
        await readBytes(handle, header.jsonMetadataOffset, header.jsonMetadataLength, signal),
        header.internalCompression,
        limits.metadataBytes
      ).toString('utf8')
    );
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata) || !Array.isArray(metadata.vector_layers))
      throw new Error('Invalid PMTiles vector metadata');
    const entries = [],
      leafRanges = [],
      visited = new Set();
    let decodedBytes = 0,
      directoryCount = 0,
      allEntryCount = 0;
    async function visit(offset, length, lower, upper, depth) {
      checkAbort(signal);
      if (depth > limits.depth || ++directoryCount > limits.directories || length > limits.directoryBytes)
        throw new Error('PMTiles directory limit exceeded');
      const key = `${offset}/${length}`;
      if (visited.has(key)) throw new Error('Repeated PMTiles leaf pointer');
      visited.add(key);
      const data = inflate(
        await readBytes(handle, offset, length, signal),
        header.internalCompression,
        limits.directoryBytes
      );
      decodedBytes += data.length;
      if (decodedBytes > limits.totalDirectoryBytes) throw new Error('PMTiles index byte limit exceeded');
      const directory = decodeDirectory(data, limits.entries);
      allEntryCount += directory.length;
      if (allEntryCount > limits.entries) throw new Error('PMTiles index entry limit exceeded');
      if (depth && (!directory.length || directory[0].tileId !== lower))
        throw new Error('Invalid PMTiles leaf first tile');
      for (let i = 0; i < directory.length; i++) {
        const entry = directory[i],
          next = directory[i + 1]?.tileId ?? upper;
        if (entry.tileId < lower || entry.tileId >= upper) throw new Error('PMTiles tile outside directory range');
        if (entry.runLength) {
          if (sum(entry.tileId, entry.runLength) > next || sum(entry.offset, entry.length) > header.tileDataLength)
            throw new Error('Overlapping PMTiles tile range');
          entries.push(entry);
        } else {
          if (sum(entry.offset, entry.length) > header.leafDirectoryLength)
            throw new Error('PMTiles leaf outside section');
          leafRanges.push([entry.offset, entry.length]);
          await visit(header.leafDirectoryOffset + entry.offset, entry.length, entry.tileId, next, depth + 1);
        }
      }
    }
    await visit(
      header.rootDirectoryOffset,
      header.rootDirectoryLength,
      zoomStart(header.minZoom),
      zoomStart(header.maxZoom + 1),
      0
    );
    leafRanges.sort((a, b) => a[0] - b[0]);
    for (let i = 1; i < leafRanges.length; i++)
      if (leafRanges[i][0] < sum(leafRanges[i - 1][0], leafRanges[i - 1][1]))
        throw new Error('Overlapping PMTiles leaf payloads');
    const contents = new Map();
    let addressed = 0;
    for (const entry of entries) {
      addressed = sum(addressed, entry.runLength);
      contents.set(`${entry.offset}/${entry.length}`, entry);
    }
    const blobs = [...contents.values()].sort((a, b) => a.offset - b.offset);
    for (let i = 1; i < blobs.length; i++)
      if (blobs[i].offset < sum(blobs[i - 1].offset, blobs[i - 1].length))
        throw new Error('Overlapping PMTiles tile payloads');
    for (const [field, actual] of [
      ['numAddressedTiles', addressed],
      ['numTileEntries', entries.length],
      ['numTileContents', contents.size]
    ]) {
      if (header[field] && header[field] !== actual) throw new Error(`PMTiles ${field} mismatch`);
    }
    return { handle, filePath: await fs.realpath(filePath), rawHeader, header, metadata, entries, fileSize };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function readPmtilesArchiveIndex(filePath, options: LooseRecord = {}) {
  const archive = await openArchive(filePath, options);
  try {
    return { header: archive.header, metadata: archive.metadata, entries: archive.entries, fileSize: archive.fileSize };
  } finally {
    await archive.handle.close();
  }
}

function dirtyRanges(dirtyTileIds) {
  if (!Array.isArray(dirtyTileIds) || dirtyTileIds.length > DEFAULT_LIMITS.entries)
    throw new Error('Invalid PMTiles dirty tile list');
  const sorted = [
    ...new Set(
      dirtyTileIds.map((id) => {
        safe(id, 'dirty tile ID');
        if (id > MAX_TILE_ID) throw new Error('Dirty PMTiles tile ID exceeds z26');
        return id;
      })
    )
  ].sort((a: number, b: number) => a - b);
  const ranges = [];
  for (const id of sorted) {
    if (ranges.length && ranges.at(-1)[1] === id) ranges.at(-1)[1]++;
    else ranges.push([id, id + 1]);
  }
  return ranges;
}

// Intersect/subtract intervals, never expand an RLE run into individual tiles.
function selectRanges(archive, ranges, keepDirty) {
  const result = [];
  let first = 0;
  for (const entry of archive.entries) {
    const end = entry.tileId + entry.runLength;
    while (first < ranges.length && ranges[first][1] <= entry.tileId) first++;
    let cursor = entry.tileId;
    for (let i = first; i < ranges.length && ranges[i][0] < end; i++) {
      const start = Math.max(entry.tileId, ranges[i][0]),
        stop = Math.min(end, ranges[i][1]);
      if (keepDirty) result.push({ ...entry, tileId: start, runLength: stop - start, archive });
      else if (cursor < start) result.push({ ...entry, tileId: cursor, runLength: start - cursor, archive });
      cursor = stop;
    }
    if (!keepDirty && cursor < end) result.push({ ...entry, tileId: cursor, runLength: end - cursor, archive });
  }
  return result;
}
function overlapCount(left, right) {
  let i = 0,
    j = 0,
    total = 0;
  while (i < left.length && j < right.length) {
    const a = left[i],
      b = right[j],
      aEnd = a.tileId + a.runLength,
      bEnd = b.tileId + b.runLength;
    total += Math.max(0, Math.min(aEnd, bEnd) - Math.max(a.tileId, b.tileId));
    if (aEnd <= bEnd) i++;
    else j++;
  }
  return total;
}
function mergedMetadata(base, patch, bounds) {
  const metadata = structuredClone(base.metadata);
  const layers = new Map();
  for (const layer of metadata.vector_layers) {
    if (
      !layer ||
      typeof layer.id !== 'string' ||
      !layer.id ||
      layers.has(layer.id) ||
      !layer.fields ||
      typeof layer.fields !== 'object' ||
      Array.isArray(layer.fields)
    )
      throw new Error('Invalid PMTiles layer metadata');
    layers.set(layer.id, layer);
  }
  if (patch) {
    for (const field of ['minZoom', 'maxZoom', 'tileType', 'tileCompression']) {
      if (base.header[field] !== patch.header[field]) throw new Error(`Incompatible PMTiles ${field}`);
    }
    const patchIds = new Set();
    for (const layer of patch.metadata.vector_layers) {
      const original: LooseRecord = layers.get(layer?.id);
      if (
        !original ||
        patchIds.has(layer.id) ||
        !layer.fields ||
        typeof layer.fields !== 'object' ||
        Array.isArray(layer.fields)
      )
        throw new Error('Incompatible PMTiles layers');
      patchIds.add(layer.id);
      for (const zoom of ['minzoom', 'maxzoom'])
        if (layer[zoom] != null && original[zoom] != null && layer[zoom] !== original[zoom])
          throw new Error('Incompatible PMTiles layer zoom');
      for (const [key, type] of Object.entries(layer.fields)) {
        if (Object.hasOwn(original.fields, key)) {
          if (original.fields[key] !== type) throw new Error('Incompatible PMTiles field type');
        } else {
          if (!Object.hasOwn(KNOWN_FIELDS, key) || KNOWN_FIELDS[key] !== type)
            throw new Error('Unknown PMTiles schema field');
          original.fields[key] = type;
        }
      }
    }
    if (patchIds.size !== layers.size) throw new Error('Incompatible PMTiles layers');
    for (const key of ['type', 'encoding', 'format'])
      if (patch.metadata[key] != null && base.metadata[key] !== patch.metadata[key])
        throw new Error(`Incompatible PMTiles metadata ${key}`);
  }
  if (bounds) {
    const values = [bounds.west, bounds.south, bounds.east, bounds.north];
    if (
      !values.every(Number.isFinite) ||
      bounds.west < -180 ||
      bounds.east > 180 ||
      bounds.south < -90 ||
      bounds.north > 90 ||
      bounds.west > bounds.east ||
      bounds.south > bounds.north
    )
      throw new Error('Invalid full-region PMTiles bounds');
    metadata.bounds = typeof metadata.bounds === 'string' ? values.join(',') : values;
  }
  return metadata;
}
function encodeDirectory(entries) {
  function size(value) {
    let bytes = 1;
    while (value >= 128) {
      value = Math.floor(value / 128);
      bytes++;
    }
    return bytes;
  }
  let length = size(entries.length),
    previousId = 0;
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i],
      previous = entries[i - 1];
    length +=
      size(entry.tileId - previousId) +
      size(entry.runLength) +
      size(entry.length) +
      size(i && entry.offset === previous.offset + previous.length ? 0 : entry.offset + 1);
    previousId = entry.tileId;
  }
  if (length > DEFAULT_LIMITS.directoryBytes) throw new Error('Output PMTiles directory exceeds limit');
  const buffer = Buffer.allocUnsafe(length);
  let position = 0;
  function write(value) {
    safe(value, 'encoded varint');
    while (value >= 128) {
      buffer[position++] = (value % 128) + 128;
      value = Math.floor(value / 128);
    }
    buffer[position++] = value;
  }
  write(entries.length);
  previousId = 0;
  for (const entry of entries) {
    write(entry.tileId - previousId);
    previousId = entry.tileId;
  }
  for (const entry of entries) write(entry.runLength);
  for (const entry of entries) write(entry.length);
  for (let i = 0; i < entries.length; i++)
    write(i && entries[i].offset === entries[i - 1].offset + entries[i - 1].length ? 0 : entries[i].offset + 1);
  return zlib.gzipSync(buffer);
}
function buildDirectories(entries) {
  if (entries.length <= 16384) {
    const root = encodeDirectory(entries);
    if (root.length <= ROOT_LIMIT) return { root, leaves: [], leafBytes: 0 };
  }
  for (let leafSize = 4096; leafSize <= DEFAULT_LIMITS.entries; leafSize *= 2) {
    const leaves = [],
      pointers = [];
    let leafBytes = 0;
    for (let i = 0; i < entries.length; i += leafSize) {
      const leaf = encodeDirectory(entries.slice(i, i + leafSize));
      pointers.push({ tileId: entries[i].tileId, runLength: 0, offset: leafBytes, length: leaf.length });
      leaves.push(leaf);
      leafBytes += leaf.length;
      if (leafBytes > DEFAULT_LIMITS.totalDirectoryBytes) throw new Error('Output PMTiles leaf bytes exceed limit');
    }
    if (entries.length + pointers.length > DEFAULT_LIMITS.entries)
      throw new Error('Output PMTiles index entry limit exceeded');
    const root = encodeDirectory(pointers);
    if (root.length <= ROOT_LIMIT) return { root, leaves, leafBytes };
  }
  throw new Error('Cannot fit PMTiles root directory');
}

async function writeAll(handle, buffer, position, signal) {
  let offset = 0;
  while (offset < buffer.length) {
    checkAbort(signal);
    const result = await handle.write(buffer, offset, buffer.length - offset, position + offset);
    if (!result.bytesWritten) throw new Error('Incomplete PMTiles write');
    offset += result.bytesWritten;
  }
}

async function patchPmtilesArchive({
  basePath,
  patchPath = null,
  outputPath,
  dirtyTileIds,
  bounds = null,
  signal = null
}: LooseRecord) {
  checkAbort(signal);
  const ranges = dirtyRanges(dirtyTileIds);
  const resolvedOutput = path.resolve(outputPath);
  if ([basePath, patchPath].filter(Boolean).some((file) => path.resolve(file) === resolvedOutput))
    throw new Error('PMTiles output must differ from input');
  try {
    await fs.lstat(resolvedOutput);
    throw new Error('PMTiles output already exists');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  let base = null,
    patch = null,
    output = null,
    outputIdentity = null,
    completed = false;
  try {
    base = await openArchive(basePath, { signal });
    if (patchPath) patch = await openArchive(patchPath, { signal });
    const metadata = mergedMetadata(base, patch, bounds);
    const retained = selectRanges(base, ranges, false);
    const removed = selectRanges(base, ranges, true);
    const incoming = patch ? selectRanges(patch, ranges, true) : [];
    const replacedTileCount = overlapCount(removed, incoming);
    const count = (entries) => entries.reduce((total, entry) => sum(total, entry.runLength), 0);
    const retainedTileCount = count(retained),
      incomingCount = count(incoming),
      removedCount = count(removed);
    const selected = retained.concat(incoming).sort((a, b) => a.tileId - b.tileId);
    if (selected.length > DEFAULT_LIMITS.entries) throw new Error('Output PMTiles index entry limit exceeded');
    const entries = [],
      contents = new Map();
    for (const entry of selected) {
      const key = `${entry.archive.filePath}\0${entry.offset}/${entry.length}`;
      if (!contents.has(key))
        contents.set(key, {
          archive: entry.archive,
          inputOffset: entry.archive.header.tileDataOffset + entry.offset,
          length: entry.length,
          offset: 0
        });
      const content = contents.get(key),
        previous = entries.at(-1);
      if (previous && previous.tileId + previous.runLength === entry.tileId && previous.content === content)
        previous.runLength += entry.runLength;
      else entries.push({ tileId: entry.tileId, runLength: entry.runLength, length: entry.length, offset: 0, content });
    }
    const payloads = [...contents.values()].sort(
      (a, b) => a.archive.filePath.localeCompare(b.archive.filePath) || a.inputOffset - b.inputOffset
    );
    let tileDataLength = 0;
    const copyRuns = [];
    for (const payload of payloads) {
      payload.offset = tileDataLength;
      tileDataLength = sum(tileDataLength, payload.length);
      let remaining = payload.length,
        inputOffset = payload.inputOffset;
      while (remaining) {
        const previous = copyRuns.at(-1);
        if (
          previous &&
          previous.archive === payload.archive &&
          previous.inputOffset + previous.length === inputOffset &&
          previous.length < COPY_BYTES
        ) {
          const length = Math.min(remaining, COPY_BYTES - previous.length);
          previous.length += length;
          inputOffset += length;
          remaining -= length;
        } else {
          const length = Math.min(remaining, COPY_BYTES);
          copyRuns.push({ archive: payload.archive, inputOffset, length });
          inputOffset += length;
          remaining -= length;
        }
      }
    }
    for (const entry of entries) entry.offset = entry.content.offset;
    const { root, leaves, leafBytes } = buildDirectories(entries);
    const metadataBytes = Buffer.from(JSON.stringify(metadata));
    if (metadataBytes.length > DEFAULT_LIMITS.metadataBytes) throw new Error('Output PMTiles metadata limit exceeded');
    const compressedMetadata = zlib.gzipSync(metadataBytes);
    const rawHeader = Buffer.from(base.rawHeader);
    const header = {
      ...base.header,
      rootDirectoryOffset: HEADER_BYTES,
      rootDirectoryLength: root.length,
      jsonMetadataOffset: HEADER_BYTES + root.length,
      jsonMetadataLength: compressedMetadata.length,
      leafDirectoryOffset: HEADER_BYTES + root.length + compressedMetadata.length,
      leafDirectoryLength: leafBytes,
      tileDataOffset: HEADER_BYTES + root.length + compressedMetadata.length + leafBytes,
      tileDataLength,
      numAddressedTiles: sum(retainedTileCount, incomingCount),
      numTileEntries: entries.length,
      numTileContents: payloads.length
    };
    HEADER_FIELDS.forEach((key, index) => rawHeader.writeBigUInt64LE(BigInt(safe(header[key])), 8 + index * 8));
    rawHeader[96] = 0; // Physical payload order favors sequential reads, not Hilbert order.
    rawHeader[97] = 2;
    if (bounds)
      [bounds.west, bounds.south, bounds.east, bounds.north].forEach((value, index) =>
        rawHeader.writeInt32LE(Math.round(value * 1e7), 102 + index * 4)
      );
    checkAbort(signal);
    output = await fs.open(resolvedOutput, 'wx');
    outputIdentity = await output.stat();
    let position = 0;
    for (const buffer of [rawHeader, root, compressedMetadata, ...leaves]) {
      await writeAll(output, buffer, position, signal);
      position += buffer.length;
    }
    const copyBuffer = Buffer.allocUnsafe(COPY_BYTES);
    for (const run of copyRuns) {
      checkAbort(signal);
      let read = 0;
      while (read < run.length) {
        const result = await run.archive.handle.read(copyBuffer, read, run.length - read, run.inputOffset + read);
        if (!result.bytesRead) throw new Error('Truncated PMTiles payload during copy');
        read += result.bytesRead;
        checkAbort(signal);
      }
      await writeAll(output, copyBuffer.subarray(0, run.length), position, signal);
      position += run.length;
    }
    if (position !== sum(header.tileDataOffset, tileDataLength)) throw new Error('PMTiles output layout mismatch');
    await output.sync();
    checkAbort(signal);
    await output.close();
    output = null;
    completed = true;
    return {
      addressedTileCount: header.numAddressedTiles,
      tileEntryCount: entries.length,
      tileContentCount: payloads.length,
      retainedTileCount,
      replacedTileCount,
      deletedTileCount: removedCount - replacedTileCount,
      addedTileCount: incomingCount - replacedTileCount,
      bytes: position
    };
  } finally {
    await Promise.allSettled([output?.close(), base?.handle.close(), patch?.handle.close()].filter(Boolean));
    if (!completed && outputIdentity) {
      // Never remove an existing caller file or a replacement made by another owner.
      const current = await fs.lstat(resolvedOutput).catch(() => null);
      if (
        current &&
        !current.isSymbolicLink() &&
        current.dev === outputIdentity.dev &&
        current.ino === outputIdentity.ino
      )
        await fs.unlink(resolvedOutput);
    }
  }
}

module.exports = {
  patchPmtilesArchive,
  readPmtilesArchiveIndex,
  _test_: { encodeDirectory, decodeDirectory, buildDirectories, MAX_TILE_ID, DEFAULT_LIMITS }
};
