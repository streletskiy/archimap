const { spawnSync } = require('node:child_process');
const { copyFileSync, existsSync, mkdirSync } = require('node:fs');
const path = require('node:path');

const rootDir = path.resolve(__dirname, '..');
const generatedDir = path.join(rootDir, 'src', 'graphify-out');
const snapshotDir = path.join(rootDir, 'graphify-out');
const snapshotFiles = ['.graphify_labels.json', 'GRAPH_REPORT.md', 'graph.html', 'graph.json'];

const result = spawnSync('graphify', ['update', 'src'], {
  cwd: rootDir,
  stdio: 'inherit'
});

if (result.error) {
  if (result.error.code === 'ENOENT') {
    throw new Error('Graphify CLI is not installed or is not available on PATH.');
  }
  throw result.error;
}

if (result.status !== 0) {
  throw new Error(`Graphify update failed with exit code ${result.status}.`);
}

mkdirSync(snapshotDir, { recursive: true });

for (const fileName of snapshotFiles) {
  const source = path.join(generatedDir, fileName);
  if (!existsSync(source)) {
    throw new Error(`Graphify did not produce the expected artifact: ${source}`);
  }
  copyFileSync(source, path.join(snapshotDir, fileName));
}

console.log(`Updated the tracked Graphify snapshot (${snapshotFiles.length} files).`);
