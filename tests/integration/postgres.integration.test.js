const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const path = require('path');

function runCommand(args, env = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, args, {
      cwd: path.join(__dirname, '..', '..'),
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let output = '';
    proc.stdout.on('data', (chunk) => { output += chunk.toString(); });
    proc.stderr.on('data', (chunk) => { output += chunk.toString(); });
    proc.on('error', reject);
    proc.on('exit', (code) => {
      if (code === 0) return resolve(output);
      return reject(new Error(`Command failed (${args.join(' ')}), code=${code}\n${output}`));
    });
  });
}

test('postgres migration + postgis smoke', async () => {
  const databaseUrl = String(process.env.DATABASE_URL || '').trim();
  if (!databaseUrl) {
    console.warn('[postgres.integration] skipped: DATABASE_URL is not set');
    return;
  }

  await runCommand(['scripts/postgres-migrate.js'], {
    DB_PROVIDER: 'postgres',
    DATABASE_URL: databaseUrl
  });

  const smokeOut = await runCommand(['scripts/postgres-smoke.js'], {
    DB_PROVIDER: 'postgres',
    DATABASE_URL: databaseUrl
  });
  assert.match(smokeOut, /PostgreSQL\/PostGIS smoke checks passed/);
});
