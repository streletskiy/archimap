const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { buildCspDirectives, serializeCspDirectives } = require('../src/lib/server/infra/csp.infra');

const TEST_PORT = 3920 + Math.floor(Math.random() * 120);
const BASE_URL = `http://127.0.0.1:${TEST_PORT}`;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForServer(baseUrl, timeoutMs = 15000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(`${baseUrl}/readyz`);
      if (response.ok) return;
    } catch {
      // ignore until startup completes
    }
    await sleep(250);
  }
  throw new Error(`Server did not become ready in ${timeoutMs}ms`);
}

async function main() {
  const prodCsp = serializeCspDirectives(buildCspDirectives({
    nodeEnv: 'production',
    extraConnectOrigins: ['https://tiles.basemaps.cartocdn.com']
  }));
  if (/\bscript-src\s[^;]*unsafe-inline/.test(prodCsp) || /\bstyle-src\s[^;]*unsafe-inline/.test(prodCsp)) {
    throw new Error('Production CSP must not include unsafe-inline in script-src/style-src');
  }

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'archimap-csp-'));
  const pmtilesFileName = `check-csp-${Date.now()}.pmtiles`;
  const pmtilesPath = path.join(process.cwd(), 'data', pmtilesFileName);
  fs.mkdirSync(path.dirname(pmtilesPath), { recursive: true });
  fs.writeFileSync(pmtilesPath, Buffer.alloc(2048, 1));

  const server = spawn(process.execPath, ['server.sveltekit.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DB_PROVIDER: 'sqlite',
      PORT: String(TEST_PORT),
      NODE_ENV: 'test',
      LOG_LEVEL: 'error',
      METRICS_ENABLED: 'false',
      AUTO_SYNC_ENABLED: 'false',
      AUTO_SYNC_ON_START: 'false',
      SESSION_ALLOW_MEMORY_FALLBACK: 'true',
      SESSION_COOKIE_SECURE: 'false',
      SESSION_SECRET: 'check-csp-secret',
      APP_BASE_URL: BASE_URL,
      ARCHIMAP_DB_PATH: path.join(tmpRoot, 'archimap.db'),
      LOCAL_EDITS_DB_PATH: path.join(tmpRoot, 'local-edits.db'),
      USER_EDITS_DB_PATH: path.join(tmpRoot, 'user-edits.db'),
      USER_AUTH_DB_PATH: path.join(tmpRoot, 'users.db'),
      BUILDINGS_PMTILES_FILE: pmtilesFileName
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let output = '';
  server.stdout.on('data', (chunk) => { output += chunk.toString(); });
  server.stderr.on('data', (chunk) => { output += chunk.toString(); });

  try {
    await waitForServer(BASE_URL);
    const response = await fetch(`${BASE_URL}/`);
    if (!response.ok) throw new Error(`GET / failed: ${response.status}`);

    const csp = String(response.headers.get('content-security-policy') || '');
    if (!csp) throw new Error('Missing Content-Security-Policy header on HTML response');
    if (/\bscript-src\s[^;]*unsafe-inline/.test(csp) || /\bstyle-src\s[^;]*unsafe-inline/.test(csp)) {
      throw new Error('CSP header includes unsafe-inline in script-src/style-src');
    }

    const html = await response.text();
    if (/cdn|unpkg|cdnjs|fonts\.googleapis/i.test(html)) {
      throw new Error('Rendered HTML contains CDN references');
    }
    console.log('CSP/security checks passed');
  } finally {
    if (server.exitCode == null) {
      server.kill('SIGTERM');
      await new Promise((resolve) => server.once('exit', resolve));
    }
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    fs.rmSync(pmtilesPath, { force: true });
  }

  if (server.exitCode && server.exitCode !== 0) {
    throw new Error(`Server failed during CSP checks\n${output}`);
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
