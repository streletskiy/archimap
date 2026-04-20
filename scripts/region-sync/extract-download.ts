const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { pipeline } = require('stream/promises');
const { Readable } = require('stream');
const { createRegionCatalog } = require('../../src/lib/server/services/data-settings/region-catalog');
const { ensureDir } = require('./common');

const DEFAULT_DOWNLOAD_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_ARIA2_BIN = String(process.env.ARIA2_BIN || 'aria2c').trim() || 'aria2c';
const DEFAULT_ALLOW_FETCH_FALLBACK = String(process.env.REGION_SYNC_ALLOW_FETCH_FALLBACK || '')
  .trim()
  .toLowerCase() === 'true';
const DEFAULT_ARIA2_SUMMARY_INTERVAL_SEC = 1;
const DEFAULT_ARIA2_SPLIT = 8;
const DEFAULT_ARIA2_MIN_SPLIT_SIZE = '1M';
const DEFAULT_ARIA2_MAX_CONNECTIONS = 8;
const ANSI_ESCAPE_CHAR = String.fromCharCode(27);
const ANSI_ESCAPE_PATTERN = new RegExp(`${ANSI_ESCAPE_CHAR}\\[[0-9;?]*[ -/]*[@-~]`, 'g');

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

function stripAnsi(text) {
  return String(text || '').replace(ANSI_ESCAPE_PATTERN, '');
}

function formatBytes(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value < 0) {
    return '0 B';
  }

  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'];
  let size = value;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }
  const decimals = unitIndex === 0 || size >= 100 ? 0 : size >= 10 ? 1 : 2;
  return `${size.toFixed(decimals)} ${units[unitIndex]}`;
}

function formatDownloadProgressDetail({ transferred = null, total = null, speed = null, eta = null } = {}) {
  const parts = [];
  const transferredText = String(transferred || '').trim();
  const totalText = String(total || '').trim();
  const speedText = String(speed || '').trim();
  const etaText = String(eta || '').trim();

  if (transferredText && totalText) {
    parts.push(`${transferredText} / ${totalText}`);
  } else if (transferredText) {
    parts.push(transferredText);
  }
  if (speedText) {
    parts.push(speedText);
  }
  if (etaText) {
    parts.push(`ETA ${etaText}`);
  }
  return parts.join(', ');
}

function normalizeAria2Token(token) {
  const text = String(token || '').trim();
  if (!text) return '';
  const speedMatch = text.match(/^([0-9.]+)\s*([KMGTP]?i?B)s$/i);
  if (speedMatch) {
    return `${speedMatch[1]} ${speedMatch[2]}/s`;
  }
  const sizeMatch = text.match(/^([0-9.]+)\s*([KMGTP]?i?B)$/i);
  if (sizeMatch) {
    return `${sizeMatch[1]} ${sizeMatch[2]}`;
  }
  return text;
}

function parseAria2ProgressLine(line) {
  const text = stripAnsi(line).trim();
  if (!text || !text.includes('%')) {
    return null;
  }

  const percentMatch = text.match(/\((\d{1,3}(?:\.\d+)?)%\)/);
  if (!percentMatch) {
    return null;
  }

  const sizeMatch = text.match(/\b(?:SIZE|DL):\s*([^\s/]+)\s*\/\s*([^\s(]+)\s*\((\d{1,3}(?:\.\d+)?)%\)/i);
  const speedMatch = text.match(/\bSPD:([^\s\]]+)/i);
  const etaMatch = text.match(/\bETA:([^\s\]]+)/i);

  return {
    percent: Math.max(0, Math.min(100, Math.round(Number(percentMatch[1])))),
    detail: formatDownloadProgressDetail({
      transferred: sizeMatch ? normalizeAria2Token(sizeMatch[1]) : '',
      total: sizeMatch ? normalizeAria2Token(sizeMatch[2]) : '',
      speed: speedMatch ? normalizeAria2Token(speedMatch[1]) : '',
      eta: etaMatch ? etaMatch[1] : ''
    })
  };
}

function isAria2Available(aria2Bin, spawnSyncRef = spawnSync) {
  const bin = String(aria2Bin || '').trim();
  if (!bin) return false;

  try {
    const probe = spawnSyncRef(bin, ['--version'], { stdio: 'pipe', shell: false });
    return !probe?.error && Number(probe?.status ?? 1) === 0;
  } catch {
    return false;
  }
}

function createStageReporter(onStage) {
  let chain = Promise.resolve();

  function emit(stage, detail = null, progress = null) {
    if (typeof onStage !== 'function') {
      return Promise.resolve();
    }
    chain = chain
      .then(() => onStage(stage, detail, progress))
      .catch(() => {});
    return chain;
  }

  return {
    emit,
    flush: () => chain.catch(() => {})
  };
}

async function resolveSourceMtime(downloadUrl, fetchRef, timeoutMs) {
  const controller = new AbortController();
  const numericTimeout = Number(timeoutMs);
  const metaTimeoutMs = Number.isFinite(numericTimeout)
    ? Math.max(5_000, Math.min(15_000, Math.trunc(numericTimeout)))
    : 15_000;
  const timer = setTimeout(() => controller.abort(), metaTimeoutMs);

  try {
    const response = await fetchRef(downloadUrl, {
      method: 'HEAD',
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        accept: 'application/octet-stream'
      }
    });
    return String(response?.headers?.get?.('last-modified') || '').trim() || null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function streamFileHash(targetPath) {
  const hash = crypto.createHash('sha256');
  let sizeBytes = 0;

  return new Promise((resolve, reject) => {
    const reader = fs.createReadStream(targetPath);
    reader.on('data', (chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      sizeBytes += buffer.length;
      hash.update(buffer);
    });
    reader.on('error', reject);
    reader.on('end', () => {
      resolve({
        sha256: hash.digest('hex'),
        sizeBytes
      });
    });
  });
}

async function downloadWithFetch({
  downloadUrl,
  targetPath,
  fetchRef,
  timeoutMs,
  onStage,
  sourceLabel,
  log = console
}: LooseRecord) {
  const controller = new AbortController();
  const numericTimeout = Number(timeoutMs);
  const timer = setTimeout(
    () => controller.abort(),
    Math.max(10_000, Number.isFinite(numericTimeout) ? Math.trunc(numericTimeout) : DEFAULT_DOWNLOAD_TIMEOUT_MS)
  );
  const reporter = createStageReporter(onStage);
  let sourceMtime;

  await reporter.emit('download', `fetching ${sourceLabel}`, 0);

  try {
    const response = await fetchRef(downloadUrl, {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        accept: 'application/octet-stream'
      }
    });
    if (!response?.ok || !response.body) {
      throw new Error(`Extract download failed: HTTP ${Number(response?.status || 0) || 0}`);
    }

    sourceMtime = String(response.headers?.get?.('last-modified') || '').trim() || null;
    const contentLength = Number(response.headers?.get?.('content-length') || NaN);
    const writer = fs.createWriteStream(targetPath, {
      flags: 'w',
      mode: 0o644
    });
    let sizeBytes = 0;
    let lastProgress = -1;
    let lastProgressTs = 0;

    try {
      const source = Readable.fromWeb(response.body);
      source.on('data', (chunk) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        sizeBytes += buffer.length;

        if (Number.isFinite(contentLength) && contentLength > 0) {
          const progress = Math.max(0, Math.min(100, Math.round((sizeBytes / contentLength) * 100)));
          const nowTs = Date.now();
          if (progress !== lastProgress && (progress === 100 || nowTs - lastProgressTs >= 1000 || progress > lastProgress)) {
            lastProgress = progress;
            lastProgressTs = nowTs;
            const detail = formatDownloadProgressDetail({
              transferred: formatBytes(sizeBytes),
              total: formatBytes(contentLength)
            });
            log.log(`[region-sync:download] fetch ${progress}%${detail ? ` (${detail})` : ''}`);
            void reporter.emit('download', `fetch ${progress}%${detail ? ` (${detail})` : ''}`, progress);
          }
        }
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

    if (!Number.isFinite(contentLength) || contentLength <= 0) {
      log.log(`[region-sync:download] fetch completed ${formatBytes(sizeBytes)}`);
    }
    await reporter.emit(
      'download',
      `downloaded ${sourceLabel}${sizeBytes > 0 ? ` (${formatBytes(sizeBytes)})` : ''}`,
      100
    );

    const snapshot = await streamFileHash(targetPath);
    return {
      snapshot: {
        extractSource: null,
        extractId: null,
        sha256: snapshot.sha256,
        sizeBytes: snapshot.sizeBytes,
        sourceMtime,
        localPath: targetPath
      }
    };
  } finally {
    clearTimeout(timer);
    await reporter.flush();
  }
}

async function downloadWithAria2({
  downloadUrl,
  targetPath,
  workspace,
  aria2Bin,
  timeoutMs,
  onStage,
  sourceLabel,
  log = console,
  spawnRef = spawn
}: LooseRecord) {
  const reporter = createStageReporter(onStage);
  let settled = false;
  let timeoutHandle = null;

  function handleOutputLine(rawLine, isError = false) {
    const line = String(rawLine || '').trim();
    if (!line) return;
    const progress = parseAria2ProgressLine(line);
    if (progress) {
      const message = `aria2 ${progress.percent}%${progress.detail ? ` (${progress.detail})` : ''}`;
      log.log(`[region-sync:download] ${message}`);
      void reporter.emit('download', message, progress.percent);
      return;
    }
    if (isError) {
      log.error(`[region-sync:download] ${line}`);
    } else {
      log.log(`[region-sync:download] ${line}`);
    }
  }

  function createOutputHandler(isError = false) {
    let buffer = '';
    return {
      push(chunk) {
        buffer += stripAnsi(chunk);
        const parts = buffer.split(/\r\n|\n|\r/);
        buffer = parts.pop() || '';
        for (const line of parts) {
          handleOutputLine(line, isError);
        }
      },
      flush() {
        const line = String(buffer || '').trim();
        buffer = '';
        handleOutputLine(line, isError);
      }
    };
  }

  const stdoutHandler = createOutputHandler(false);
  const stderrHandler = createOutputHandler(true);

  await reporter.emit('download', `fetching ${sourceLabel}`, 0);

  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnRef(aria2Bin, [
        `--dir=${workspace}`,
        '--out=source.osm.pbf',
        '--allow-overwrite=true',
        '--auto-file-renaming=false',
        '--continue=true',
        '--file-allocation=none',
        `--split=${DEFAULT_ARIA2_SPLIT}`,
        `--max-connection-per-server=${DEFAULT_ARIA2_MAX_CONNECTIONS}`,
        `--min-split-size=${DEFAULT_ARIA2_MIN_SPLIT_SIZE}`,
        `--summary-interval=${DEFAULT_ARIA2_SUMMARY_INTERVAL_SEC}`,
        '--show-console-readout=true',
        '--enable-color=false',
        downloadUrl
      ], {
        cwd: workspace,
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: false
      });
    } catch (error) {
      settled = true;
      void reporter.flush().finally(() => reject(error));
      return;
    }

    const timeoutMsNumeric = Number(timeoutMs);
    const effectiveTimeoutMs = Math.max(
      10_000,
      Number.isFinite(timeoutMsNumeric) ? Math.trunc(timeoutMsNumeric) : DEFAULT_DOWNLOAD_TIMEOUT_MS
    );
    timeoutHandle = setTimeout(() => {
      if (!settled) {
        try {
          child.kill('SIGTERM');
        } catch {
          // ignore
        }
        setTimeout(() => {
          if (!settled) {
            try {
              child.kill('SIGKILL');
            } catch {
              // ignore
            }
          }
        }, 5_000).unref?.();
      }
    }, effectiveTimeoutMs);

    child.stdout.on('data', (chunk) => stdoutHandler.push(chunk));
    child.stderr.on('data', (chunk) => stderrHandler.push(chunk));
    child.on('error', async (error) => {
      if (settled) return;
      settled = true;
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
        timeoutHandle = null;
      }
      log.error(`[region-sync:download] aria2 failed to start: ${String(error?.message || error)}`);
      stdoutHandler.flush();
      stderrHandler.flush();
      try {
        await reporter.flush();
      } finally {
        reject(error);
      }
    });
    child.on('close', async (code, signal) => {
      if (settled) return;
      settled = true;
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
        timeoutHandle = null;
      }

      try {
        stdoutHandler.flush();
        stderrHandler.flush();
        if (code !== 0) {
          throw new Error(signal ? `aria2 exited with signal ${signal}` : `aria2 exited with code ${code}`);
        }
        await reporter.emit('download', `downloaded ${sourceLabel}`, 100);
        await reporter.flush();
        resolve({
          sourceMtime: null
        });
      } catch (error) {
        try {
          await reporter.flush();
        } finally {
          reject(error);
        }
      }
    });
  }).then(async (result) => {
    const snapshot = await streamFileHash(targetPath);
    return {
      snapshot: {
        extractSource: null,
        extractId: null,
        sha256: snapshot.sha256,
        sizeBytes: snapshot.sizeBytes,
        sourceMtime: result?.sourceMtime || null,
        localPath: targetPath
      }
    };
  });
}

async function downloadManagedRegionExtract({
  region,
  workspace,
  regionCatalog = null,
  fetchImpl = null,
  spawnRef = spawn,
  spawnSyncRef = spawnSync,
  aria2Bin = DEFAULT_ARIA2_BIN,
  allowFetchFallback = DEFAULT_ALLOW_FETCH_FALLBACK,
  log = console,
  timeoutMs = DEFAULT_DOWNLOAD_TIMEOUT_MS,
  onStage = null
}: LooseRecord) {
  const extract = resolveManagedRegionExtract(region, {
    regionCatalog
  });
  const targetPath = path.join(String(workspace || process.cwd()), 'source.osm.pbf');
  ensureDir(targetPath);
  const fetchRef = resolveFetchImpl(fetchImpl);
  const sourceLabel = `${extract.extractSource}:${extract.extractId}`;
  const useAria2 = isAria2Available(aria2Bin, spawnSyncRef);
  const allowFallback = Boolean(allowFetchFallback);

  if (!useAria2) {
    if (!allowFallback) {
      const error = new Error(
        `aria2c is not available in this runtime. Rebuild/pull the image with aria2 or set ARIA2_BIN. Set REGION_SYNC_ALLOW_FETCH_FALLBACK=true only for emergency streamed fetch fallback.`
      );
      log.error(`[region-sync:download] ${error.message}`);
      throw error;
    }

    log.log(`[region-sync:download] aria2 unavailable; using streamed fetch fallback`);
    const fallbackResult = await downloadWithFetch({
      downloadUrl: extract.downloadUrl,
      targetPath,
      fetchRef,
      timeoutMs,
      onStage,
      sourceLabel,
      log
    });
    return {
      extract,
      pbfPath: targetPath,
      sourceSnapshot: {
        extractSource: extract.extractSource,
        extractId: extract.extractId,
        sha256: fallbackResult.snapshot.sha256,
        sizeBytes: fallbackResult.snapshot.sizeBytes,
        sourceMtime: fallbackResult.snapshot.sourceMtime || fetchSourceMtime,
        localPath: targetPath
      }
    };
  }

  const fetchSourceMtime = await resolveSourceMtime(extract.downloadUrl, fetchRef, timeoutMs);

  try {
    const downloadResult = await downloadWithAria2({
      downloadUrl: extract.downloadUrl,
      targetPath,
      workspace,
      aria2Bin,
      timeoutMs,
      onStage,
      sourceLabel,
      log,
      spawnRef
    });

    return {
      extract,
      pbfPath: targetPath,
      sourceSnapshot: {
        extractSource: extract.extractSource,
        extractId: extract.extractId,
        sha256: downloadResult.snapshot.sha256,
        sizeBytes: downloadResult.snapshot.sizeBytes,
        sourceMtime: downloadResult.snapshot.sourceMtime || fetchSourceMtime,
        localPath: targetPath
      }
    };
  } catch (error) {
    if (!allowFallback) {
      throw error;
    }

    log.log(
      `[region-sync:download] aria2 failed; falling back to streamed fetch: ${String(error?.message || error)}`
    );
    const fallbackResult = await downloadWithFetch({
      downloadUrl: extract.downloadUrl,
      targetPath,
      fetchRef,
      timeoutMs,
      onStage,
      sourceLabel,
      log
    });
    return {
      extract,
      pbfPath: targetPath,
      sourceSnapshot: {
        extractSource: extract.extractSource,
        extractId: extract.extractId,
        sha256: fallbackResult.snapshot.sha256,
        sizeBytes: fallbackResult.snapshot.sizeBytes,
        sourceMtime: fallbackResult.snapshot.sourceMtime || fetchSourceMtime,
        localPath: targetPath
      }
    };
  }
}

module.exports = {
  downloadManagedRegionExtract,
  resolveManagedRegionExtract
};
