import { derived, get, writable } from 'svelte/store';
import en from '$shared/i18n/locales/en.json' with { type: 'json' };
import ru from '$shared/i18n/locales/ru.json' with { type: 'json' };
import { DEFAULT_LOCALE, I18N_COOKIE_NAME, SUPPORTED_LOCALES, isSupportedLocale } from './config.js';

/** @typedef {import('./types').I18nKey} I18nKey */
/** @typedef {import('./types').I18nParams} I18nParams */

const dictionaries = Object.freeze({ en, ru });

export const locale = writable(DEFAULT_LOCALE);

function pickFromObject(input, dottedKey) {
  const parts = String(dottedKey || '').split('.').filter(Boolean);
  let current = input;
  for (const part of parts) {
    if (!current || typeof current !== 'object' || !(part in current)) {
      return undefined;
    }
    current = current[part];
  }
  return current;
}

function interpolate(text, params: LooseRecord = {}) {
  return String(text).replace(/\{([\w.-]+)\}/g, (_m, key) => {
    const value = params?.[key];
    return value == null ? '' : String(value);
  });
}

function parseCookieValue(cookieString, name) {
  const target = `${name}=`;
  const parts = String(cookieString || '').split(';');
  for (const part of parts) {
    const value = part.trim();
    if (!value.startsWith(target)) continue;
    return decodeURIComponent(value.slice(target.length));
  }
  return null;
}

export function normalizeLocale(value) {
  const text = String(value || '').trim().toLowerCase();
  if (!text) return null;
  if (isSupportedLocale(text)) return text;
  const short = text.split('-')[0];
  return isSupportedLocale(short) ? short : null;
}

export function resolveLocale({
  pathname = '',
  search = '',
  cookie = '',
  acceptLanguage = '',
  navigatorLanguages = []
}: {
  pathname?: string;
  search?: string;
  cookie?: string;
  acceptLanguage?: string;
  navigatorLanguages?: readonly string[];
} = {}) {
  const pathPart = String(pathname || '').split('/').filter(Boolean)[0] || '';
  const fromPath = normalizeLocale(pathPart);
  if (fromPath) return fromPath;

  const params = new URLSearchParams(String(search || '').replace(/^\?/, ''));
  const fromQuery = normalizeLocale(params.get('lang'));
  if (fromQuery) return fromQuery;

  const fromCookie = normalizeLocale(parseCookieValue(cookie, I18N_COOKIE_NAME));
  if (fromCookie) return fromCookie;

  const langs = [];
  if (Array.isArray(navigatorLanguages)) langs.push(...navigatorLanguages);
  if (acceptLanguage) {
    for (const part of String(acceptLanguage).split(',')) {
      langs.push(part.split(';')[0]);
    }
  }
  for (const lang of langs) {
    const normalized = normalizeLocale(lang);
    if (normalized) return normalized;
  }

  return DEFAULT_LOCALE;
}

export function setLocale(nextLocale) {
  const normalized = normalizeLocale(nextLocale) || DEFAULT_LOCALE;
  locale.set(normalized);
  if (typeof document !== 'undefined') {
    document.cookie = `${I18N_COOKIE_NAME}=${encodeURIComponent(normalized)}; Path=/; Max-Age=31536000; SameSite=Lax`;
    document.documentElement.setAttribute('lang', normalized);
  }
}

export function initLocaleFromEnvironment({ pathname, search }: LooseRecord = {}) {
  const next = resolveLocale({
    pathname: pathname || (typeof window !== 'undefined' ? window.location.pathname : ''),
    search: search || (typeof window !== 'undefined' ? window.location.search : ''),
    cookie: typeof document !== 'undefined' ? document.cookie : '',
    acceptLanguage: '',
    navigatorLanguages: typeof navigator !== 'undefined' ? navigator.languages : []
  });
  setLocale(next);
  return next;
}

export function translateNow(key, params: LooseRecord = {}) {
  const currentLocale = get(locale);
  const localized = pickFromObject(dictionaries[currentLocale], key);
  const fallback = pickFromObject(dictionaries[DEFAULT_LOCALE], key);
  const resolved = localized ?? fallback;

  if (resolved == null) {
    const nodeEnv = globalThis?.process?.env?.NODE_ENV;
    const isDev = (typeof import.meta !== 'undefined' && import.meta.env?.DEV) || nodeEnv !== 'production';
    if (isDev) {
      console.warn(`[i18n] Missing key: ${String(key)} for locale=${currentLocale}`);
    }
    return String(key);
  }

  if (typeof resolved !== 'string') {
    return String(resolved);
  }
  return interpolate(resolved, params);
}

export const t = derived(locale, () => {
  return /** @type {(key: I18nKey | string, params?: I18nParams) => string} */ ((key, params = {}) => translateNow(key, params));
});

export const availableLocales = SUPPORTED_LOCALES;
