const { spawn } = require('child_process');

const args = process.argv.slice(2);
const child = spawn(process.execPath, ['--import', 'tsx', 'scripts/sync-osm-region.ts', ...args], {
  stdio: 'inherit',
  cwd: process.cwd(),
  env: process.env
});

child.on('exit', (code) => {
  process.exit(code ?? 1);
});
