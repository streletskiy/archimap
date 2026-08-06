const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { ensureDir } = require('./common');

const DEFAULT_PLANETILER_BIN = String(process.env.PLANETILER_BIN || 'planetiler').trim() || 'planetiler';
const DEFAULT_PLANETILER_CONTAINER =
  String(process.env.PLANETILER_CONTAINER || '').trim() || 'archimap-planetiler';
const CONTAINER_DATA_ROOT = '/data';
const HOST_DATA_ROOT = '/app/data';

function runCommand(exe, args, options: LooseRecord = {}) {
  const result = spawnSync(exe, args, {
    stdio: options.stdio || 'inherit',
    shell: false,
    env: options.env || process.env
  });
  return {
    ok: result.status === 0 && !result.error,
    status: result.status ?? 1,
    error: result.error || null
  };
}

function detectPlanetilerExecutable(env: LooseRecord = process.env) {
  const envBin = String(env.PLANETILER_BIN || '').trim();
  const candidates = envBin ? [envBin] : [DEFAULT_PLANETILER_BIN];
  for (const exe of candidates) {
    const probe = runCommand(exe, ['--version'], { stdio: 'pipe', env });
    if (probe.ok) return exe;
  }
  return null;
}

function detectPlanetilerContainer(env: LooseRecord = process.env) {
  const container = String(env.PLANETILER_CONTAINER || DEFAULT_PLANETILER_CONTAINER).trim();
  if (!container) return null;
  const probe = runCommand('docker', ['exec', container, 'java', '-version'], { stdio: 'pipe' });
  if (probe.ok) return container;
  return null;
}

function toContainerPath(hostPath) {
  const normalizedPath = String(hostPath || '').replace(/\\/g, '/');
  if (normalizedPath.startsWith(HOST_DATA_ROOT + '/') || normalizedPath === HOST_DATA_ROOT) {
    return CONTAINER_DATA_ROOT + normalizedPath.slice(HOST_DATA_ROOT.length);
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
    lines.push("    id: '${feature.id}'");
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
  env = process.env
}: LooseRecord) {
  const nativeExe = String(planetilerExe || '').trim() || detectPlanetilerExecutable(env);
  const containerName = nativeExe ? null : detectPlanetilerContainer(env);

  if (!nativeExe && !containerName) {
    throw new Error(
      'planetiler is not available. Install planetiler, set PLANETILER_BIN, or ensure the planetiler sidecar container is running.'
    );
  }

  const effectiveSchemaPath =
    String(schemaPath || '').trim() ||
    path.join(path.dirname(outputPath), `${path.basename(outputPath, '.pmtiles')}.planetiler.yml`);

  if (containerName) {
    // Write schema with container-relative paths for the source data
    const containerInputPath = toContainerPath(inputPath);
    writePlanetilerSchema(effectiveSchemaPath, {
      schemaName,
      inputPath: containerInputPath,
      layer,
      attributeKeys,
      includeFeatureId
    });
    ensureDir(outputPath);

    const containerSchemaPath = toContainerPath(effectiveSchemaPath);
    const containerOutputPath = toContainerPath(outputPath);

    const args = [
      'exec', containerName,
      'java', '-cp', '/app/resources:/app/classes:/app/libs/*',
      'com.onthegomap.planetiler.Main',
      containerSchemaPath,
      `--output=${containerOutputPath}`,
      '--force',
      `--minzoom=${String(minZoom)}`,
      `--maxzoom=${String(maxZoom)}`
    ];
    const built = runCommand('docker', args, { env });
    if (!built.ok) {
      throw new Error(`planetiler (container) failed with exit code ${built.status}`);
    }

    return {
      planetilerExe: `docker:${containerName}`,
      schemaPath: effectiveSchemaPath
    };
  }

  // Native execution (local dev or planetiler installed in main container)
  writePlanetilerSchema(effectiveSchemaPath, {
    schemaName,
    inputPath,
    layer,
    attributeKeys,
    includeFeatureId
  });
  ensureDir(outputPath);

  const args = [
    effectiveSchemaPath,
    `--output=${outputPath}`,
    '--force',
    `--minzoom=${String(minZoom)}`,
    `--maxzoom=${String(maxZoom)}`
  ];
  const built = runCommand(nativeExe, args, { env });
  if (!built.ok) {
    throw new Error(`planetiler failed with exit code ${built.status}`);
  }

  return {
    planetilerExe: nativeExe,
    schemaPath: effectiveSchemaPath
  };
}

module.exports = {
  detectPlanetilerExecutable,
  detectPlanetilerContainer,
  normalizeAttributeKeys,
  runPlanetilerBuild,
  toContainerPath,
  writePlanetilerSchema
};
