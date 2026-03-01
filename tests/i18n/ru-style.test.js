const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

test('ru i18n file should not contain legacy leading-comma object keys', () => {
  const file = path.join(process.cwd(), 'public', 'i18n', 'ru.js');
  const src = fs.readFileSync(file, 'utf8');
  const badLines = src
    .split(/\r?\n/)
    .filter((line) => /^\s*,\s*[A-Za-z0-9_]+\s*:/.test(line));
  assert.equal(badLines.length, 0, 'Found legacy i18n key style with leading commas');
});
