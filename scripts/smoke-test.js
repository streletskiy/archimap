const { spawn } = require('child_process');

const TEST_PORT = 3322;
const BASE_URL = `http://127.0.0.1:${TEST_PORT}`;
const CHECKS = ['/', '/account', '/admin', '/app-config.js', '/api/contours-status'];

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
  for (const path of CHECKS) {
    const response = await fetch(`${BASE_URL}${path}`);
    if (!response.ok) {
      throw new Error(`${path} returned HTTP ${response.status}`);
    }
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
