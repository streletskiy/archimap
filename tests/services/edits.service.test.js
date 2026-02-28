const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeUserEditStatus,
  sanitizeFieldText,
  sanitizeYearBuilt,
  sanitizeLevels,
  sanitizeArchiPayload
} = require('../../services/edits.service');

test('normalizeUserEditStatus returns pending for unknown values', () => {
  assert.equal(normalizeUserEditStatus('unknown'), 'pending');
  assert.equal(normalizeUserEditStatus('ACCEPTED'), 'accepted');
});

test('sanitize numeric fields keeps valid values and rejects invalid', () => {
  assert.equal(sanitizeYearBuilt('1901'), 1901);
  assert.equal(sanitizeYearBuilt('99'), null);
  assert.equal(sanitizeLevels('12'), 12);
  assert.equal(sanitizeLevels('301'), null);
});

test('sanitizeArchiPayload validates bounds and normalizes text', () => {
  const ok = sanitizeArchiPayload({ name: '  Test  ', yearBuilt: '1950', levels: '5' });
  assert.equal(ok.error, undefined);
  assert.equal(ok.value.name, 'Test');
  assert.equal(ok.value.year_built, 1950);
  assert.equal(ok.value.levels, 5);

  const bad = sanitizeArchiPayload({ yearBuilt: '3000' });
  assert.match(String(bad.error || ''), /Год постройки/);
});

test('sanitizeFieldText trims and limits length', () => {
  assert.equal(sanitizeFieldText('   '), null);
  assert.equal(sanitizeFieldText(' abc '), 'abc');
  assert.equal(sanitizeFieldText('abcdef', 3), 'abc');
});
