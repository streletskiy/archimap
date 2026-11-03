const fs = require('fs');
const os = require('os');
const path = require('path');
const { randomUUID } = require('crypto');
const { spawnSync } = require('child_process');
const { ensureDir } = require('./common');

const DEFAULT_PLANETILER_BIN = String(process.env.PLANETILER_BIN || 'planetiler').trim() || 'planetiler';
const DEFAULT_PLANETILER_CONTAINER = String(process.env.PLANETILER_CONTAINER || '').trim() || 'archimap-planetiler';
const CONTAINER_DATA_ROOT = '/data';
const HOST_DATA_ROOT = '/app/data';

function runCommand(exe, args, options: LooseRecord = {}) {
  const result = (options.spawnSyncRef || spawnSync)(exe, args, {
    stdio: options.stdio || 'inherit',
    shell: false,
    windowsHide: true,
    env: options.env || process.env
  });
  return {
    ok: result.status === 0 && !result.error,
    status: result.status ?? 1,
    error: result.error || null
  };
}

function detectPlanetilerExecutable(env: LooseRecord = process.env, spawnSyncRef = spawnSync) {
  const envBin = String(env.PLANETILER_BIN || '').trim();
  const candidates = envBin ? [envBin] : [DEFAULT_PLANETILER_BIN];
  for (const exe of candidates) {
    const probe = runCommand(exe, ['--version'], { stdio: 'pipe', env, spawnSyncRef });
    if (probe.ok) return exe;
  }
  return null;
}

function detectPlanetilerContainer(env: LooseRecord = process.env, spawnSyncRef = spawnSync) {
  const container = String(env.PLANETILER_CONTAINER || DEFAULT_PLANETILER_CONTAINER).trim();
  if (!container) return null;
  const probe = runCommand('docker', ['exec', container, 'java', '-version'], { stdio: 'pipe', env, spawnSyncRef });
  if (probe.ok) return container;
  return null;
}

function toContainerPath(hostPath, env: LooseRecord = process.env) {
  const normalizedPath = String(hostPath || '').replace(/\\/g, '/');
  const hostRoot = String(env.PLANETILER_HOST_DATA_ROOT || HOST_DATA_ROOT)
    .replace(/\\/g, '/')
    .replace(/\/$/, '');
  const containerRoot = String(env.PLANETILER_CONTAINER_DATA_ROOT || CONTAINER_DATA_ROOT).replace(/\/$/, '');
  if (normalizedPath.startsWith(hostRoot + '/') || normalizedPath === hostRoot) {
    return containerRoot + normalizedPath.slice(hostRoot.length);
  }
  return normalizedPath;
}

function normalizeAttributeKeys(attributeKeys = []) {
  return [...new Set((Array.isArray(attributeKeys) ? attributeKeys : []).map((item) => String(item || '').trim()))]
    .filter(Boolean)
    .sort((left, right) => left.localeCompare(right));
}

function buildPlanetilerSchema({
  schemaName,
  inputPath,
  layer,
  attributeKeys = [],
  includeFeatureId = false
}: LooseRecord) {
  const normalizedAttributes = normalizeAttributeKeys(attributeKeys);
  const lines = [
    `schema_name: ${JSON.stringify(String(schemaName || 'ArchiMap PMTiles'))}`,
    'is_overlay: true',
    'sources:',
    '  archimap:',
    '    type: geojson',
    `    local_path: ${JSON.stringify(String(inputPath || ''))}`,
    'layers:',
    `- id: ${JSON.stringify(String(layer || 'buildings'))}`,
    '  features:',
    '  - source: archimap'
  ];

  if (includeFeatureId) {
    // GeoJsonReader assigns feature.id from the input row number, ignoring the
    // GeoJSON top-level id. Derive the same OSM identity for full and subset inputs.
    lines.push('    id: \'${int(feature.tags.osm_id) * 2 + (feature.tags.osm_type == "relation" ? 1 : 0)}\'');
  }

  lines.push('    geometry: any');

  if (normalizedAttributes.length === 0) {
    lines.push('    attributes: []');
  } else {
    lines.push('    attributes:');
    for (const key of normalizedAttributes) {
      lines.push(`    - key: ${JSON.stringify(key)}`);
    }
  }

  return `${lines.join('\n')}\n`;
}

function writePlanetilerSchema(schemaPath, options: LooseRecord = {}) {
  ensureDir(schemaPath);
  const schema = buildPlanetilerSchema(options);
  fs.writeFileSync(schemaPath, schema, 'utf8');
  return schemaPath;
}

function buildPlanetilerArgs({ schemaPath, outputPath, tempPath, minZoom, maxZoom, buildBounds }) {
  const args = [
    schemaPath,
    `--output=${outputPath}`,
    '--force',
    `--minzoom=${minZoom}`,
    `--maxzoom=${maxZoom}`,
    `--tmpdir=${tempPath}`
  ];
  if (buildBounds != null) {
    const bounds = Array.isArray(buildBounds)
      ? buildBounds
      : [buildBounds.west, buildBounds.south, buildBounds.east, buildBounds.north];
    if (bounds.length !== 4 || !bounds.every(Number.isFinite) || bounds[0] >= bounds[2] || bounds[1] >= bounds[3]) {
      throw new Error('Planetiler build bounds must be a finite west,south,east,north envelope');
    }
    args.push(`--bounds=${bounds.join(',')}`);
  }
  return args;
}

function runPlanetilerBuild({
  planetilerExe,
  inputPath,
  outputPath,
  schemaPath,
  schemaName,
  layer,
  minZoom,
  maxZoom,
  attributeKeys,
  includeFeatureId = false,
  buildBounds = null,
  env = process.env,
  spawnSyncRef = spawnSync
}: LooseRecord) {
  const nativeExe = String(planetilerExe || '').trim() || detectPlanetilerExecutable(env, spawnSyncRef);
  const containerName = nativeExe ? null : detectPlanetilerContainer(env, spawnSyncRef);

  if (!nativeExe && !containerName) {
    throw new Error(
      'planetiler is not available. Install planetiler, set PLANETILER_BIN, or ensure the planetiler sidecar container is running.'
    );
  }

  const effectiveSchemaPath =
    String(schemaPath || '').trim() ||
    path.join(path.dirname(outputPath), `${path.basename(outputPath, '.pmtiles')}.planetiler.yml`);

  ensureDir(outputPath);
  const localIO = !['0', 'false', 'off'].includes(String(env.REGION_SYNC_PLANETILER_LOCAL_IO || '').toLowerCase());
  const nativeTemporaryWorkspace = !containerName && localIO;
  const workspaceName = `archimap-planetiler-${randomUUID()}`;
  const workspaceRoot = containerName && localIO ? '/tmp' : path.dirname(outputPath);
  let workspace = nativeTemporaryWorkspace ? null :
    containerName && localIO ? `${workspaceRoot}/${workspaceName}` : path.join(workspaceRoot, workspaceName);
  let engineWorkspace = containerName && !localIO ? toContainerPath(workspace, env) : workspace;
  if (containerName && localIO) {
    if (!/^\/tmp\/archimap-planetiler-[0-9a-f-]{36}$/.test(engineWorkspace)) {
      throw new Error('Refusing to use an unexpected Planetiler workspace');
    }
  } else if (!nativeTemporaryWorkspace && (
    path.dirname(path.resolve(workspace)) !== path.resolve(workspaceRoot) || path.basename(workspace) !== workspaceName)
  ) {
    throw new Error('Refusing to use an unexpected Planetiler workspace');
  }
  const engineInput =
    containerName && localIO
      ? `${engineWorkspace}/input.ndjson`
      : containerName
        ? toContainerPath(inputPath, env)
        : path.resolve(inputPath);
  const engineSchema =
    containerName && localIO
      ? `${engineWorkspace}/schema.yml`
      : containerName
        ? toContainerPath(effectiveSchemaPath, env)
        : path.resolve(effectiveSchemaPath);
  let engineOutput = nativeTemporaryWorkspace ? null : `${engineWorkspace}/output.pmtiles`;
  const copyPath = `${outputPath}.${workspaceName}.tmp`;
  let workspaceCreated = false;
  let copyReserved = false;
  let copyFd = null;

  function checked(exe, args, label, stdio: import('node:child_process').StdioOptions = 'inherit') {
    const result = runCommand(exe, args, { env, spawnSyncRef, stdio });
    if (!result.ok) {
      throw new Error(
        `planetiler ${label} failed with exit code ${result.status}${result.error ? `: ${result.error.message}` : ''}`
      );
    }
  }

  try {
    if (containerName && localIO) {
      checked('docker', ['exec', containerName, 'mkdir', '--mode=700', '--', engineWorkspace], 'workspace creation');
    } else if (nativeTemporaryWorkspace) {
      // mkdtemp creates an exclusive private directory under the shared system
      // temp root. Read the engine output only through this owned directory.
      workspace = fs.mkdtempSync(path.join(os.tmpdir(), `${workspaceName}-`));
      engineWorkspace = workspace;
      engineOutput = path.join(workspace, 'output.pmtiles');
    } else {
      fs.mkdirSync(workspace, { mode: 0o700 });
    }
    workspaceCreated = true;
    writePlanetilerSchema(effectiveSchemaPath, {
      schemaName,
      inputPath: engineInput,
      layer,
      attributeKeys,
      includeFeatureId
    });
    const args = buildPlanetilerArgs({
      schemaPath: engineSchema,
      outputPath: engineOutput,
      tempPath: `${engineWorkspace}/tmp`,
      minZoom,
      maxZoom,
      buildBounds
    });

    if (containerName) {
      if (localIO) {
        checked(
          'docker',
          ['exec', containerName, 'cp', '--', toContainerPath(inputPath, env), engineInput],
          'input staging'
        );
        checked(
          'docker',
          ['exec', containerName, 'cp', '--', toContainerPath(effectiveSchemaPath, env), engineSchema],
          'schema staging'
        );
      }
      checked(
        'docker',
        [
          'exec',
          containerName,
          'java',
          '-cp',
          '/app/resources:/app/classes:/app/libs/*',
          'com.onthegomap.planetiler.Main',
          ...args
        ],
        '(container)'
      );
    } else {
      checked(nativeExe, args, 'build');
    }

    // Keep the exclusively created descriptor through copy and fsync. Reopening
    // its name could follow a file replaced between reservation and publication.
    // A failed build or copy must never truncate the caller's previous archive.
    copyFd = fs.openSync(copyPath, 'wx');
    copyReserved = true;
    if (containerName) {
      checked(
        'docker',
        ['exec', containerName, 'cat', '--', engineOutput],
        'output staging',
        ['ignore', copyFd, 'inherit']
      );
    } else {
      const sourceFd = fs.openSync(engineOutput, 'r');
      try {
        const buffer = Buffer.allocUnsafe(1024 * 1024);
        let length;
        while ((length = fs.readSync(sourceFd, buffer, 0, buffer.length, null)) > 0) {
          let written = 0;
          while (written < length) {
            const count = fs.writeSync(copyFd, buffer, written, length - written);
            if (count <= 0) throw new Error('Incomplete Planetiler output copy');
            written += count;
          }
        }
      } finally {
        fs.closeSync(sourceFd);
      }
    }
    fs.fsyncSync(copyFd);
    fs.closeSync(copyFd);
    copyFd = null;
    fs.renameSync(copyPath, outputPath);
    copyReserved = false;
    return {
      planetilerExe: containerName ? `docker:${containerName}` : nativeExe,
      schemaPath: effectiveSchemaPath
    };
  } finally {
    if (copyFd !== null) fs.closeSync(copyFd);
    if (copyReserved) fs.rmSync(copyPath, { force: true });
    if (workspaceCreated) {
      if (containerName && localIO) {
        const cleanup = runCommand('docker', ['exec', containerName, 'rm', '-rf', '--', engineWorkspace], {
          env,
          spawnSyncRef
        });
        if (!cleanup.ok) console.warn(`Unable to remove Planetiler temporary workspace ${engineWorkspace}`);
      } else {
        fs.rmSync(workspace, { recursive: true, force: true });
      }
    }
  }
}

module.exports = {
  detectPlanetilerExecutable,
  detectPlanetilerContainer,
  normalizeAttributeKeys,
  runPlanetilerBuild,
  toContainerPath,
  writePlanetilerSchema
};
