const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { downloadManagedRegionExtract, resolveManagedRegionExtract } = require('./extract-download');

const DEFAULT_MAX_DIFFS = 11000;
const DEFAULT_MAX_DIFF_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_TOTAL_BYTES = 128 * 1024 * 1024;
const DEFAULT_REBASE_DAYS = 30;

function deriveManagedReplicationBaseUrl(extract) {
  try {
    const download = new URL(extract.downloadUrl);
    if (!['http:', 'https:'].includes(download.protocol) || download.username || download.password || download.port) return null;
    if (extract.extractSource === 'osmfr' && download.hostname === 'download.openstreetmap.fr') {
      const id = String(extract.extractId || '');
      if (!/^[a-z0-9_-]+(?:\/[a-z0-9_-]+)*$/i.test(id)) return null;
      if (download.pathname !== `/extracts/${id}.osm.pbf` && download.pathname !== `/extracts/${id}-latest.osm.pbf`) return null;
      return `https://download.openstreetmap.fr/replication/${id}/minute/`;
    }
    if (extract.extractSource === 'geofabrik' && download.hostname === 'download.geofabrik.de' && /-latest\.osm\.pbf$/.test(download.pathname)) {
      return `https://download.geofabrik.de${download.pathname.replace(/-latest\.osm\.pbf$/, '-updates/')}`;
    }
  } catch { /* Unsupported catalog entries keep the full download path. */ }
  return null;
}

function normalizeTrustedReplicationBaseUrl(baseUrl, extract) {
  const expected = deriveManagedReplicationBaseUrl(extract);
  if (!expected || !baseUrl) return null;
  try {
    const url = new URL(baseUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port || url.search || url.hash) return null;
    url.protocol = 'https:';
    url.pathname = url.pathname.replace(/\/+$/, '') + '/';
    return url.href === expected ? expected : null;
  } catch { return null; }
}

function parseReplicationState(text) {
  const values = new Map();
  for (const line of String(text).split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const match = /^\s*([a-zA-Z]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (!match) throw new Error('Invalid replication state syntax');
    if (values.has(match[1])) throw new Error('Duplicate replication state field');
    values.set(match[1], match[2].replace(/\\:/g, ':'));
  }
  const rawSequence = values.get('sequenceNumber') || '';
  const sequence = Number(rawSequence);
  const rawTimestamp = values.get('timestamp') || '';
  const timestamp = Date.parse(rawTimestamp);
  if (!/^\d+$/.test(rawSequence) || !Number.isSafeInteger(sequence) || sequence < 0 ||
      !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(rawTimestamp) || !Number.isFinite(timestamp)) {
    throw new Error('Invalid replication sequence or timestamp');
  }
  return { sequence, timestamp: new Date(timestamp).toISOString() };
}

function sequencePath(sequence) {
  if (!Number.isSafeInteger(sequence) || sequence < 0 || sequence > 999999999) throw new Error('Invalid replication sequence');
  return String(sequence).padStart(9, '0').match(/.{3}/g).join('/');
}

function regionCacheDirectory(dataDir, regionId) {
  if (!Number.isSafeInteger(Number(regionId)) || Number(regionId) <= 0) throw new Error('Invalid source cache region');
  return path.resolve(dataDir, 'source-cache', `r${Number(regionId)}`);
}

function isOwnedSourceCachePath(filePath, dataDir, regionId) {
  const directory = regionCacheDirectory(dataDir, regionId);
  const target = path.resolve(String(filePath || ''));
  return path.dirname(target) === directory && /^[a-f0-9]{64}\.osm\.pbf$/.test(path.basename(target));
}

async function hashFile(filePath, signal = null) {
  signal?.throwIfAborted();
  const digest = crypto.createHash('sha256');
  let sizeBytes = 0;
  for await (const chunk of fs.createReadStream(filePath)) {
    signal?.throwIfAborted(); digest.update(chunk); sizeBytes += chunk.length;
  }
  signal?.throwIfAborted();
  return { sha256: digest.digest('hex'), sizeBytes };
}

function fsyncFile(filePath) {
  const fd = fs.openSync(filePath, 'r+');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function fsyncDirectory(directory) {
  if (process.platform === 'win32') return;
  const fd = fs.openSync(directory, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function assertCacheDirectoryContained(directory, dataDir) {
  const relative = path.relative(fs.realpathSync(dataDir), fs.realpathSync(directory));
  if (!relative || relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) {
    throw new Error('Source cache directory escapes the data directory');
  }
}

async function validatePreviousSnapshot(snapshot, { dataDir, region, extract, signal }) {
  if (!snapshot || !snapshot.persistentSource || snapshot.extractSource !== extract.extractSource ||
      snapshot.extractId !== extract.extractId || snapshot.downloadUrl !== extract.downloadUrl ||
      !/^[a-f0-9]{64}$/.test(snapshot.sha256 || '') || !isOwnedSourceCachePath(snapshot.localPath, dataDir, region.id)) return false;
  try {
    const stat = fs.lstatSync(snapshot.localPath);
    const directory = regionCacheDirectory(dataDir, region.id);
    assertCacheDirectoryContained(directory, dataDir);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size !== Number(snapshot.sizeBytes) ||
        path.dirname(fs.realpathSync(snapshot.localPath)) !== fs.realpathSync(directory)) return false;
    return (await hashFile(snapshot.localPath, signal)).sha256 === snapshot.sha256;
  } catch { signal?.throwIfAborted(); return false; }
}

async function publishImmutableSource(sourcePath, { dataDir, region, signal }) {
  const fingerprint = await hashFile(sourcePath, signal);
  if (fingerprint.sizeBytes === 0) throw new Error('Source PBF is empty');
  const directory = regionCacheDirectory(dataDir, region.id);
  fs.mkdirSync(directory, { recursive: true });
  assertCacheDirectoryContained(directory, dataDir);
  if (fs.lstatSync(directory).isSymbolicLink()) throw new Error('Source cache directory must not be a symlink');
  const localPath = path.join(directory, `${fingerprint.sha256}.osm.pbf`);
  let existingValid = false;
  if (fs.existsSync(localPath)) {
    if (!fs.lstatSync(localPath).isFile() || fs.lstatSync(localPath).isSymbolicLink()) throw new Error('Invalid immutable source cache path');
    existingValid = (await hashFile(localPath, signal)).sha256 === fingerprint.sha256;
  }
  if (!existingValid) {
    signal?.throwIfAborted();
    // All workspaces and the persistent cache normally share the data volume.
    fsyncFile(sourcePath);
    try { fs.renameSync(sourcePath, localPath); }
    catch (error) {
      if (error.code !== 'EXDEV') throw error;
      const partial = `${localPath}.${crypto.randomUUID()}.partial`;
      try {
        fs.copyFileSync(sourcePath, partial, fs.constants.COPYFILE_EXCL);
        fsyncFile(partial);
        fs.renameSync(partial, localPath);
      } finally { if (fs.existsSync(partial)) fs.unlinkSync(partial); }
    }
    fsyncDirectory(directory);
  }
  return { ...fingerprint, localPath };
}

// Caller holds the region source lock and supplies the COMMITTED active path.
// Never infer commit success from a prepared filesystem file or a local manifest.
function pruneRegionSourceCache({ dataDir, regionId, activePath = null, noActiveSnapshot = false }) {
  if (noActiveSnapshot && activePath) throw new Error('Source cleanup cannot have both an active path and no active snapshot');
  if (!noActiveSnapshot && (!isOwnedSourceCachePath(activePath, dataDir, regionId) || !fs.existsSync(activePath))) {
    throw new Error('Source cache cleanup requires a committed active cache file');
  }
  const directory = regionCacheDirectory(dataDir, regionId);
  if (noActiveSnapshot && !fs.existsSync(directory)) return 0;
  assertCacheDirectoryContained(directory, dataDir);
  if (fs.lstatSync(directory).isSymbolicLink()) throw new Error('Source cache directory must not be a symlink');
  if (activePath && (!fs.lstatSync(activePath).isFile() || fs.lstatSync(activePath).isSymbolicLink())) {
    throw new Error('Active source cache must be a regular file');
  }
  let removed = 0;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if ((activePath && target === path.resolve(activePath)) || !entry.isFile() || !isOwnedSourceCachePath(target, dataDir, regionId)) continue;
    fs.unlinkSync(target); removed++;
  }
  fsyncDirectory(directory);
  return removed;
}

function positiveInteger(value, fallback, maximum = Number.MAX_SAFE_INTEGER) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? Math.min(number, maximum) : fallback;
}

async function validateChangeGzip(compressed, maxOutputBytes, signal) {
  if (compressed[0] !== 0x1f || compressed[1] !== 0x8b) throw new Error('Replication file is not gzip');
  let bytes = 0, head = '', tail = '', scanTail = '';
  // Bound decoded memory independently from gzip size and worker concurrency.
  // Native osmium subsequently parses the complete XML while applying the batch.
  const decoder = Readable.from([compressed]).pipe(zlib.createGunzip());
  for await (const chunk of decoder) {
    signal?.throwIfAborted();
    bytes += chunk.length;
    if (bytes > maxOutputBytes) throw new Error('Replication decoded response exceeds size limit');
    const text = chunk.toString('utf8');
    if (/<!DOCTYPE/i.test(scanTail + text)) throw new Error('Invalid OSM change document');
    scanTail = text.slice(-16);
    if (head.length < 16384) head = (head + text).slice(0, 16384);
    tail = (tail + text).slice(-4096);
  }
  if (!/<osmChange(?:\s|\/?>)/.test(head) ||
      !(/<\/osmChange\s*>\s*$/.test(tail) || /<osmChange\b[^<>]*\/\s*>\s*$/.test(head))) {
    throw new Error('Invalid OSM change document');
  }
  // This is deliberately a narrow proof, not a second XML parser. The whole
  // decoded document must fit in head and contain no operations or objects.
  // Native osmium still validates/applies every file before this proof is used.
  const empty = bytes <= 16384 && /^\s*(?:<\?xml\s[^<>]*\?>\s*)?<osmChange\b[^<>]*(?:\/\s*>|>\s*<\/osmChange\s*>)\s*$/.test(head);
  return { empty };
}

async function prepareManagedRegionSource(options: LooseRecord) {
  const { region, dataDir, workspace, previousSnapshot = null, importSignature, env = process.env,
    onStage = null, signal = null, regionCatalog = null } = options;
  if (!String(importSignature || '').trim()) throw new Error('Source preparation requires an import signature');
  signal?.throwIfAborted();
  const fetchImpl = options.fetchImpl || globalThis.fetch.bind(globalThis);
  const extract = resolveManagedRegionExtract(region, { regionCatalog });
  const tools = options.osmiumTools || require('./osmium-tool');
  const download = options.downloadFull || downloadManagedRegionExtract;
  const expectedBase = deriveManagedReplicationBaseUrl(extract);
  const maxDiffs = positiveInteger(env.REGION_SYNC_MAX_DIFFS, DEFAULT_MAX_DIFFS, 20000);
  const maxDiffBytes = positiveInteger(env.REGION_SYNC_MAX_DIFF_BYTES, DEFAULT_MAX_DIFF_BYTES);
  const maxTotalBytes = positiveInteger(env.REGION_SYNC_MAX_DIFF_TOTAL_BYTES, DEFAULT_MAX_TOTAL_BYTES);
  const concurrency = positiveInteger(env.REGION_SYNC_DIFF_CONCURRENCY, 8, 8);
  const timeoutMs = positiveInteger(env.REGION_SYNC_DIFF_TIMEOUT_MS, 30000, 120000);
  const rebaseDays = positiveInteger(env.REGION_SYNC_SOURCE_REBASE_DAYS, DEFAULT_REBASE_DAYS, 365);
  const now = options.now ? new Date(options.now) : new Date();
  const counters = { downloadBytes: 0, downloadRequests: 0, diffCount: 0 };
  const stage = async (detail, progress = null) => { if (onStage) await onStage('download', detail, progress); };

  async function request(url, maxBytes, init: LooseRecord = {}) {
    const controller = new AbortController();
    const abort = () => controller.abort(signal.reason);
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => controller.abort(new Error('Replication request timed out')), timeoutMs);
    try {
      signal?.throwIfAborted();
      counters.downloadRequests++;
      // Trusted providers serve these paths directly. Refuse redirect-based SSRF.
      const response = await fetchImpl(url, { ...init, redirect: 'error', signal: controller.signal });
      if (!response.ok) throw new Error(`Replication request failed: HTTP ${response.status}`);
      const length = Number(response.headers?.get?.('content-length') || 0);
      if (length > maxBytes) throw new Error('Replication response exceeds size limit');
      const chunks = [];
      let size = 0;
      for await (const chunk of response.body) {
        const buffer = Buffer.from(chunk); size += buffer.length;
        counters.downloadBytes += buffer.length;
        if (size > maxBytes) throw new Error('Replication response exceeds size limit');
        chunks.push(buffer);
      }
      return Buffer.concat(chunks);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    }
  }

  let latestPromise = null;
  function latestState() {
    if (!latestPromise) latestPromise = request(`${expectedBase}state.txt`, 16384).then(bytes => parseReplicationState(bytes.toString('utf8')));
    return latestPromise;
  }
  function normalizeMetadata(metadata) {
    const baseUrl = normalizeTrustedReplicationBaseUrl(metadata?.baseUrl, extract);
    const sequence = Number(metadata?.sequence);
    const timestamp = Date.parse(metadata?.timestamp);
    if (!baseUrl || !/^\d+$/.test(String(metadata?.sequence ?? '')) || !Number.isSafeInteger(sequence) || sequence < 0 || !Number.isFinite(timestamp)) return null;
    return { baseUrl, sequence, timestamp: new Date(timestamp).toISOString() };
  }
  function metadataFromSnapshot(snapshot) {
    return normalizeMetadata({ baseUrl: snapshot.replicationBaseUrl, sequence: snapshot.replicationSequence, timestamp: snapshot.replicationTimestamp });
  }
  async function applyChanges(basePath, baseState, targetState) {
    if (targetState.sequence < baseState.sequence || Date.parse(targetState.timestamp) < Date.parse(baseState.timestamp)) {
      throw new Error('Replication feed moved backwards');
    }
    const count = targetState.sequence - baseState.sequence;
    if (count === 0) {
      if (targetState.timestamp !== baseState.timestamp) throw new Error('Replication sequence timestamp mismatch');
      return { pbfPath: basePath, metadata: baseState };
    }
    if (count > maxDiffs) throw new Error('Replication gap exceeds bounded catch-up limit');
    // Replication numbers define contiguous intervals. As in pyosmium, the
    // published frontier and its exact final state anchor the whole batch;
    // intermediate state files do not authenticate their OSC payloads.
    const finalState = parseReplicationState((await request(
      `${baseState.baseUrl}${sequencePath(targetState.sequence)}.state.txt`, 16384
    )).toString('utf8'));
    if (finalState.sequence !== targetState.sequence || finalState.timestamp !== targetState.timestamp) {
      throw new Error('Replication target state does not match the captured frontier');
    }
    const diffsDir = fs.mkdtempSync(path.join(workspace, 'diffs-'));
    const files = new Array(count);
    let next = 0, downloadedDiffBytes = 0, firstError = null, allChangesEmpty = true;
    await stage(`downloading ${count} regional updates`, 0);
    const workers = Array.from({ length: Math.min(concurrency, count) }, async () => {
      while (!firstError) {
        const index = next++; if (index >= count) return;
        try {
          signal?.throwIfAborted();
          const sequence = baseState.sequence + index + 1;
          const baseUrl = `${baseState.baseUrl}${sequencePath(sequence)}`;
          const compressed = await request(`${baseUrl}.osc.gz`, maxDiffBytes);
          downloadedDiffBytes += compressed.length;
          if (downloadedDiffBytes > maxTotalBytes) throw new Error('Replication batch exceeds size limit');
          const validation = await validateChangeGzip(compressed, Math.min(maxDiffBytes * 32, 128 * 1024 * 1024), signal);
          allChangesEmpty = allChangesEmpty && validation.empty;
          const file = path.join(diffsDir, `${String(sequence).padStart(9, '0')}.osc.gz`);
          fs.writeFileSync(file, compressed, { flag: 'wx' });
          files[index] = file;
          counters.diffCount++;
        } catch (error) { firstError ||= error; }
      }
    });
    await Promise.all(workers);
    if (firstError) throw firstError;
    if (files.filter(Boolean).length !== count) throw new Error('Replication changes are not contiguous');
    const targetPath = path.join(workspace, `updated-${crypto.randomUUID()}.osm.pbf`);
    const state = { ...targetState, baseUrl: baseState.baseUrl };
    await stage(`applying ${count} regional updates`, 100);
    const metadata = normalizeMetadata(await tools.applyReplicationChanges({ basePath, changePaths: files, targetPath, state, env, signal }));
    if (!metadata || metadata.sequence !== state.sequence || metadata.timestamp !== state.timestamp) {
      throw new Error('Updated PBF replication header does not match applied changes');
    }
    return { pbfPath: targetPath, metadata, buildingInputUnchanged: allChangesEmpty };
  }

  const validPrevious = await validatePreviousSnapshot(previousSnapshot, { dataDir, region, extract, signal });
  const previousState = previousSnapshot ? metadataFromSnapshot(previousSnapshot) : null;
  const reused = (sourceMode) => ({ pbfPath: previousSnapshot.localPath, sourceSnapshot: { ...previousSnapshot, importSignature, persistentSource: true },
    persistentSource: true, sourceMode, ...counters, sourceDataUpdatedAt: previousSnapshot.replicationTimestamp || previousSnapshot.sourceMtime || null });
  const requiresReimport = validPrevious && previousSnapshot.importSignature !== importSignature;
  const fullAge = now.getTime() - Date.parse(previousSnapshot?.lastFullDownloadAt || '');
  const rebaseDue = !Number.isFinite(fullAge) || fullAge >= rebaseDays * 86400000;
  let prepared = null, mode = 'full', fullSnapshot = null;
  if (validPrevious && previousState && !rebaseDue) {
    try {
      const latest = await latestState();
      if (latest.sequence === previousState.sequence && latest.timestamp === previousState.timestamp) {
        await stage('regional source is already current', 100);
        return reused(requiresReimport ? 'cached' : 'unchanged');
      }
      prepared = await applyChanges(previousSnapshot.localPath, previousState, latest);
      mode = 'incremental';
    } catch (error) {
      signal?.throwIfAborted();
      await stage(`regional updates unavailable; refreshing complete source (${String(error.message).slice(0, 130)})`);
    }
  }
  if (!prepared) {
    let sourceEtag = null, sourceLastModified = null, sawFullGet = false;
    let directDownload = null;
    // A validator is safe only when it came from the very GET whose bytes were
    // persisted. HEAD metadata and Last-Modified alone cannot establish that.
    if (validPrevious && !previousState && !rebaseDue) {
      const controller = new AbortController();
      const abort = () => controller.abort(signal.reason);
      signal?.addEventListener('abort', abort, { once: true });
      const timer = setTimeout(() => controller.abort(new Error('Source download timed out')), 30 * 60 * 1000);
      const etag = String(previousSnapshot.sourceEtag || '');
      const strongEtag = /^"[^"\r\n]+"$/.test(etag) ? etag : null;
      try {
        signal?.throwIfAborted();
        counters.downloadRequests++;
        const response = await fetchImpl(extract.downloadUrl, { redirect: 'error', signal: controller.signal,
          headers: strongEtag ? { 'if-none-match': strongEtag } : {} });
        if (response.status === 304) {
          if (!strongEtag || (response.headers?.get?.('etag') && response.headers.get('etag') !== strongEtag)) {
            throw new Error('Source returned an inconsistent conditional response');
          }
          await stage('regional source validator is unchanged', 100);
          return reused(requiresReimport ? 'cached' : 'unchanged');
        }
        if (!response.ok || !response.body) throw new Error(`Source download failed: HTTP ${response.status}`);
        sourceEtag = response.headers?.get?.('etag') || null;
        sourceLastModified = response.headers?.get?.('last-modified') || null;
        const pbfPath = path.join(workspace, `source-${crypto.randomUUID()}.osm.pbf`);
        let sizeBytes = 0;
        const meter = new Transform({ transform(chunk, _encoding, done) {
          sizeBytes += chunk.length; counters.downloadBytes += chunk.length; done(null, chunk);
        } });
        await stage('refreshing complete regional source');
        await pipeline(Readable.fromWeb(response.body), meter, fs.createWriteStream(pbfPath, { flags: 'wx' }));
        directDownload = { pbfPath, sourceSnapshot: { sourceMtime: sourceLastModified, sourceEtag, sourceLastModified, sizeBytes } };
      } finally {
        clearTimeout(timer); signal?.removeEventListener('abort', abort);
      }
    }
    const observedFetch = async (url, init) => {
      counters.downloadRequests++;
      if (String(url) === extract.downloadUrl && String(init?.method || 'GET').toUpperCase() === 'GET') sawFullGet = true;
      const signals = [signal, init?.signal].filter(Boolean);
      const response = await fetchImpl(url, { ...init, ...(signals.length ? { signal: AbortSignal.any(signals) } : {}) });
      if (response.ok && String(url) === extract.downloadUrl && String(init?.method || 'GET').toUpperCase() === 'GET') {
        sourceEtag = response.headers?.get?.('etag') || sourceEtag;
        sourceLastModified = response.headers?.get?.('last-modified') || sourceLastModified;
      }
      return response;
    };
    const guardedSpawn = (...args) => {
      signal?.throwIfAborted();
      const child = (options.spawnRef || require('node:child_process').spawn)(...args);
      const abort = () => child.kill('SIGTERM');
      signal?.addEventListener('abort', abort, { once: true });
      child.once('close', () => signal?.removeEventListener('abort', abort));
      return child;
    };
    const result = directDownload || await download({ ...options, region, workspace, regionCatalog, fetchImpl: observedFetch,
      spawnRef: guardedSpawn, onStage, signal, allowFetchFallback: options.allowFetchFallback ?? true });
    signal?.throwIfAborted();
    fullSnapshot = { ...result.sourceSnapshot, sourceEtag, sourceLastModified, sourceMtime: sourceLastModified,
      lastFullDownloadAt: now.toISOString() };
    if (!directDownload) counters.downloadBytes += Number(fullSnapshot.sizeBytes || fs.statSync(result.pbfPath).size);
    // aria2 range requests are one logical transfer; fetch HEAD requests counted above.
    if (!directDownload && !sawFullGet) counters.downloadRequests++;
    const rawMetadata = await tools.readPbfReplicationMetadata(result.pbfPath, { env, signal, allowMissing: true });
    const metadata = normalizeMetadata(rawMetadata);
    if (rawMetadata?.timestamp && Number.isFinite(Date.parse(rawMetadata.timestamp))) fullSnapshot.sourceMtime = new Date(rawMetadata.timestamp).toISOString();
    prepared = { pbfPath: result.pbfPath, metadata };
    if (metadata) {
      try {
        const latest = await latestState();
        prepared = await applyChanges(result.pbfPath, metadata, latest);
      } catch (error) {
        signal?.throwIfAborted();
        if (previousState && (metadata.sequence < previousState.sequence || Date.parse(metadata.timestamp) < Date.parse(previousState.timestamp))) throw error;
        // A valid full source remains usable when the optional update service is down.
        prepared = { pbfPath: result.pbfPath, metadata };
        await stage('using complete source; replication catch-up is temporarily unavailable');
      }
    }
    if (previousState && (!prepared.metadata || prepared.metadata.sequence < previousState.sequence ||
      Date.parse(prepared.metadata.timestamp) < Date.parse(previousState.timestamp) ||
      (prepared.metadata.sequence === previousState.sequence && prepared.metadata.timestamp !== previousState.timestamp))) {
      throw new Error('Refusing to replace a regional source with an older snapshot');
    }
    const sameIdentity = previousSnapshot?.extractSource === extract.extractSource && previousSnapshot?.extractId === extract.extractId;
    const previousCut = Date.parse(previousSnapshot?.replicationTimestamp || previousSnapshot?.sourceMtime || '');
    const nextCut = Date.parse(prepared.metadata?.timestamp || fullSnapshot.sourceMtime || '');
    if (sameIdentity && Number.isFinite(previousCut) && (!Number.isFinite(nextCut) || nextCut < previousCut)) {
      throw new Error('Refusing to replace a regional source with an older snapshot');
    }
  }
  const fingerprint = await publishImmutableSource(prepared.pbfPath, { dataDir, region, signal });
  const metadata = prepared.metadata;
  const sourceSnapshot = {
    ...(fullSnapshot || previousSnapshot), ...fingerprint, persistentSource: true,
    extractSource: extract.extractSource, extractId: extract.extractId, downloadUrl: extract.downloadUrl,
    importSignature, replicationBaseUrl: metadata?.baseUrl || null, replicationSequence: metadata?.sequence ?? null,
    replicationTimestamp: metadata?.timestamp || null,
    sourceMtime: metadata?.timestamp || fullSnapshot?.sourceMtime || previousSnapshot?.sourceMtime || null,
    lastFullDownloadAt: fullSnapshot?.lastFullDownloadAt || previousSnapshot?.lastFullDownloadAt || now.toISOString()
  };
  return { pbfPath: fingerprint.localPath, sourceSnapshot, persistentSource: true, sourceMode: mode,
    ...(mode === 'incremental' && validPrevious && prepared.buildingInputUnchanged === true ? { buildingInputUnchanged: true } : {}),
    ...counters, sourceDataUpdatedAt: sourceSnapshot.replicationTimestamp || sourceSnapshot.sourceMtime };
}

module.exports = { prepareManagedRegionSource, deriveManagedReplicationBaseUrl, normalizeTrustedReplicationBaseUrl,
  parseReplicationState, sequencePath, isOwnedSourceCachePath, pruneRegionSourceCache };
