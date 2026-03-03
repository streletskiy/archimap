const EXACT_SEMVER_TAG_RE = /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/i;

function normalizeVersion(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const cleaned = raw.startsWith('v') ? raw.slice(1) : raw;
  return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(cleaned) ? cleaned : '';
}

function parseSemverFromDescribe(describe) {
  const raw = String(describe || '').trim();
  if (!raw) return '';
  const clean = raw.endsWith('-dirty') ? raw.slice(0, -6) : raw;
  if (/-\d+-g[0-9a-f]+$/i.test(clean)) {
    return normalizeVersion(clean.replace(/-\d+-g[0-9a-f]+$/i, ''));
  }
  if (EXACT_SEMVER_TAG_RE.test(clean)) {
    return normalizeVersion(clean);
  }
  return '';
}

function parseCommitFromDescribe(describe) {
  const raw = String(describe || '').trim();
  if (!raw) return '';
  const clean = raw.endsWith('-dirty') ? raw.slice(0, -6) : raw;
  const match = clean.match(/-g([0-9a-f]{7,})$/i);
  if (match) return match[1].toLowerCase();
  if (/^[0-9a-f]{7,}$/i.test(clean)) return clean.toLowerCase();
  return '';
}

function createVersionPayload(input = {}) {
  const packageVersion = normalizeVersion(input.packageVersion) || '0.0.0';
  const describe = String(input.describe || '').trim();
  const commit = String(input.commit || '').trim().toLowerCase();
  const dirty = Boolean(input.dirty) || describe.endsWith('-dirty');
  const buildTime = String(input.buildTime || new Date().toISOString()).trim();
  const appName = String(input.appName || 'archimap').trim() || 'archimap';
  const gitAvailable = Boolean(input.gitAvailable);
  const semverFromGit = parseSemverFromDescribe(describe);
  const safeDescribe = describe || (gitAvailable ? 'unknown' : 'git-unavailable');
  const safeCommit = commit || parseCommitFromDescribe(describe) || 'unknown';
  const isTaggedRelease = EXACT_SEMVER_TAG_RE.test(describe.replace(/-dirty$/i, '')) && !dirty;
  const version = gitAvailable
    ? (semverFromGit || '0.0.0')
    : packageVersion;

  return {
    version,
    git: {
      describe: safeDescribe,
      commit: safeCommit,
      dirty
    },
    buildTime,
    runtime: 'node',
    app: appName,
    isTaggedRelease
  };
}

module.exports = {
  createVersionPayload,
  normalizeVersion,
  parseCommitFromDescribe,
  parseSemverFromDescribe
};
