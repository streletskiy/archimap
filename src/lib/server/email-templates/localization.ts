const sharedEnLocale = require('../../shared/i18n/locales/en.json');
const sharedRuLocale = require('../../shared/i18n/locales/ru.json');

const EMAIL_DEFAULT_LOCALE = 'en';
const EMAIL_SUPPORTED_LOCALES = Object.freeze(['en', 'ru']);
const EMAIL_LOCALE_COOKIE_NAME = 'archimap_locale';
const EMAIL_CATALOG = Object.freeze({
  en: buildEmailCopy(sharedEnLocale?.email || {}),
  ru: buildEmailCopy(sharedRuLocale?.email || {})
});

function interpolateEmailTemplate(template, values: LooseRecord = {}) {
  return String(template || '').replace(/\{([a-zA-Z0-9_]+)\}/g, (match, key) => {
    const value = values[key];
    return value == null ? '' : String(value);
  });
}

function buildEmailCopy(raw: LooseRecord = {}) {
  const registration: LooseRecord = raw.registration || {};
  const passwordReset: LooseRecord = raw.passwordReset || {};
  const smtpTest: LooseRecord = raw.smtpTest || {};

  return Object.freeze({
    registration: Object.freeze({
      ...registration,
      codeValidity: (minutes) => interpolateEmailTemplate(registration.codeValidity, { minutes })
    }),
    passwordReset: Object.freeze({
      ...passwordReset,
      validity: (minutes) => interpolateEmailTemplate(passwordReset.validity, { minutes })
    }),
    smtpTest: Object.freeze({
      ...smtpTest,
      callout: (email) => interpolateEmailTemplate(smtpTest.callout, { email })
    })
  });
}

function normalizeEmailLocale(value) {
  const text = String(value || '').trim().toLowerCase();
  if (!text) return EMAIL_DEFAULT_LOCALE;
  const short = text.split('-')[0];
  return EMAIL_SUPPORTED_LOCALES.includes(short) ? short : EMAIL_DEFAULT_LOCALE;
}

function parseCookieValue(cookieHeader, name = EMAIL_LOCALE_COOKIE_NAME) {
  const target = `${String(name || '').trim()}=`;
  if (!target || !cookieHeader) return '';
  const parts = String(cookieHeader || '').split(';');
  for (const part of parts) {
    const text = String(part || '').trim();
    if (!text.startsWith(target)) continue;
    const value = text.slice(target.length);
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }
  return '';
}

function parseAcceptLanguage(headerValue) {
  const parts = String(headerValue || '').split(',');
  for (const part of parts) {
    const candidate = String(part || '').trim().split(';')[0].trim();
    const normalized = normalizeEmailLocale(candidate);
    if (normalized) return normalized;
  }
  return '';
}

function resolveEmailLocale(input: LooseRecord = {}) {
  const req = input.req && typeof input.req === 'object' ? input.req : null;
  const candidate = input.locale
    || input.bodyLocale
    || req?.body?.locale
    || input.queryLocale
    || req?.query?.lang
    || parseCookieValue(input.cookie || req?.headers?.cookie || req?.headers?.Cookie)
    || parseAcceptLanguage(input.acceptLanguage || req?.headers?.['accept-language'] || req?.headers?.['Accept-Language']);
  return normalizeEmailLocale(candidate);
}

function appendLocaleParam(url, locale) {
  const text = String(url || '').trim();
  if (!text) return '';
  const normalizedLocale = normalizeEmailLocale(locale);

  try {
    const nextUrl = new URL(text);
    nextUrl.searchParams.set('lang', normalizedLocale);
    return nextUrl.toString();
  } catch {
    const [base, hashPart = ''] = text.split('#', 2);
    const [pathPart, queryPart = ''] = base.split('?', 2);
    const params = new URLSearchParams(queryPart);
    params.set('lang', normalizedLocale);
    const query = params.toString();
    return `${pathPart}${query ? `?${query}` : ''}${hashPart ? `#${hashPart}` : ''}`;
  }
}

function getEmailCopy(locale) {
  return EMAIL_CATALOG[normalizeEmailLocale(locale)] || EMAIL_CATALOG[EMAIL_DEFAULT_LOCALE];
}

function formatEmailDate(value, locale) {
  const text = String(value || '').trim();
  if (!text) {
    return getEmailCopy(locale).smtpTest.notProvided;
  }

  const date = new Date(text);
  if (Number.isNaN(date.getTime())) {
    return text;
  }

  try {
    const resolvedLocale = normalizeEmailLocale(locale);
    const localeTag = resolvedLocale === 'ru' ? 'ru-RU' : 'en-US';
    return `${new Intl.DateTimeFormat(localeTag, {
      dateStyle: 'medium',
      timeStyle: 'short',
      timeZone: 'UTC'
    }).format(date)} UTC`;
  } catch {
    return date.toISOString();
  }
}

module.exports = {
  EMAIL_DEFAULT_LOCALE,
  EMAIL_LOCALE_COOKIE_NAME,
  EMAIL_SUPPORTED_LOCALES,
  appendLocaleParam,
  formatEmailDate,
  getEmailCopy,
  normalizeEmailLocale,
  resolveEmailLocale
};
