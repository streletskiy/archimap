const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const DEFAULT_INPUT = path.join(REPO_ROOT, 'frontend', 'static', 'admin-regions.geojson');
const DEFAULT_OUTPUT = path.join(REPO_ROOT, 'frontend', 'static', 'admin-regions.pmtiles');
const DEFAULT_METADATA_OUTPUT = `${DEFAULT_OUTPUT}.meta.json`;
const DEFAULT_IMAGE = 'archimap-runtime-base:admin-regions';
const DEFAULT_LAYER = 'regions';
const DEFAULT_TIPPECANOE_BIN = String(process.env.TIPPECANOE_BIN || 'tippecanoe').trim() || 'tippecanoe';

function parseArgs(argv = process.argv.slice(2)): LooseRecord {
  const options = {
    input: DEFAULT_INPUT,
    output: DEFAULT_OUTPUT,
    image: DEFAULT_IMAGE,
    layer: DEFAULT_LAYER,
    minZoom: 0,
    maxZoom: 7,
    skipImageBuild: false,
    local: false,
    tippecanoeBin: DEFAULT_TIPPECANOE_BIN,
    metadataOutput: DEFAULT_METADATA_OUTPUT
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
    if (arg === '--metadata-output') {
      options.metadataOutput = path.resolve(REPO_ROOT, String(argv[index + 1] || '').trim());
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
    if (arg === '--local') {
      options.local = true;
      continue;
    }
    if (arg === '--tippecanoe-bin') {
      options.tippecanoeBin = String(argv[index + 1] || '').trim() || DEFAULT_TIPPECANOE_BIN;
      index += 1;
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

function run(command, args, options: LooseRecord = {}) {
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

function toRepoRelative(filePath) {
  return path.relative(REPO_ROOT, filePath).replace(/\\/g, '/');
}

function hashFile(filePath) {
  const digest = crypto.createHash('sha256');
  digest.update(fs.readFileSync(filePath));
  return digest.digest('hex');
}

function cleanupJournal(output) {
  const journalPath = `${output}-journal`;
  if (!fs.existsSync(journalPath)) return;
  fs.rmSync(journalPath, { force: true });
}

function buildRuntimeBaseImage(image) {
  run('docker', ['build', '--target', 'runtime-base', '-t', image, '.']);
}

function canRunLocalTippecanoe(tippecanoeBin) {
  const result = spawnSync(tippecanoeBin, ['--version'], {
    cwd: REPO_ROOT,
    stdio: 'ignore',
    shell: false,
    env: process.env
  });
  return result.status === 0;
}

function buildPmtilesLocal({ input, output, layer, minZoom, maxZoom, tippecanoeBin }: LooseRecord) {
  run(tippecanoeBin, [
    '-o', output,
    '-f',
    '-l', layer,
    '-Z', String(minZoom),
    '-z', String(maxZoom),
    '--read-parallel',
    '--detect-shared-borders',
    '--coalesce-densest-as-needed',
    '--extend-zooms-if-still-dropping',
    input
  ]);
}

function buildPmtilesDocker({ image, input, output, layer, minZoom, maxZoom }: LooseRecord) {
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

function writeMetadata({ input, output, metadataOutput, layer, minZoom, maxZoom, image, tippecanoeBin, mode }) {
  const payload = {
    input: toRepoRelative(input),
    output: toRepoRelative(output),
    inputBytes: Number(fs.statSync(input).size || 0),
    inputSha256: hashFile(input),
    outputBytes: Number(fs.statSync(output).size || 0),
    layer,
    minZoom,
    maxZoom,
    image,
    tippecanoeBin,
    mode,
    generatedAt: new Date().toISOString()
  };
  ensureParentDir(metadataOutput);
  fs.writeFileSync(metadataOutput, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function main() {
  const options = parseArgs();
  ensureInputExists(options.input);
  ensureParentDir(options.output);
  ensureParentDir(options.metadataOutput);

  const useLocalTippecanoe = options.local || canRunLocalTippecanoe(options.tippecanoeBin);
  if (useLocalTippecanoe) {
    buildPmtilesLocal(options);
  } else {
    if (!options.skipImageBuild) {
      buildRuntimeBaseImage(options.image);
    }
    buildPmtilesDocker(options);
  }
  cleanupJournal(options.output);
  writeMetadata({
    input: options.input,
    output: options.output,
    metadataOutput: options.metadataOutput,
    layer: options.layer,
    minZoom: options.minZoom,
    maxZoom: options.maxZoom,
    image: useLocalTippecanoe ? null : options.image,
    tippecanoeBin: useLocalTippecanoe ? options.tippecanoeBin : null,
    mode: useLocalTippecanoe ? 'local-tippecanoe' : 'docker-runtime-base'
  });

  const sizeBytes = Number(fs.statSync(options.output).size || 0);
  console.log(JSON.stringify({
    output: toRepoRelative(options.output),
    metadataOutput: toRepoRelative(options.metadataOutput),
    sizeBytes,
    layer: options.layer,
    minZoom: options.minZoom,
    maxZoom: options.maxZoom,
    image: useLocalTippecanoe ? null : options.image,
    tippecanoeBin: useLocalTippecanoe ? options.tippecanoeBin : null,
    mode: useLocalTippecanoe ? 'local-tippecanoe' : 'docker-runtime-base'
  }));
}

try {
  main();
} catch (error) {
  console.error(String(error?.message || error));
  process.exit(1);
}
