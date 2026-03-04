#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const ROOT = path.join(process.cwd(), 'frontend', 'src');
const keySet = new Set();

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full);
      continue;
    }
    if (!/\.(svelte|js|ts)$/.test(entry.name)) continue;
    const text = fs.readFileSync(full, 'utf8');

    const patterns = [
      /\$t\('([^']+)'/g,
      /\$t\("([^"]+)"/g,
      /translateNow\('([^']+)'/g,
      /translateNow\("([^"]+)"/g
    ];

    for (const re of patterns) {
      let match;
      while ((match = re.exec(text))) {
        keySet.add(match[1]);
      }
    }
  }
}

walk(ROOT);
const keys = [...keySet].sort();
console.log(`[i18n:extract] ${keys.length} keys found`);
for (const key of keys) console.log(key);
