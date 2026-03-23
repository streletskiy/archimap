import en from '$shared/i18n/locales/en.json';

export type TranslationSchema = typeof en;

type Join<K, P> = K extends string ? (P extends string ? `${K}.${P}` : never) : never;

export type DeepKeyOf<T> = T extends Record<string, unknown>
  ? {
      [K in keyof T & string]: T[K] extends Record<string, unknown>
        ? K | Join<K, DeepKeyOf<T[K]>>
        : K;
    }[keyof T & string]
  : never;

export type I18nKey = DeepKeyOf<TranslationSchema>;

export type I18nLocale = 'en' | 'ru';

export type I18nParams = Record<string, string | number | boolean | null | undefined>;
