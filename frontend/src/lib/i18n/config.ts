export const I18N_COOKIE_NAME = 'archimap_locale';
export const DEFAULT_LOCALE = 'en';
export const SUPPORTED_LOCALES = ['en', 'ru'];

export function isSupportedLocale(value) {
  return SUPPORTED_LOCALES.includes(String(value || '').toLowerCase());
}
