const test = require('node:test');
const assert = require('node:assert/strict');
const { createVersionPayload, parseSemverFromDescribe } = require('../../scripts/version-utils');

test('parseSemverFromDescribe extracts semver from tagged describe output', () => {
  assert.equal(parseSemverFromDescribe('v1.2.3'), '1.2.3');
  assert.equal(parseSemverFromDescribe('v1.2.3-7-gabc1234'), '1.2.3');
});

test('parseSemverFromDescribe returns empty when describe has no tag', () => {
  assert.equal(parseSemverFromDescribe('abc1234'), '');
});

test('createVersionPayload falls back to package version when git is unavailable', () => {
  const payload = createVersionPayload({
    packageVersion: '1.0.0',
    describe: '',
    commit: '',
    gitAvailable: false,
    buildTime: '2026-03-03T19:40:00.000Z'
  });

  assert.equal(payload.version, '1.0.0');
  assert.equal(payload.git.commit, 'unknown');
  assert.equal(payload.git.describe, 'git-unavailable');
  assert.equal(payload.buildTime, '2026-03-03T19:40:00.000Z');
});
