require('dotenv').config({ quiet: true });

const path = require('path');
const { spawnSync } = require('child_process');

function hasRegionIdArg(args) {
  return args.some((arg) => String(arg || '').trim() === '--region-id' || String(arg || '').trim().startsWith('--region-id='));
}

function printLegacyModeError() {
  const help = [
    'Legacy env-based OSM sync/build flow has been removed.',
    'Configure regions in Admin -> Data and run sync there, or use:',
    `  node --import tsx ${path.join('scripts', 'sync-osm-region.ts')} --region-id=<id>`
  ];
  console.error(help.join('\n'));
}

function main() {
  const args = process.argv.slice(2);
  if (!hasRegionIdArg(args)) {
    printLegacyModeError();
    process.exit(1);
  }

  const regionSyncScriptPath = path.join(__dirname, 'sync-osm-region.ts');
  const delegated = spawnSync(process.execPath, ['--import', 'tsx', regionSyncScriptPath, ...args], {
    stdio: 'inherit',
    shell: false,
    env: process.env
  });
  process.exit(delegated.status ?? 1);
}

main();
