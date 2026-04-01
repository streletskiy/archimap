export const BUILDING_RENDER_HEIGHT_PROPERTY = 'render_height_m';
export const BUILDING_RENDER_MIN_HEIGHT_PROPERTY = 'render_min_height_m';
export const BUILDING_HIDE_BASE_WHEN_PARTS_PROPERTY = 'render_hide_base_when_parts';
export const DEFAULT_BUILDING_LEVEL_HEIGHT_METERS = 3.2;
export const DEFAULT_BUILDING_EXTRUSION_LEVELS = 1;
export const DEFAULT_MAP_3D_PITCH = 60;

function roundMeterValue(value: unknown) {
  const normalized = Number(value);
  if (!Number.isFinite(normalized)) return 0;
  return Math.round(Math.max(0, normalized) * 100) / 100;
}

function parseTagNumber(value: unknown) {
  if (value == null) return null;
  const text = String(value).trim();
  if (!text) return null;
  const normalized = text.replace(',', '.');
  const match = normalized.match(/-?\d+(?:\.\d+)?/);
  if (!match) return null;
  const parsed = Number(match[0]);
  return Number.isFinite(parsed) ? parsed : null;
}

function readFirstNumericTag(tags: Record<string, unknown>, keys: string[] = []) {
  for (const key of Array.isArray(keys) ? keys : []) {
    if (!Object.prototype.hasOwnProperty.call(tags || {}, key)) continue;
    const value = parseTagNumber(tags?.[key]);
    if (Number.isFinite(value)) {
      return value;
    }
  }
  return null;
}

function formatDerivedLevels(value: unknown) {
  if (value == null) return null;
  const normalized = Number(value);
  if (!Number.isFinite(normalized)) return null;
  const rounded = Math.round(normalized);
  if (!Number.isInteger(rounded) || rounded < 0 || rounded > 300) return null;
  return String(rounded);
}

function deriveLevelsFromHeightSpan(heightSpanMeters: unknown) {
  const normalizedSpan = Number(heightSpanMeters);
  if (!(normalizedSpan > 0)) return null;
  return formatDerivedLevels(Math.max(1, Math.round(normalizedSpan / DEFAULT_BUILDING_LEVEL_HEIGHT_METERS)));
}

export function deriveBuildingLevelsText({
  tags = {},
  renderHeightMeters = null,
  renderMinHeightMeters = null
}: {
  tags?: Record<string, unknown> | null | undefined;
  renderHeightMeters?: unknown;
  renderMinHeightMeters?: unknown;
} = {}) {
  const normalizedTags = tags && typeof tags === 'object' && !Array.isArray(tags) ? tags : {};
  const levels = readFirstNumericTag(normalizedTags, ['building:levels', 'levels']);
  const normalizedLevels = formatDerivedLevels(levels);
  if (normalizedLevels) return normalizedLevels;

  const explicitHeight = readFirstNumericTag(normalizedTags, ['building:height', 'height']);
  const minLevel = readFirstNumericTag(normalizedTags, ['building:min_level', 'min_level']);
  const explicitMinHeight = readFirstNumericTag(normalizedTags, ['building:min_height', 'min_height']);
  const normalizedMinLevel = Number.isFinite(minLevel) && minLevel > 0 ? minLevel : 0;
  const normalizedExplicitMinHeight = Number.isFinite(explicitMinHeight) && explicitMinHeight > 0 ? explicitMinHeight : 0;
  const explicitBaseHeight = Math.max(
    normalizedExplicitMinHeight,
    normalizedMinLevel * DEFAULT_BUILDING_LEVEL_HEIGHT_METERS
  );
  if (Number.isFinite(explicitHeight) && explicitHeight > explicitBaseHeight) {
    return deriveLevelsFromHeightSpan(explicitHeight - explicitBaseHeight);
  }

  const normalizedRenderHeight = Number(renderHeightMeters);
  const normalizedRenderMinHeight = Number(renderMinHeightMeters);
  if (
    Number.isFinite(normalizedRenderHeight)
    && Number.isFinite(normalizedRenderMinHeight)
    && normalizedRenderHeight > normalizedRenderMinHeight
    && (normalizedRenderMinHeight > 0 || normalizedRenderHeight > (DEFAULT_BUILDING_LEVEL_HEIGHT_METERS + 0.01))
  ) {
    return deriveLevelsFromHeightSpan(normalizedRenderHeight - normalizedRenderMinHeight);
  }

  return null;
}

export function buildBuilding3dPropertiesFromTags(tags: Record<string, unknown> | null | undefined = {}) {
  const normalizedTags = tags && typeof tags === 'object' && !Array.isArray(tags) ? tags : {};
  const levels = readFirstNumericTag(normalizedTags, ['building:levels', 'levels']);
  const explicitHeight = readFirstNumericTag(normalizedTags, ['building:height', 'height']);
  const minLevel = readFirstNumericTag(normalizedTags, ['building:min_level', 'min_level']);
  const explicitMinHeight = readFirstNumericTag(normalizedTags, ['building:min_height', 'min_height']);
  const normalizedLevels = Number.isFinite(levels) && levels > 0 ? levels : DEFAULT_BUILDING_EXTRUSION_LEVELS;
  const normalizedExplicitHeight = Number.isFinite(explicitHeight) && explicitHeight > 0 ? explicitHeight : null;
  const normalizedMinLevel = Number.isFinite(minLevel) && minLevel > 0 ? minLevel : 0;
  const normalizedExplicitMinHeight = Number.isFinite(explicitMinHeight) && explicitMinHeight > 0
    ? explicitMinHeight
    : 0;
  const levelDerivedMinHeight = normalizedMinLevel * DEFAULT_BUILDING_LEVEL_HEIGHT_METERS;
  const renderMinHeightMeters = Math.max(normalizedExplicitMinHeight, levelDerivedMinHeight);
  const levelDerivedHeightMeters = renderMinHeightMeters + (normalizedLevels * DEFAULT_BUILDING_LEVEL_HEIGHT_METERS);
  const renderHeightMeters = normalizedExplicitHeight != null && normalizedExplicitHeight > renderMinHeightMeters
    ? normalizedExplicitHeight
    : levelDerivedHeightMeters;

  return {
    [BUILDING_RENDER_HEIGHT_PROPERTY]: roundMeterValue(renderHeightMeters),
    [BUILDING_RENDER_MIN_HEIGHT_PROPERTY]: roundMeterValue(renderMinHeightMeters)
  };
}

export function getEffectiveBuildingPartsVisibility({
  buildingPartsVisible = false,
  buildings3dEnabled = false
}: {
  buildingPartsVisible?: boolean | null | undefined;
  buildings3dEnabled?: boolean | null | undefined;
} = {}) {
  return Boolean(buildingPartsVisible || buildings3dEnabled);
}

export function buildBuildingExtrusionHeightExpression() {
  return ['coalesce', ['to-number', ['get', BUILDING_RENDER_HEIGHT_PROPERTY]], 0];
}

export function buildBuildingExtrusionBaseExpression() {
  return ['coalesce', ['to-number', ['get', BUILDING_RENDER_MIN_HEIGHT_PROPERTY]], 0];
}
