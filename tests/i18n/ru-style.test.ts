const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

test('legacy public i18n file is removed after Svelte migration', () => {
  const file = path.join(process.cwd(), 'public', 'i18n', 'ru.js');
  assert.equal(fs.existsSync(file), false, 'Legacy public i18n file must not exist');
});
