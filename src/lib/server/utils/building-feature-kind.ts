const FEATURE_KIND_BUILDING = 'building';
const FEATURE_KIND_BUILDING_PART = 'building_part';

function normalizeFeatureKind(value) {
  const kind = String(value || '').trim().toLowerCase();
  return kind === FEATURE_KIND_BUILDING_PART ? FEATURE_KIND_BUILDING_PART : FEATURE_KIND_BUILDING;
}

function parseTagsJson(rawTagsJson) {
  if (rawTagsJson == null) return {};
  const text = String(rawTagsJson || '').trim();
  if (!text) return {};
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function getFeatureKindFromTags(tags: LooseRecord = {}) {
  if (tags && typeof tags === 'object' && !Array.isArray(tags) && Object.prototype.hasOwnProperty.call(tags, 'building')) {
    return FEATURE_KIND_BUILDING;
  }
  const hasBuildingPartTag = tags
    && typeof tags === 'object'
    && !Array.isArray(tags)
    && (Object.prototype.hasOwnProperty.call(tags, 'building:part')
      || Object.prototype.hasOwnProperty.call(tags, 'building_part'));
  if (hasBuildingPartTag) {
    return FEATURE_KIND_BUILDING_PART;
  }
  return FEATURE_KIND_BUILDING;
}

function getFeatureKindFromTagsJson(rawTagsJson) {
  return getFeatureKindFromTags(parseTagsJson(rawTagsJson));
}

function isBuildingPartFeatureKind(value) {
  return normalizeFeatureKind(value) === FEATURE_KIND_BUILDING_PART;
}

module.exports = {
  FEATURE_KIND_BUILDING,
  FEATURE_KIND_BUILDING_PART,
  getFeatureKindFromTags,
  getFeatureKindFromTagsJson,
  isBuildingPartFeatureKind,
  normalizeFeatureKind,
  parseTagsJson
};
