export const LIGHT_MAP_STYLE_URL = '/styles/positron-custom.json';
export const DARK_MAP_STYLE_URL = '/styles/dark-matter-custom.json';
export const STYLE_OVERLAY_FADE_MS = 260;

export const BUILDING_THEME = Object.freeze({
  light: {
    fillColor: '#dededc',
    fillOpacity: 1,
    lineColor: '#bcbcbc',
    lineWidth: 0.9,
    lineOpacity: 1
  },
  dark: {
    fillColor: '#64748b',
    fillOpacity: 1,
    lineColor: '#94a3b8',
    lineWidth: 1,
    lineOpacity: 1
  }
});

export const BUILDING_HOVER_THEME = Object.freeze({
  light: {
    fillColor: '#c8bcae',
    fillOpacity: 0.3,
    lineColor: '#7d7063',
    lineWidth: 1.2,
    lineOpacity: 0.9
  },
  dark: {
    fillColor: '#7189a4',
    fillOpacity: 0.3,
    lineColor: '#d7e1ea',
    lineWidth: 1.2,
    lineOpacity: 0.9
  }
});

export function getCurrentTheme(doc = document) {
  return doc?.documentElement?.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
}

export function getMapStyleForTheme(theme) {
  return theme === 'dark' ? DARK_MAP_STYLE_URL : LIGHT_MAP_STYLE_URL;
}

export function getBuildingThemePaint(theme) {
  return theme === 'dark' ? BUILDING_THEME.dark : BUILDING_THEME.light;
}

export function getBuildingHoverThemePaint(theme) {
  return theme === 'dark' ? BUILDING_HOVER_THEME.dark : BUILDING_HOVER_THEME.light;
}
