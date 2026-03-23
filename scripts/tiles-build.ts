const { spawn } = require('child_process');

const args = process.argv.slice(2);
const child = spawn(
  process.execPath,
  ['--import', 'tsx', 'scripts/sync-osm-buildings.ts', ...args],
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
