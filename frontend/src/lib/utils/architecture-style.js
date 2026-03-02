const ARCHITECTURE_STYLE_LABELS_RU = Object.freeze({
  islamic: 'Исламская архитектура',
  mamluk: 'Мамлюкская архитектура',
  romanesque: 'Романская архитектура',
  gothic: 'Готическая архитектура',
  renaissance: 'Архитектура Возрождения',
  mannerism: 'Маньеризм',
  ottoman: 'Османская архитектура',
  baroque: 'Архитектура барокко',
  rococo: 'Рококо',
  classicism: 'Классицизм',
  neoclassicism: 'Классицизм',
  empire: 'Ампир',
  moorish_revival: 'Неомавританский стиль',
  'pseudo-russian': 'Псевдорусский стиль',
  eclectic: 'Эклектика',
  georgian: 'Георгианская архитектура',
  victorian: 'Викторианская архитектура',
  historicism: 'Историцизм',
  'neo-romanesque': 'Неороманский стиль',
  'neo-gothic': 'Неоготика',
  'pseudo-gothic': 'Русская псевдоготика',
  russian_gothic: 'Русская псевдоготика',
  'neo-byzantine': 'Неовизантийский стиль',
  'neo-renaissance': 'Неоренессанс',
  'neo-baroque': 'Необарокко',
  art_nouveau: 'Архитектура модерна',
  nothern_modern: 'Северный модерн',
  functionalism: 'Функционализм',
  cubism: 'Кубизм',
  new_objectivity: 'Новая вещественность',
  art_deco: 'Ар-деко',
  modern: 'Архитектурный модернизм',
  amsterdam_school: 'Амстердамская школа',
  international_style: 'Интернациональный стиль',
  constructivism: 'Конструктивизм',
  postconstructivism: 'Постконструктивизм',
  stalinist_neoclassicism: 'Сталинский ампир',
  brutalist: 'Брутализм',
  postmodern: 'Архитектура постмодернизма',
  contemporary: 'Современная архитектура',
  vernacular: 'Народная архитектура',
  classic_swahili: 'Классический суахили',
  omani: 'Оманская архитектура (Занзибар)',
  indian: 'Индийское влияние (Занзибар)',
  british_colonial: 'Британская колониальная архитектура',
  modernism: 'Модернизм',
  hypermodern: 'Гипермодернизм'
});

const ARCHITECTURE_STYLE_ALIASES = Object.freeze({
  brutalism: 'brutalist',
  classicism: 'neoclassicism',
  'stalinist neoclassicism': 'stalinist_neoclassicism'
});

export function toHumanArchitectureStyle(value) {
  if (value == null) return null;
  const text = String(value).trim();
  if (!text) return null;

  const parts = text
    .split(';')
    .map((x) => x.trim())
    .filter(Boolean);
  if (parts.length === 0) return text;

  const translated = parts.map((part) => {
    const rawKey = part.toLowerCase();
    const key = ARCHITECTURE_STYLE_ALIASES[rawKey] || rawKey;
    return ARCHITECTURE_STYLE_LABELS_RU[key] || part;
  });
  return translated.join('; ');
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
  for (const [key, label] of Object.entries(ARCHITECTURE_STYLE_LABELS_RU)) {
    const normalizedLabel = normalizeStyleSearchText(label);
    if (normalizedLabel) map.set(normalizedLabel, key);
  }
  return map;
})();

export const ARCHITECTURE_STYLE_OPTIONS_RU = Object.freeze(
  Object.entries(ARCHITECTURE_STYLE_LABELS_RU)
    .map(([value, label]) => ({ value, label }))
    .sort((a, b) => a.label.localeCompare(b.label, 'ru'))
);

export function resolveArchitectureStyleSearchKey(queryText) {
  const raw = String(queryText || '').trim();
  if (!raw) return null;
  const normalizedQuery = normalizeStyleSearchText(raw);
  if (!normalizedQuery) return null;

  if (ARCHITECTURE_STYLE_LABELS_RU[normalizedQuery]) {
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
  for (const [key, label] of Object.entries(ARCHITECTURE_STYLE_LABELS_RU)) {
    const normalizedLabel = normalizeStyleSearchText(label);
    const normalizedKey = normalizeStyleSearchText(key.replace(/_/g, ' '));
    if (
      normalizedLabel.includes(normalizedQuery) ||
      normalizedQuery.includes(normalizedLabel) ||
      normalizedKey.includes(normalizedQuery)
    ) {
      matched.add(key);
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
