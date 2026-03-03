#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { parse } = require('svelte/compiler');

const ROOT = path.join(process.cwd(), 'frontend', 'src');
const TARGET_EXT = new Set(['.svelte', '.jsx', '.tsx']);
const IGNORE_DIRS = new Set(['.svelte-kit', 'build', 'node_modules']);
const TEXT_ATTRS = new Set(['placeholder', 'title', 'alt', 'aria-label', 'label']);

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (IGNORE_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (TARGET_EXT.has(path.extname(entry.name))) out.push(full);
  }
  return out;
}

function hasLetters(text) {
  return /[A-Za-zА-Яа-я]/.test(text);
}

function isMeaningful(text) {
  const raw = String(text || '').replace(/\s+/g, ' ').trim();
  if (!raw) return false;
  if (!hasLetters(raw)) return false;
  if (/^[\d\W_]+$/.test(raw)) return false;
  return true;
}

function analyzeSvelte(file) {
  const rel = path.relative(process.cwd(), file).replace(/\\/g, '/');
  const src = fs.readFileSync(file, 'utf8');
  const ast = parse(src);
  const violations = [];

  function add(line, reason) {
    violations.push({ file: rel, line, reason });
  }

  function walkNode(node) {
    if (!node || typeof node !== 'object') return;

    if (node.type === 'Text') {
      const text = String(node.data || '');
      if (isMeaningful(text)) {
        const line = Number(node?.start && src.slice(0, node.start).split(/\r?\n/).length) || 1;
        add(line, `text node: "${text.trim()}"`);
      }
    }

    if (node.type === 'RegularElement' || node.type === 'SvelteElement') {
      for (const attr of node.attributes || []) {
        if (attr.type !== 'Attribute') continue;
        if (!TEXT_ATTRS.has(String(attr.name || ''))) continue;
        if (!Array.isArray(attr.value) || attr.value.length !== 1) continue;
        const first = attr.value[0];
        if (first.type !== 'Text') continue;
        const value = String(first.data || '').trim();
        if (!isMeaningful(value)) continue;
        const line = Number(attr?.start && src.slice(0, attr.start).split(/\r?\n/).length) || 1;
        add(line, `${attr.name}="${value}"`);
      }
    }

    for (const key of Object.keys(node)) {
      const value = node[key];
      if (!value) continue;
      if (Array.isArray(value)) value.forEach(walkNode);
      else if (typeof value === 'object' && value.type) walkNode(value);
    }
  }

  walkNode(ast.fragment);
  return violations;
}

function analyzeJsx(file) {
  const rel = path.relative(process.cwd(), file).replace(/\\/g, '/');
  const src = fs.readFileSync(file, 'utf8');
  const violations = [];

  const textRegex = />([^<{][^<{]*?)</g;
  let textMatch;
  while ((textMatch = textRegex.exec(src))) {
    const text = String(textMatch[1] || '').trim();
    if (!isMeaningful(text)) continue;
    const line = src.slice(0, textMatch.index).split(/\r?\n/).length;
    violations.push({ file: rel, line, reason: `text node: "${text}"` });
  }

  const attrRegex = /(placeholder|title|alt|aria-label|label)\s*=\s*"([^"]+)"/g;
  let attrMatch;
  while ((attrMatch = attrRegex.exec(src))) {
    const value = String(attrMatch[2] || '').trim();
    if (!isMeaningful(value)) continue;
    const line = src.slice(0, attrMatch.index).split(/\r?\n/).length;
    violations.push({ file: rel, line, reason: `${attrMatch[1]}="${value}"` });
  }

  return violations;
}

function analyzeFile(file) {
  const ext = path.extname(file);
  if (ext === '.svelte') return analyzeSvelte(file);
  return analyzeJsx(file);
}

const files = walk(ROOT);
const violations = files.flatMap(analyzeFile);

if (violations.length > 0) {
  console.error(`[i18n:check] Found ${violations.length} hardcoded UI strings:`);
  for (const item of violations.slice(0, 200)) {
    console.error(`  - ${item.file}:${item.line} ${item.reason}`);
  }
  if (violations.length > 200) {
    console.error(`  ... and ${violations.length - 200} more`);
  }
  process.exit(1);
}

console.log('[i18n:check] OK');
