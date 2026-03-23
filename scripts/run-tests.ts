const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

function collectTestFiles(targets) {
  const files = [];
  const stack = [...targets].map((target) => path.resolve(process.cwd(), target));

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || !fs.existsSync(current)) continue;
    const stat = fs.statSync(current);
    if (stat.isDirectory()) {
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name === '.svelte-kit' || entry.name === 'build') {
          continue;
        }
        stack.push(path.join(current, entry.name));
      }
      continue;
    }

    if (!/\.(test|spec)\.(cts|mts|ts|js)$/i.test(current)) {
      continue;
    }
    files.push(current);
  }

  return files.sort((left, right) => left.localeCompare(right));
}

function main() {
  const targets = process.argv.slice(2);
  if (targets.length === 0) {
    console.error('Usage: node --import tsx scripts/run-tests.ts <path> [...path]');
    process.exit(1);
  }

  const files = collectTestFiles(targets);
  if (files.length === 0) {
    console.error(`No test files found under: ${targets.join(', ')}`);
    process.exit(1);
  }

  const result = spawnSync(process.execPath, ['--import', 'tsx', '--test', ...files], {
    cwd: process.cwd(),
    env: process.env,
    stdio: 'inherit'
  });

  if (result.error) {
    console.error(result.error.stack || result.error.message || String(result.error));
    process.exit(1);
  }
  process.exit(result.status ?? 1);
}

main();
