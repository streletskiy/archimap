const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const DEFAULT_INPUT = path.join(REPO_ROOT, 'frontend', 'static', 'admin-regions.geojson');
const DEFAULT_OUTPUT = path.join(REPO_ROOT, 'frontend', 'static', 'admin-regions.pmtiles');
const DEFAULT_IMAGE = 'archimap-runtime-base:admin-regions';
const DEFAULT_LAYER = 'regions';

function parseArgs(argv = process.argv.slice(2)) {
  const options = {
    input: DEFAULT_INPUT,
    output: DEFAULT_OUTPUT,
    image: DEFAULT_IMAGE,
    layer: DEFAULT_LAYER,
    minZoom: 0,
    maxZoom: 7,
    skipImageBuild: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = String(argv[index] || '').trim();
    if (!arg) continue;
    if (arg === '--input') {
      options.input = path.resolve(REPO_ROOT, String(argv[index + 1] || '').trim());
      index += 1;
      continue;
    }
    if (arg === '--output') {
      options.output = path.resolve(REPO_ROOT, String(argv[index + 1] || '').trim());
      index += 1;
      continue;
    }
    if (arg === '--image') {
      options.image = String(argv[index + 1] || '').trim() || DEFAULT_IMAGE;
      index += 1;
      continue;
    }
    if (arg === '--layer') {
      options.layer = String(argv[index + 1] || '').trim() || DEFAULT_LAYER;
      index += 1;
      continue;
    }
    if (arg === '--min-zoom') {
      options.minZoom = Number(argv[index + 1] || 0);
      index += 1;
      continue;
    }
    if (arg === '--max-zoom') {
      options.maxZoom = Number(argv[index + 1] || 0);
      index += 1;
      continue;
    }
    if (arg === '--skip-image-build') {
      options.skipImageBuild = true;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  if (!Number.isInteger(options.minZoom) || options.minZoom < 0) {
    throw new Error(`Invalid --min-zoom: ${options.minZoom}`);
  }
  if (!Number.isInteger(options.maxZoom) || options.maxZoom < options.minZoom) {
    throw new Error(`Invalid --max-zoom: ${options.maxZoom}`);
  }

  return options;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || REPO_ROOT,
    stdio: options.stdio || 'inherit',
    shell: false,
    env: options.env || process.env
  });
  if (result.status !== 0) {
    throw new Error(`${command} exited with code ${result.status ?? 1}`);
  }
}

function ensureInputExists(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Input file not found: ${filePath}`);
  }
}

function ensureParentDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function buildRuntimeBaseImage(image) {
  run('docker', ['build', '--target', 'runtime-base', '-t', image, '.']);
}

function buildPmtiles({ image, input, output, layer, minZoom, maxZoom }) {
  const workspaceInput = `/workspace/${path.relative(REPO_ROOT, input).replace(/\\/g, '/')}`;
  const workspaceOutput = `/workspace/${path.relative(REPO_ROOT, output).replace(/\\/g, '/')}`;

  run('docker', [
    'run',
    '--rm',
    '-v', `${REPO_ROOT}:/workspace`,
    '-w', '/workspace',
    image,
    'tippecanoe',
    '-o', workspaceOutput,
    '-f',
    '-l', layer,
    '-Z', String(minZoom),
    '-z', String(maxZoom),
    '--read-parallel',
    '--detect-shared-borders',
    '--coalesce-densest-as-needed',
    '--extend-zooms-if-still-dropping',
    workspaceInput
  ]);
}

function main() {
  const options = parseArgs();
  ensureInputExists(options.input);
  ensureParentDir(options.output);

  if (!options.skipImageBuild) {
    buildRuntimeBaseImage(options.image);
  }

  buildPmtiles(options);

  const sizeBytes = Number(fs.statSync(options.output).size || 0);
  console.log(JSON.stringify({
    output: path.relative(REPO_ROOT, options.output).replace(/\\/g, '/'),
    sizeBytes,
    layer: options.layer,
    minZoom: options.minZoom,
    maxZoom: options.maxZoom,
    image: options.image
  }));
}

try {
  main();
} catch (error) {
  console.error(String(error?.message || error));
  process.exit(1);
}
