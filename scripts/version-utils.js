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

function parseSemverParts(version) {
  const normalized = normalizeVersion(version);
  if (!normalized) return null;
  const withoutBuild = normalized.split('+', 1)[0];
  const [core, prereleaseRaw = ''] = withoutBuild.split('-', 2);
  const [majorRaw, minorRaw, patchRaw] = core.split('.');
  const major = Number(majorRaw);
  const minor = Number(minorRaw);
  const patch = Number(patchRaw);

  if (!Number.isInteger(major) || !Number.isInteger(minor) || !Number.isInteger(patch)) {
    return null;
  }

  const prerelease = prereleaseRaw
    ? prereleaseRaw.split('.').filter((item) => item.length > 0)
    : [];

  return { major, minor, patch, prerelease };
}

function comparePrereleaseIdentifier(left, right) {
  const leftIsNumeric = /^\d+$/.test(left);
  const rightIsNumeric = /^\d+$/.test(right);

  if (leftIsNumeric && rightIsNumeric) {
    const leftNum = Number(left);
    const rightNum = Number(right);
    if (leftNum < rightNum) return -1;
    if (leftNum > rightNum) return 1;
    return 0;
  }

  if (leftIsNumeric && !rightIsNumeric) return -1;
  if (!leftIsNumeric && rightIsNumeric) return 1;
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function compareSemver(leftVersion, rightVersion) {
  const left = parseSemverParts(leftVersion);
  const right = parseSemverParts(rightVersion);

  if (!left && !right) return 0;
  if (!left) return -1;
  if (!right) return 1;

  if (left.major !== right.major) return left.major < right.major ? -1 : 1;
  if (left.minor !== right.minor) return left.minor < right.minor ? -1 : 1;
  if (left.patch !== right.patch) return left.patch < right.patch ? -1 : 1;

  const leftPre = left.prerelease;
  const rightPre = right.prerelease;
  const leftHasPre = leftPre.length > 0;
  const rightHasPre = rightPre.length > 0;

  if (!leftHasPre && !rightHasPre) return 0;
  if (!leftHasPre) return 1;
  if (!rightHasPre) return -1;

  const maxLen = Math.max(leftPre.length, rightPre.length);
  for (let i = 0; i < maxLen; i += 1) {
    const leftId = leftPre[i];
    const rightId = rightPre[i];
    if (leftId == null) return -1;
    if (rightId == null) return 1;
    const idCompare = comparePrereleaseIdentifier(leftId, rightId);
    if (idCompare !== 0) return idCompare;
  }

  return 0;
}

function pickHighestSemver(candidates = []) {
  let selected = '';
  for (const candidate of candidates) {
    const normalized = normalizeVersion(candidate);
    if (!normalized) continue;
    if (!selected || compareSemver(normalized, selected) > 0) {
      selected = normalized;
    }
  }
  return selected;
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
  const latestTag = normalizeVersion(input.latestTag);
  const versionFromTags = pickHighestSemver([semverFromGit, latestTag]);
  const safeDescribe = describe || (gitAvailable ? 'unknown' : 'git-unavailable');
  const safeCommit = commit || parseCommitFromDescribe(describe) || 'unknown';
  const describeWithoutDirty = describe.replace(/-dirty$/i, '');
  const isDescribeCommitAhead = /-\d+-g[0-9a-f]+$/i.test(describeWithoutDirty);
  const isTaggedRelease = EXACT_SEMVER_TAG_RE.test(describeWithoutDirty) && !isDescribeCommitAhead && !dirty;
  const version = versionFromTags || (gitAvailable ? '0.0.0' : packageVersion);

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
  compareSemver,
  createVersionPayload,
  normalizeVersion,
  parseCommitFromDescribe,
  parseSemverFromDescribe,
  pickHighestSemver
};
