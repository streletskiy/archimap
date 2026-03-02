const { spawn } = require('child_process');

const TEST_PORT = 3322;
const BASE_URL = `http://127.0.0.1:${TEST_PORT}`;
const PAGE_CHECKS = ['/', '/account', '/admin', '/info', '/app-config.js', '/api/contours-status'];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForServerReady(timeoutMs = 15000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(`${BASE_URL}/api/contours-status`);
      if (response.ok) {
        return;
      }
    } catch {
      // Server is not ready yet.
    }
    await sleep(300);
  }
  throw new Error(`Server did not start within ${timeoutMs}ms`);
}

async function checkEndpoints() {
  for (const path of PAGE_CHECKS) {
    const response = await fetch(`${BASE_URL}${path}`);
    if (!response.ok) {
      throw new Error(`${path} returned HTTP ${response.status}`);
    }
  }

  const mapDataResp = await fetch(`${BASE_URL}/api/search-buildings?q=test&limit=5`);
  if (!mapDataResp.ok) {
    throw new Error(`/api/search-buildings returned HTTP ${mapDataResp.status}`);
  }

  const meResp = await fetch(`${BASE_URL}/api/me`);
  if (meResp.status !== 200) {
    throw new Error(`/api/me must return 200, got ${meResp.status}`);
  }
  const mePayload = await meResp.json().catch(() => null);
  if (!mePayload || mePayload.authenticated !== false) {
    throw new Error('/api/me must indicate authenticated=false for anonymous user');
  }

  const adminResp = await fetch(`${BASE_URL}/api/admin/users`);
  if (![401, 403].includes(adminResp.status)) {
    throw new Error(`/api/admin/users must return 401/403 for anonymous user, got ${adminResp.status}`);
  }
}

async function main() {
  const child = spawn(process.execPath, ['server.js'], {
    env: {
      ...process.env,
      PORT: String(TEST_PORT),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let serverOutput = '';
  child.stdout.on('data', (chunk) => {
    serverOutput += chunk.toString();
  });
  child.stderr.on('data', (chunk) => {
    serverOutput += chunk.toString();
  });

  try {
    await waitForServerReady();
    await checkEndpoints();
    console.log('Smoke checks passed');
  } catch (error) {
    console.error('Smoke checks failed:', error.message);
    if (serverOutput.trim()) {
      console.error('Server output:\n' + serverOutput.trim());
    }
    process.exitCode = 1;
  } finally {
    child.kill('SIGTERM');
    await new Promise((resolve) => child.once('exit', resolve));
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
