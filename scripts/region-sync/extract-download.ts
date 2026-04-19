const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { pipeline } = require('stream/promises');
const { Readable } = require('stream');
const { createRegionCatalog } = require('../../src/lib/server/services/data-settings/region-catalog');
const { ensureDir } = require('./common');

const DEFAULT_DOWNLOAD_TIMEOUT_MS = 30 * 60 * 1000;

function resolveFetchImpl(fetchImpl = null) {
  if (typeof fetchImpl === 'function') return fetchImpl;
  if (typeof globalThis.fetch === 'function') return globalThis.fetch.bind(globalThis);
  throw new Error('fetch is not available');
}

function resolveManagedRegionExtract(region, options: LooseRecord = {}) {
  const extractSource = String(region?.extractSource || '').trim();
  const extractId = String(region?.extractId || '').trim();
  if (!extractSource || !extractId) {
    throw new Error('Managed region sync requires extractSource and extractId');
  }
  const catalog = options.regionCatalog || createRegionCatalog(options);
  const entry = catalog.findEntry(extractSource, extractId);
  if (!entry) {
    throw new Error(`Curated extract is missing from local catalog: ${extractSource} ${extractId}`);
  }
  const downloadUrl = String(entry.downloadUrl || '').trim();
  if (!downloadUrl) {
    throw new Error(`Curated extract download URL is missing: ${extractSource} ${extractId}`);
  }
  return entry;
}

async function downloadManagedRegionExtract({
  region,
  workspace,
  regionCatalog = null,
  fetchImpl = null,
  timeoutMs = DEFAULT_DOWNLOAD_TIMEOUT_MS,
  onStage = null
}: LooseRecord) {
  const extract = resolveManagedRegionExtract(region, {
    regionCatalog
  });
  const targetPath = path.join(String(workspace || process.cwd()), 'source.osm.pbf');
  ensureDir(targetPath);

  if (typeof onStage === 'function') {
    await onStage('download', `fetching ${extract.extractSource}:${extract.extractId}`);
  }

  const fetchRef = resolveFetchImpl(fetchImpl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(10_000, Number(timeoutMs) || DEFAULT_DOWNLOAD_TIMEOUT_MS));
  const hash = crypto.createHash('sha256');
  let sizeBytes = 0;

  try {
    const response = await fetchRef(extract.downloadUrl, {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        accept: 'application/octet-stream'
      }
    });
    if (!response?.ok || !response.body) {
      throw new Error(`Extract download failed: HTTP ${Number(response?.status || 0) || 0}`);
    }

    const writer = fs.createWriteStream(targetPath, {
      flags: 'w',
      mode: 0o644
    });
    try {
      const source = Readable.fromWeb(response.body);
      source.on('data', (chunk) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        sizeBytes += buffer.length;
        hash.update(buffer);
      });
      await pipeline(source, writer);
    } catch (error) {
      try {
        writer.destroy();
      } catch {
        // ignore stream cleanup failure
      }
      throw error;
    }

    const sourceMtime = String(response.headers?.get?.('last-modified') || '').trim() || null;
    const snapshot = {
      extractSource: extract.extractSource,
      extractId: extract.extractId,
      sha256: hash.digest('hex'),
      sizeBytes,
      sourceMtime,
      localPath: targetPath
    };

    if (typeof onStage === 'function') {
      await onStage('download', `downloaded ${extract.extractId} (${Math.round(sizeBytes / (1024 * 1024))} MiB)`);
    }

    return {
      extract,
      pbfPath: targetPath,
      sourceSnapshot: snapshot
    };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  downloadManagedRegionExtract,
  resolveManagedRegionExtract
};
