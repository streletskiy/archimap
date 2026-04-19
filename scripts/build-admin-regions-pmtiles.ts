const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const {
  detectPlanetilerExecutable,
  normalizeAttributeKeys,
  runPlanetilerBuild,
  writePlanetilerSchema
} = require('./region-sync/planetiler');

const REPO_ROOT = path.resolve(__dirname, '..');
const DEFAULT_INPUT = path.join(REPO_ROOT, 'frontend', 'static', 'admin-regions.geojson');
const DEFAULT_OUTPUT = path.join(REPO_ROOT, 'frontend', 'static', 'admin-regions.pmtiles');
const DEFAULT_METADATA_OUTPUT = `${DEFAULT_OUTPUT}.meta.json`;
const DEFAULT_IMAGE = 'archimap-runtime-base:admin-regions';
const DEFAULT_LAYER = 'regions';
const DEFAULT_PLANETILER_BIN = String(process.env.PLANETILER_BIN || 'planetiler').trim() || 'planetiler';

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
    planetilerBin: DEFAULT_PLANETILER_BIN,
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
    if (arg === '--planetiler-bin') {
      options.planetilerBin = String(argv[index + 1] || '').trim() || DEFAULT_PLANETILER_BIN;
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

function canRunLocalPlanetiler(planetilerBin) {
  const result = spawnSync(planetilerBin, ['--version'], {
    cwd: REPO_ROOT,
    stdio: 'ignore',
    shell: false,
    env: process.env
  });
  return result.status === 0;
}

function collectAdminRegionAttributeKeys(inputPath) {
  const payload = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
  const keys = new Set();
  for (const feature of Array.isArray(payload?.features) ? payload.features : []) {
    const properties = feature?.properties;
    if (!properties || typeof properties !== 'object' || Array.isArray(properties)) continue;
    for (const key of Object.keys(properties)) {
      const normalizedKey = String(key || '').trim();
      if (normalizedKey) {
        keys.add(normalizedKey);
      }
    }
  }
  return normalizeAttributeKeys([...keys]);
}

function buildPmtilesLocal({
  input,
  output,
  layer,
  minZoom,
  maxZoom,
  planetilerBin
}: LooseRecord) {
  const schemaPath = `${output}.planetiler.yml`;
  try {
    runPlanetilerBuild({
      planetilerExe: planetilerBin,
      inputPath: input,
      outputPath: output,
      schemaPath,
      schemaName: 'ArchiMap Admin Regions',
      layer,
      minZoom,
      maxZoom,
      attributeKeys: collectAdminRegionAttributeKeys(input),
      includeFeatureId: false,
      env: process.env
    });
  } finally {
    fs.rmSync(schemaPath, { force: true });
  }
}

function buildPmtilesDocker({
  image,
  input,
  output,
  layer,
  minZoom,
  maxZoom
}: LooseRecord) {
  const workspaceInput = `/workspace/${path.relative(REPO_ROOT, input).replace(/\\/g, '/')}`;
  const workspaceOutput = `/workspace/${path.relative(REPO_ROOT, output).replace(/\\/g, '/')}`;
  const schemaHostPath = `${output}.planetiler.yml`;
  const schemaWorkspacePath = `/workspace/${path.relative(REPO_ROOT, schemaHostPath).replace(/\\/g, '/')}`;
  writePlanetilerSchema(schemaHostPath, {
    schemaName: 'ArchiMap Admin Regions',
    inputPath: workspaceInput,
    layer,
    attributeKeys: collectAdminRegionAttributeKeys(input),
    includeFeatureId: false
  });
  try {
    run('docker', [
      'run',
      '--rm',
      '-v',
      `${REPO_ROOT}:/workspace`,
      '-w',
      '/workspace',
      image,
      'planetiler',
      schemaWorkspacePath,
      `--output=${workspaceOutput}`,
      '--force',
      `--minzoom=${String(minZoom)}`,
      `--maxzoom=${String(maxZoom)}`
    ]);
  } finally {
    fs.rmSync(schemaHostPath, { force: true });
  }
}

function writeMetadata({
  input,
  output,
  metadataOutput,
  layer,
  minZoom,
  maxZoom,
  image,
  planetilerBin,
  mode
}) {
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
    planetilerBin,
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

  const useLocalBuild =
    options.local ||
    canRunLocalPlanetiler(options.planetilerBin || detectPlanetilerExecutable(process.env) || DEFAULT_PLANETILER_BIN);
  if (useLocalBuild) {
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
    image: useLocalBuild ? null : options.image,
    planetilerBin: useLocalBuild ? options.planetilerBin : null,
    mode: useLocalBuild ? 'local-planetiler' : 'docker-runtime-base-planetiler'
  });

  const sizeBytes = Number(fs.statSync(options.output).size || 0);
  console.log(
    JSON.stringify({
      output: toRepoRelative(options.output),
      metadataOutput: toRepoRelative(options.metadataOutput),
      sizeBytes,
      layer: options.layer,
      minZoom: options.minZoom,
      maxZoom: options.maxZoom,
      image: useLocalBuild ? null : options.image,
      planetilerBin: useLocalBuild ? options.planetilerBin : null,
      mode: useLocalBuild ? 'local-planetiler' : 'docker-runtime-base-planetiler'
    })
  );
}

try {
  main();
} catch (error) {
  console.error(String(error?.message || error));
  process.exit(1);
}
