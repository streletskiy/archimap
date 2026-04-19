const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { ensureDir } = require('./common');

const DEFAULT_PLANETILER_BIN = String(process.env.PLANETILER_BIN || 'planetiler').trim() || 'planetiler';

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
  const exe = String(planetilerExe || '').trim() || detectPlanetilerExecutable(env);
  if (!exe) {
    throw new Error('planetiler is not available. Install planetiler or set PLANETILER_BIN.');
  }

  const effectiveSchemaPath =
    String(schemaPath || '').trim() ||
    path.join(path.dirname(outputPath), `${path.basename(outputPath, '.pmtiles')}.planetiler.yml`);

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
  const built = runCommand(exe, args, { env });
  if (!built.ok) {
    throw new Error(`planetiler failed with exit code ${built.status}`);
  }

  return {
    planetilerExe: exe,
    schemaPath: effectiveSchemaPath
  };
}

module.exports = {
  detectPlanetilerExecutable,
  normalizeAttributeKeys,
  runPlanetilerBuild,
  writePlanetilerSchema
};
