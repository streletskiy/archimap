import { get } from 'svelte/store';
import { locale as activeLocale, translateNow } from '$lib/i18n/index';
import en from '$lib/i18n/locales/en.json' with { type: 'json' };
import ru from '$lib/i18n/locales/ru.json' with { type: 'json' };
import { EMPTY_TEXT_TOKENS } from '$lib/utils/text';
import {
  STYLE_ALLOWED_REGION_PATTERNS,
  STYLE_ALLOWED_REGIONS,
  isArchitectureStyleAllowed
} from './architecture-style-regions.js';

export { extractMacroRegionCodeFromSlug } from './architecture-style-regions.js';

const STYLE_KEYS = Object.freeze([
  'islamic',
  'mamluk',
  'romanesque',
  'gothic',
  'renaissance',
  'mannerism',
  'ottoman',
  'baroque',
  'rococo',
  'classicism',
  'neoclassicism',
  'empire',
  'moorish_revival',
  'oldrussian',
  'pseudo-russian',
  'eclectic',
  'georgian',
  'victorian',
  'historicism',
  'neo-romanesque',
  'neo-gothic',
  'pseudo-gothic',
  'russian_gothic',
  'neo-byzantine',
  'neo-renaissance',
  'neo-baroque',
  'art_nouveau',
  'nothern_modern',
  'functionalism',
  'cubism',
  'new_objectivity',
  'art_deco',
  'modern',
  'amsterdam_school',
  'international_style',
  'constructivism',
  'postconstructivism',
  'stalinist_neoclassicism',
  'brutalist',
  'postmodern',
  'contemporary',
  'vernacular',
  'classic_swahili',
  'omani',
  'indian',
  'british_colonial',
  'modernism',
  'hypermodern'
]);

const STYLE_KEY_SET = new Set(STYLE_KEYS);
const EMPTY_STYLE_TOKENS = new Set([...EMPTY_TEXT_TOKENS, 'none', 'unknown']);

const ARCHITECTURE_STYLE_ALIASES = Object.freeze({
  brutalism: 'brutalist',
  classicism: 'neoclassicism',
  'stalinist neoclassicism': 'stalinist_neoclassicism'
});

const STYLE_LABELS = Object.freeze({
  en: en?.architectureStyles || {},
  ru: ru?.architectureStyles || {}
});

function normalizeLocaleCode(value) {
  const text = String(value || '').trim().toLowerCase();
  if (text === 'ru') return 'ru';
  return 'en';
}

function getStyleLabelByLocale(key, localeCode) {
  const dict = STYLE_LABELS[normalizeLocaleCode(localeCode)] || STYLE_LABELS.en;
  return dict[String(key || '').trim()] || STYLE_LABELS.en[String(key || '').trim()] || null;
}

function getActiveLocaleCode() {
  return normalizeLocaleCode(get(activeLocale));
}

function resolveLocaleCode(localeCode) {
  return localeCode ? normalizeLocaleCode(localeCode) : getActiveLocaleCode();
}

function styleLabelKey(styleKey) {
  return `architectureStyles.${styleKey}`;
}

export function toHumanArchitectureStyle(value, localeCode = null) {
  if (value == null) return null;
  const text = String(value).trim();
  if (!text) return null;

  const parts = text
    .split(';')
    .map((x) => x.trim())
    .filter(Boolean);
  if (parts.length === 0) return text;

  const currentLocale = resolveLocaleCode(localeCode);
  const translated = parts.map((part) => {
    const rawKey = part.toLowerCase();
    if (EMPTY_STYLE_TOKENS.has(rawKey)) return null;
    const key = ARCHITECTURE_STYLE_ALIASES[rawKey] || rawKey;
    if (STYLE_KEY_SET.has(key)) {
      return getStyleLabelByLocale(key, currentLocale) || translateNow(styleLabelKey(key)) || part;
    }
    return part;
  }).filter(Boolean);
  return translated.length > 0 ? translated.join('; ') : null;
}

export function normalizeStyleSearchText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/\s+/g, ' ')
    .trim();
}

const ARCHITECTURE_STYLE_KEY_BY_LABEL_NORMALIZED = (() => {
  const map = new Map();
  for (const key of STYLE_KEYS) {
    const labels = [getStyleLabelByLocale(key, 'ru'), getStyleLabelByLocale(key, 'en')].filter(Boolean);
    for (const label of labels) {
      const normalizedLabel = normalizeStyleSearchText(label);
      if (normalizedLabel) map.set(normalizedLabel, key);
    }
  }
  for (const key of STYLE_KEYS) {
    const normalizedKey = normalizeStyleSearchText(String(key).replace(/_/g, ' '));
    if (normalizedKey) map.set(normalizedKey, key);
  }
  for (const [alias, canonical] of Object.entries(ARCHITECTURE_STYLE_ALIASES)) {
    const normalizedAlias = normalizeStyleSearchText(alias.replace(/_/g, ' '));
    if (normalizedAlias) map.set(normalizedAlias, canonical);
  }
  return map;
})();

export function getArchitectureStyleOptions(localeCode = null, regionSlugs = [], overrides = []) {
  const resolvedLocaleCode = resolveLocaleCode(localeCode);
  return STYLE_KEYS
    .filter((styleKey) => isArchitectureStyleAllowed(styleKey, regionSlugs, overrides))
    .map((value) => ({
      value,
      label: getStyleLabelByLocale(value, resolvedLocaleCode) || value
    }))
    .sort((a, b) => a.label.localeCompare(b.label, resolvedLocaleCode));
}

export function getArchitectureStyleDefaultRules(localeCode = null) {
  const resolvedLocaleCode = resolveLocaleCode(localeCode);
  return STYLE_KEYS
    .map((value) => {
      const macroRegions = Array.isArray(STYLE_ALLOWED_REGIONS[value])
        ? [...STYLE_ALLOWED_REGIONS[value]]
        : [];
      const regionPatterns = Array.isArray(STYLE_ALLOWED_REGION_PATTERNS[value])
        ? [...STYLE_ALLOWED_REGION_PATTERNS[value]]
        : [];
      return {
        value,
        label: getStyleLabelByLocale(value, resolvedLocaleCode) || value,
        isGlobal: macroRegions.length === 0 && regionPatterns.length === 0,
        macroRegions,
        regionPatterns
      };
    })
    .sort((a, b) => a.label.localeCompare(b.label, resolvedLocaleCode));
}

export function resolveArchitectureStyleSearchKey(queryText) {
  const raw = String(queryText || '').trim();
  if (!raw) return null;
  const normalizedQuery = normalizeStyleSearchText(raw);
  if (!normalizedQuery) return null;

  if (STYLE_KEY_SET.has(normalizedQuery)) {
    return normalizedQuery;
  }

  if (ARCHITECTURE_STYLE_ALIASES[normalizedQuery]) {
    return ARCHITECTURE_STYLE_ALIASES[normalizedQuery];
  }

  const byLabel = ARCHITECTURE_STYLE_KEY_BY_LABEL_NORMALIZED.get(normalizedQuery);
  if (byLabel) return byLabel;

  return null;
}

export function resolveArchitectureStyleSearchKeys(queryText) {
  const raw = String(queryText || '').trim();
  if (!raw) return [];
  const normalizedQuery = normalizeStyleSearchText(raw);
  if (!normalizedQuery || normalizedQuery.length < 2) return [];

  const matched = new Set();
  for (const key of STYLE_KEYS) {
    const labels = [getStyleLabelByLocale(key, 'ru'), getStyleLabelByLocale(key, 'en')].filter(Boolean);
    const normalizedKey = normalizeStyleSearchText(key.replace(/_/g, ' '));
    if (normalizedKey.includes(normalizedQuery) || normalizedQuery.includes(normalizedKey)) {
      matched.add(key);
      continue;
    }
    for (const label of labels) {
      const normalizedLabel = normalizeStyleSearchText(label);
      if (
        normalizedLabel.includes(normalizedQuery) ||
        normalizedQuery.includes(normalizedLabel)
      ) {
        matched.add(key);
        break;
      }
    }
  }

  for (const [alias, canonical] of Object.entries(ARCHITECTURE_STYLE_ALIASES)) {
    const normalizedAlias = normalizeStyleSearchText(alias.replace(/_/g, ' '));
    if (normalizedAlias.includes(normalizedQuery) || normalizedQuery.includes(normalizedAlias)) {
      matched.add(canonical);
    }
  }

  const exact = resolveArchitectureStyleSearchKey(raw);
  if (exact) matched.add(exact);

  return Array.from(matched);
}

export function normalizeArchitectureStyleKey(value) {
  const text = String(value || '').trim().toLowerCase();
  if (!text) return '';
  if (EMPTY_STYLE_TOKENS.has(text)) return '';
  if (ARCHITECTURE_STYLE_ALIASES[text]) return ARCHITECTURE_STYLE_ALIASES[text];
  const byLabel = ARCHITECTURE_STYLE_KEY_BY_LABEL_NORMALIZED.get(normalizeStyleSearchText(text));
  if (byLabel) return byLabel;
  return text;
}

export function extractArchitectureStyleKeys(value) {
  return String(value || '')
    .split(';')
    .map((part) => normalizeArchitectureStyleKey(part))
    .filter(Boolean);
}

export function filterSearchItemsByStyleKeys(items, styleSearchKeys) {
  const targetKeys = new Set(
    (Array.isArray(styleSearchKeys) ? styleSearchKeys : [])
      .map((key) => normalizeArchitectureStyleKey(key))
      .filter(Boolean)
  );
  if (targetKeys.size === 0) return Array.isArray(items) ? items : [];
  return (Array.isArray(items) ? items : []).filter((item) => {
    const keys = extractArchitectureStyleKeys(item?.style);
    return keys.some((key) => targetKeys.has(key));
  });
}

export function filterSearchItemsByStyleKey(items, styleSearchKey) {
  if (!styleSearchKey) return Array.isArray(items) ? items : [];
  return filterSearchItemsByStyleKeys(items, [styleSearchKey]);
}
