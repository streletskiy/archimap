import { get } from 'svelte/store';
import { locale as activeLocale } from '../i18n/index.js';
import en from '../i18n/locales/en.json' with { type: 'json' };
import ru from '../i18n/locales/ru.json' with { type: 'json' };
import { EMPTY_TEXT_TOKENS } from './text.js';

const BUILDING_MATERIAL_KEYS = Object.freeze([
  'cement_block',
  'brick',
  'plaster',
  'wood',
  'concrete',
  'metal',
  'steel',
  'stone',
  'glass',
  'mirror',
  'mud',
  'masonry',
  'tin',
  'plastic',
  'timber_framing',
  'sandstone',
  'clay',
  'reed',
  'loam',
  'marble',
  'copper',
  'slate',
  'vinyl',
  'limestone',
  'tiles',
  'pebbledash',
  'metal_plates',
  'bamboo',
  'adobe',
  'rammed_earth',
  'solar_panels',
  'tyres'
]);

const BUILDING_MATERIAL_KEY_SET = new Set(BUILDING_MATERIAL_KEYS);
const EMPTY_BUILDING_MATERIAL_TOKENS = new Set([...EMPTY_TEXT_TOKENS, 'none', 'unknown']);

const BUILDING_MATERIAL_LABELS = Object.freeze({
  en: en?.buildingMaterials || {},
  ru: ru?.buildingMaterials || {}
});

function normalizeLocaleCode(value) {
  const text = String(value || '').trim().toLowerCase();
  if (text === 'ru') return 'ru';
  return 'en';
}

function getActiveLocaleCode() {
  return normalizeLocaleCode(get(activeLocale));
}

function resolveLocaleCode(localeCode) {
  return localeCode ? normalizeLocaleCode(localeCode) : getActiveLocaleCode();
}

function normalizeBuildingMaterialSearchText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const BUILDING_MATERIAL_KEY_BY_LABEL_NORMALIZED = (() => {
  const map = new Map();
  for (const key of BUILDING_MATERIAL_KEYS) {
    const labels = [BUILDING_MATERIAL_LABELS.en[key], BUILDING_MATERIAL_LABELS.ru[key]].filter(Boolean);
    for (const label of labels) {
      const normalizedLabel = normalizeBuildingMaterialSearchText(label);
      if (normalizedLabel) map.set(normalizedLabel, key);
    }
  }
  for (const key of BUILDING_MATERIAL_KEYS) {
    const normalizedKey = normalizeBuildingMaterialSearchText(key);
    if (normalizedKey) map.set(normalizedKey, key);
  }
  return map;
})();

function getBuildingMaterialLabelByLocale(key, localeCode) {
  const dict = BUILDING_MATERIAL_LABELS[normalizeLocaleCode(localeCode)] || BUILDING_MATERIAL_LABELS.en;
  return dict[String(key || '').trim()] || BUILDING_MATERIAL_LABELS.en[String(key || '').trim()] || null;
}

export function normalizeBuildingMaterialKey(value) {
  const text = String(value || '').trim().toLowerCase();
  if (!text) return '';
  if (EMPTY_BUILDING_MATERIAL_TOKENS.has(text)) return '';

  const normalizedText = normalizeBuildingMaterialSearchText(text);
  if (!normalizedText) return '';
  const normalizedKey = normalizedText.replace(/\s+/g, '_');
  if (BUILDING_MATERIAL_KEY_SET.has(normalizedKey)) return normalizedKey;

  const byLabel = BUILDING_MATERIAL_KEY_BY_LABEL_NORMALIZED.get(normalizedText);
  if (byLabel) return byLabel;

  return normalizedKey;
}

export function getBuildingMaterialOptions(localeCode = null) {
  const resolvedLocaleCode = resolveLocaleCode(localeCode);
  return BUILDING_MATERIAL_KEYS
    .map((value) => ({
      value,
      label: getBuildingMaterialLabelByLocale(value, resolvedLocaleCode) || value
    }))
    .sort((a, b) => a.label.localeCompare(b.label, resolvedLocaleCode));
}

export function toHumanBuildingMaterial(value, localeCode = null) {
  if (value == null) return null;
  const text = String(value).trim();
  if (!text) return null;

  const parts = text
    .split(';')
    .map((item) => String(item || '').trim())
    .filter(Boolean);
  if (parts.length === 0) return text;

  const resolvedLocaleCode = resolveLocaleCode(localeCode);
  const translated = parts.map((part) => {
    const normalized = normalizeBuildingMaterialKey(part);
    if (!normalized) return null;
    if (BUILDING_MATERIAL_KEY_SET.has(normalized)) {
      return getBuildingMaterialLabelByLocale(normalized, resolvedLocaleCode) || part;
    }
    return part;
  }).filter(Boolean);

  return translated.length > 0 ? translated.join('; ') : null;
}
