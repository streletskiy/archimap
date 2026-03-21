const fs = require('fs');
const path = require('path');

const VERSION_PATH = path.join(__dirname, '..', 'version.generated.json');
const PACKAGE_JSON_PATH = path.join(__dirname, '..', '..', '..', 'package.json');

function readJson(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function normalizeVersion(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  return raw.startsWith('v') ? raw.slice(1) : raw;
}

function fallbackVersionPayload() {
  const packageJson = readJson(PACKAGE_JSON_PATH);
  return {
    version: normalizeVersion(packageJson?.version) || '0.0.0',
    git: {
      describe: 'runtime-fallback',
      commit: 'unknown',
      dirty: false
    },
    buildTime: new Date().toISOString(),
    runtime: 'node',
    app: 'archimap',
    isTaggedRelease: false
  };
}

function getAppVersion() {
  const fallback = fallbackVersionPayload();
  const fromGenerated = readJson(VERSION_PATH);
  if (!fromGenerated || typeof fromGenerated !== 'object') {
    return fallback;
  }
  return {
    ...fallback,
    ...fromGenerated,
    git: {
      ...fallback.git,
      ...(fromGenerated.git && typeof fromGenerated.git === 'object' ? fromGenerated.git : {})
    }
  };
}

function getBuildInfo() {
  const version = getAppVersion();
  return {
    shortSha: String(version?.git?.commit || 'unknown'),
    version: String(version?.version || '0.0.0')
  };
}

module.exports = {
  getAppVersion,
  getBuildInfo
};
