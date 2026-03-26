const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeUserEditStatus,
  sanitizeFieldText,
  sanitizeYearBuilt,
  sanitizeLevels,
  sanitizeArchiPayload
} = require('../../src/lib/server/services/edits.service');

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
  const ok = sanitizeArchiPayload({
    name: '  Test  ',
    yearBuilt: '1950',
    levels: '5',
    colour: '  Ivory  ',
    design: ' typical ',
    designRef: '  1-447С-43  ',
    designYear: '1972'
  });
  assert.equal(ok.error, undefined);
  assert.equal(ok.value.name, 'Test');
  assert.equal(ok.value.year_built, 1950);
  assert.equal(ok.value.levels, 5);
  assert.equal(ok.value.colour, 'Ivory');
  assert.equal(ok.value.design, 'typical');
  assert.equal(ok.value.design_ref, '1-447С-43');
  assert.equal(ok.value.design_year, 1972);

  const colorAlias = sanitizeArchiPayload({ yearBuilt: '1950', levels: '5', color: '  Beige  ' });
  assert.equal(colorAlias.error, undefined);
  assert.equal(colorAlias.value.colour, 'Beige');

  const bad = sanitizeArchiPayload({ yearBuilt: '3000' });
  assert.match(String(bad.error || ''), /Year built/i);

  const badDesignYear = sanitizeArchiPayload({ designYear: '999' });
  assert.equal(badDesignYear.code, 'ERR_INVALID_DESIGN_YEAR');
});

test('sanitizeFieldText trims and limits length', () => {
  assert.equal(sanitizeFieldText('   '), null);
  assert.equal(sanitizeFieldText(' abc '), 'abc');
  assert.equal(sanitizeFieldText('abcdef', 3), 'abc');
});
