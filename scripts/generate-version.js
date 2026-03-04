#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { createVersionPayload, normalizeVersion } = require('./version-utils');

const ROOT_DIR = path.join(__dirname, '..');
const PACKAGE_JSON_PATH = path.join(ROOT_DIR, 'package.json');
const TARGETS = [
  path.join(ROOT_DIR, 'src', 'lib', 'version.generated.json'),
  path.join(ROOT_DIR, 'frontend', 'src', 'lib', 'version.generated.json')
];

function readPackageVersion() {
  try {
    const raw = fs.readFileSync(PACKAGE_JSON_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    return normalizeVersion(parsed?.version) || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function runGit(command) {
  try {
    return String(execSync(command, {
      cwd: ROOT_DIR,
      stdio: ['ignore', 'pipe', 'ignore']
    }) || '').trim();
  } catch {
    return '';
  }
}

function writeJsonFile(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function main() {
  const packageVersion = readPackageVersion();
  const buildTime = new Date().toISOString();
  const describe = String(process.env.BUILD_DESCRIBE || '').trim() || runGit('git describe --tags --always --dirty');
  const commit = String(process.env.BUILD_SHA || '').trim().toLowerCase() || runGit('git rev-parse --short HEAD');
  const gitAvailable = Boolean(describe || commit);
  const payload = createVersionPayload({
    packageVersion,
    describe,
    commit,
    buildTime,
    appName: 'archimap',
    gitAvailable
  });

  if (!gitAvailable) {
    console.warn('[version] git metadata is unavailable, using package.json fallback');
  }

  for (const targetPath of TARGETS) {
    writeJsonFile(targetPath, payload);
  }
  console.log(`[version] ${payload.version} (${payload.git.commit}, ${payload.buildTime})`);
}

main();
