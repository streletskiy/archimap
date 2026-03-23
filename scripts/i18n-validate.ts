#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function flattenKeys(input, prefix = '', output = new Set()) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    if (prefix) output.add(prefix);
    return output;
  }

  for (const [key, value] of Object.entries(input)) {
    const next = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      flattenKeys(value, next, output);
    } else {
      output.add(next);
    }
  }
  return output;
}

const localesDir = path.join(process.cwd(), 'src', 'lib', 'shared', 'i18n', 'locales');
const files = fs.readdirSync(localesDir).filter((file) => file.endsWith('.json')).sort();
if (files.length < 2) {
  console.error('[i18n:validate] At least 2 locale files are required.');
  process.exit(1);
}

const baseFile = files.includes('en.json') ? 'en.json' : files[0];
const baseLocale = readJson(path.join(localesDir, baseFile));
const baseKeys = flattenKeys(baseLocale);

let hasError = false;
for (const file of files) {
  const locale = readJson(path.join(localesDir, file));
  const keys = flattenKeys(locale);

  const missing = [...baseKeys].filter((key) => !keys.has(key));
  const extra = [...keys].filter((key) => !baseKeys.has(key));

  if (missing.length || extra.length) {
    hasError = true;
    console.error(`\n[i18n:validate] ${file}`);
    if (missing.length) {
      console.error(`  Missing keys (${missing.length}):`);
      for (const key of missing) console.error(`    - ${key}`);
    }
    if (extra.length) {
      console.error(`  Extra keys (${extra.length}):`);
      for (const key of extra) console.error(`    + ${key}`);
    }
  }
}

if (hasError) {
  process.exit(1);
}

console.log(`[i18n:validate] OK (${files.length} locales, ${baseKeys.size} keys)`);
