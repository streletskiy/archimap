/* global require, module, __dirname, process */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_DOCKERFILE = path.join(REPO_ROOT, 'Dockerfile');
const DEFAULT_PLANETILER_VERSION = String(process.env.PLANETILER_VERSION || '0.10.2').trim() || '0.10.2';

function parseArgs(argv = process.argv.slice(2)) {
  const options = {
    dockerfile: DEFAULT_DOCKERFILE,
    planetilerVersion: DEFAULT_PLANETILER_VERSION
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = String(argv[index] || '').trim();
    if (!arg) continue;
    if (arg === '--dockerfile') {
      options.dockerfile = path.resolve(REPO_ROOT, String(argv[index + 1] || '').trim());
      index += 1;
      continue;
    }
    if (arg === '--planetiler-version') {
      options.planetilerVersion = String(argv[index + 1] || '').trim() || DEFAULT_PLANETILER_VERSION;
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

function extractRuntimeBaseStage(dockerfileText) {
  return extractStage(dockerfileText, 'runtime-base');
}

function extractStage(dockerfileText, stageName) {
  const lines = String(dockerfileText || '')
    .replace(/\r\n/g, '\n')
    .split('\n');
  const collected = [];
  let collecting = false;

  for (const rawLine of lines) {
    const line = String(rawLine || '').replace(/[ \t]+$/u, '');
    if (!collecting) {
      if (/^FROM\s+/i.test(line) && line.match(/\sAS\s+(\S+)$/i)?.[1] === stageName) {
        collecting = true;
        collected.push(line);
      }
      continue;
    }

    if (/^FROM\s+/i.test(line)) {
      break;
    }

    collected.push(line);
  }

  if (collected.length === 0) {
    throw new Error(`Unable to locate ${stageName} stage in Dockerfile`);
  }

  return `${collected.join('\n')}\n`;
}

function collectRuntimeBaseStages(dockerfileText) {
  const stageNames = new Set([...dockerfileText.matchAll(/^FROM\s+.*\sAS\s+(\S+)\s*$/gim)].map((match) => match[1]));
  const visited = new Set();
  const stages = [];
  function visit(name) {
    if (visited.has(name)) return;
    visited.add(name);
    const stage = extractStage(dockerfileText, name);
    stages.push(stage);
    // A cached base also contains artifacts copied from its build stages.
    const dependencies = [...stage.matchAll(/--from=([\w-]+)|^FROM\s+([\w-]+)(?:\s|$)/gim)];
    for (const match of dependencies) {
      const dependency = match[1] || match[2];
      if (stageNames.has(dependency)) visit(dependency);
    }
  }
  visit('runtime-base');
  return stages;
}

function buildRuntimeBaseTag({
  dockerfilePath = DEFAULT_DOCKERFILE,
  dockerfileText = null,
  planetilerVersion = DEFAULT_PLANETILER_VERSION
} = {}) {
  const sourceText =
    typeof dockerfileText === 'string' && dockerfileText.length > 0
      ? dockerfileText
      : fs.readFileSync(String(dockerfilePath || DEFAULT_DOCKERFILE), 'utf8');
  const normalizedSource = String(sourceText || '').replace(/\r\n/g, '\n');
  const nodeImageArg = normalizedSource
    .split('\n')
    .map((line) => String(line || '').replace(/[ \t]+$/u, ''))
    .find((line) => /^ARG\s+NODE_IMAGE=/i.test(line));
  const runtimeBaseStages = collectRuntimeBaseStages(normalizedSource);
  const runtimeBaseInputs = [nodeImageArg || '', ...runtimeBaseStages].filter(Boolean).join('\n');
  const stageHash = crypto.createHash('sha256').update(runtimeBaseInputs, 'utf8').digest('hex').slice(0, 12);
  const version = String(planetilerVersion || '').trim() || DEFAULT_PLANETILER_VERSION;
  return `runtime-base-pl${version}-rb${stageHash}`;
}

if (require.main === module) {
  const options = parseArgs();
  process.stdout.write(`${buildRuntimeBaseTag(options)}\n`);
}

module.exports = {
  buildRuntimeBaseTag,
  extractRuntimeBaseStage,
  parseArgs
};
