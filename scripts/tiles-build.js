const { spawn } = require('child_process');

const args = process.argv.slice(2);
const child = spawn(
  process.execPath,
  ['scripts/sync-osm-buildings.js', ...args],
  {
    stdio: 'inherit',
    cwd: process.cwd(),
    env: {
      ...process.env,
      SYNC_ONCE: 'true'
    }
  }
);

child.on('exit', (code) => {
  process.exit(code ?? 1);
});
