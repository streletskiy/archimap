import { getMapStyleSignature, resolveMapStyleForTheme } from './map-theme-utils.js';

type MapStyleTarget = {
  setStyle?: (style: unknown) => void;
} | null | undefined;
type RuntimeConfigLike = Parameters<typeof getMapStyleSignature>[1];

type MapStyleSyncControllerOptions = {
  getMap?: () => MapStyleTarget;
  getTheme?: () => unknown;
  getLocaleCode?: () => unknown;
  getRuntimeConfig?: () => RuntimeConfigLike | undefined;
  buildStyleSignature?: (theme: string, runtimeConfig: RuntimeConfigLike | undefined, localeCode: string) => string;
  resolveStyle?: (theme: string, runtimeConfig: RuntimeConfigLike | undefined, localeCode: string) => Promise<unknown>;
};

export function createMapStyleSyncController({
  getMap,
  getTheme,
  getLocaleCode,
  getRuntimeConfig,
  buildStyleSignature = (theme, runtimeConfig, localeCode) => getMapStyleSignature(theme, runtimeConfig, localeCode),
  resolveStyle = (theme, runtimeConfig, localeCode) => resolveMapStyleForTheme(theme, { runtimeConfig, localeCode })
}: MapStyleSyncControllerOptions = {}) {
  let currentStyleSignature = '';
  let styleRequestSeq = 0;

  function getThemeValue() {
    return String(getTheme?.() || 'light');
  }

  function getLocaleValue() {
    return String(getLocaleCode?.() || 'en');
  }

  function getRuntimeConfigValue(runtimeConfig = getRuntimeConfig?.()) {
    return runtimeConfig;
  }

  function getStyleSignature(runtimeConfig = getRuntimeConfigValue()) {
    return buildStyleSignature(getThemeValue(), getRuntimeConfigValue(runtimeConfig), getLocaleValue());
  }

  async function resolveStyleForCurrentState(runtimeConfig = getRuntimeConfigValue()) {
    return resolveStyle(getThemeValue(), getRuntimeConfigValue(runtimeConfig), getLocaleValue());
  }

  async function resolveInitialStyle(runtimeConfig = getRuntimeConfigValue()) {
    currentStyleSignature = getStyleSignature(runtimeConfig);
    return resolveStyleForCurrentState(runtimeConfig);
  }

  async function syncMapStyle(runtimeConfig = getRuntimeConfigValue()) {
    const map = getMap?.();
    if (!map?.setStyle) return;

    const nextStyleSignature = getStyleSignature(runtimeConfig);
    if (nextStyleSignature === currentStyleSignature) return;

    const requestSeq = ++styleRequestSeq;
    const nextStyle = await resolveStyleForCurrentState(runtimeConfig);
    const currentMap = getMap?.();
    if (!currentMap?.setStyle || currentMap !== map || requestSeq !== styleRequestSeq) return;

    currentStyleSignature = nextStyleSignature;
    currentMap.setStyle(nextStyle);
  }

  function reset() {
    styleRequestSeq += 1;
    currentStyleSignature = '';
  }

  return {
    getStyleSignature,
    resolveInitialStyle,
    syncMapStyle,
    reset
  };
}
