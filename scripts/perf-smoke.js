const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const PORT = 3877;
const BASE_URL = `http://127.0.0.1:${PORT}`;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitReady(timeoutMs = 20000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(`${BASE_URL}/readyz`);
      if (response.ok) return;
    } catch {
      // Wait for server startup.
    }
    await sleep(250);
  }
  throw new Error('Server did not become ready');
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * p));
  return Number(sorted[idx].toFixed(2));
}

async function benchmark(pathname, samples = 25) {
  const values = [];
  for (let i = 0; i < samples; i += 1) {
    const started = process.hrtime.bigint();
    const response = await fetch(`${BASE_URL}${pathname}`);
    await response.arrayBuffer();
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    values.push(elapsedMs);
  }
  values.sort((a, b) => a - b);
  return {
    p50: percentile(values, 0.5),
    p95: percentile(values, 0.95)
  };
}

function collectBundleStats() {
  const clientDir = path.join(process.cwd(), 'frontend', 'build', '_app', 'immutable');
  const result = {
    chunksTotalKb: 0,
    assetsTotalKb: 0,
    largestChunk: { name: '', kb: 0 }
  };

  function scanDir(dirPath, bucket) {
    if (!fs.existsSync(dirPath)) return;
    const files = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const file of files) {
      const full = path.join(dirPath, file.name);
      if (file.isDirectory()) {
        scanDir(full, bucket);
        continue;
      }
      const sizeKb = fs.statSync(full).size / 1024;
      if (bucket === 'chunks') {
        result.chunksTotalKb += sizeKb;
        if (sizeKb > result.largestChunk.kb) {
          result.largestChunk = { name: file.name, kb: Number(sizeKb.toFixed(2)) };
        }
      } else {
        result.assetsTotalKb += sizeKb;
      }
    }
  }

  scanDir(path.join(clientDir, 'chunks'), 'chunks');
  scanDir(path.join(clientDir, 'assets'), 'assets');
  result.chunksTotalKb = Number(result.chunksTotalKb.toFixed(2));
  result.assetsTotalKb = Number(result.assetsTotalKb.toFixed(2));
  return result;
}

async function main() {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'archimap-perf-'));
  const server = spawn(process.execPath, ['server.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(PORT),
      NODE_ENV: 'test',
      LOG_LEVEL: 'error',
      METRICS_ENABLED: 'false',
      AUTO_SYNC_ENABLED: 'false',
      AUTO_SYNC_ON_START: 'false',
      SESSION_ALLOW_MEMORY_FALLBACK: 'true',
      SESSION_SECRET: 'perf-smoke-secret',
      APP_BASE_URL: BASE_URL,
      ARCHIMAP_DB_PATH: path.join(tmpRoot, 'archimap.db'),
      LOCAL_EDITS_DB_PATH: path.join(tmpRoot, 'local-edits.db'),
      USER_EDITS_DB_PATH: path.join(tmpRoot, 'user-edits.db'),
      USER_AUTH_DB_PATH: path.join(tmpRoot, 'users.db')
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let output = '';
  server.stdout.on('data', (chunk) => { output += chunk.toString(); });
  server.stderr.on('data', (chunk) => { output += chunk.toString(); });

  try {
    await waitReady();
    const endpoints = {
      '/readyz': await benchmark('/readyz'),
      '/api/contours-status': await benchmark('/api/contours-status'),
      '/api/search-buildings?q=test&limit=20': await benchmark('/api/search-buildings?q=test&limit=20'),
      '/api/buildings/filter-data-bbox?minLon=43.9&minLat=56.2&maxLon=44.1&maxLat=56.4&limit=2000': await benchmark('/api/buildings/filter-data-bbox?minLon=43.9&minLat=56.2&maxLon=44.1&maxLat=56.4&limit=2000')
    };

    const bundle = collectBundleStats();
    const report = {
      timestamp: new Date().toISOString(),
      endpoints,
      bundle
    };
    console.log(JSON.stringify(report, null, 2));
  } finally {
    if (server.exitCode == null) {
      server.kill('SIGTERM');
      await new Promise((resolve) => server.once('exit', resolve));
    }
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }

  if (server.exitCode && server.exitCode !== 0) {
    throw new Error(`Perf server failed\n${output}`);
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
