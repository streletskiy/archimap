const ROOF_SHAPE_IMAGE_BASE_PATH = '/images/roof-shapes';

const ROOF_SHAPE_VALUES = Object.freeze([
  {
    value: 'flat',
    label: 'Flat',
    labelKey: 'buildingModal.roofShapes.flat',
    imageUrl: `${ROOF_SHAPE_IMAGE_BASE_PATH}/flat.png`
  },
  {
    value: 'gabled',
    label: 'Gabled',
    labelKey: 'buildingModal.roofShapes.gabled',
    imageUrl: `${ROOF_SHAPE_IMAGE_BASE_PATH}/gabled.png`
  },
  {
    value: 'gabled_height_moved',
    label: 'Gabled height moved',
    labelKey: 'buildingModal.roofShapes.gabled_height_moved',
    imageUrl: `${ROOF_SHAPE_IMAGE_BASE_PATH}/gabled-height-moved.png`
  },
  {
    value: 'skillion',
    label: 'Skillion',
    labelKey: 'buildingModal.roofShapes.skillion',
    imageUrl: `${ROOF_SHAPE_IMAGE_BASE_PATH}/skillion.png`
  },
  {
    value: 'saltbox',
    label: 'Saltbox',
    labelKey: 'buildingModal.roofShapes.saltbox',
    imageUrl: `${ROOF_SHAPE_IMAGE_BASE_PATH}/saltbox.png`
  },
  {
    value: 'hipped',
    label: 'Hipped',
    labelKey: 'buildingModal.roofShapes.hipped',
    imageUrl: `${ROOF_SHAPE_IMAGE_BASE_PATH}/hipped.png`
  },
  {
    value: 'half-hipped',
    label: 'Half-hipped',
    labelKey: 'buildingModal.roofShapes.half-hipped',
    imageUrl: `${ROOF_SHAPE_IMAGE_BASE_PATH}/half-hipped.png`
  },
  {
    value: 'side_hipped',
    label: 'Side-hipped',
    labelKey: 'buildingModal.roofShapes.side_hipped',
    imageUrl: `${ROOF_SHAPE_IMAGE_BASE_PATH}/side-hipped.png`
  },
  {
    value: 'side_half-hipped',
    label: 'Side half-hipped',
    labelKey: 'buildingModal.roofShapes.side_half-hipped',
    imageUrl: `${ROOF_SHAPE_IMAGE_BASE_PATH}/side-half-hipped.png`
  },
  {
    value: 'hipped-and-gabled',
    label: 'Hipped and gabled',
    labelKey: 'buildingModal.roofShapes.hipped-and-gabled',
    imageUrl: `${ROOF_SHAPE_IMAGE_BASE_PATH}/hipped-and-gabled.png`
  },
  {
    value: 'mansard',
    label: 'Mansard',
    labelKey: 'buildingModal.roofShapes.mansard',
    imageUrl: `${ROOF_SHAPE_IMAGE_BASE_PATH}/mansard.png`
  },
  {
    value: 'gambrel',
    label: 'Gambrel',
    labelKey: 'buildingModal.roofShapes.gambrel',
    imageUrl: `${ROOF_SHAPE_IMAGE_BASE_PATH}/gambrel.png`
  },
  {
    value: 'bellcast_gable',
    label: 'Bellcast gable',
    labelKey: 'buildingModal.roofShapes.bellcast_gable',
    imageUrl: `${ROOF_SHAPE_IMAGE_BASE_PATH}/bellcast-gable.jpg`
  },
  {
    value: 'pyramidal',
    label: 'Pyramidal',
    labelKey: 'buildingModal.roofShapes.pyramidal',
    imageUrl: `${ROOF_SHAPE_IMAGE_BASE_PATH}/pyramidal.png`
  },
  {
    value: 'crosspitched',
    label: 'Crosspitched',
    labelKey: 'buildingModal.roofShapes.crosspitched',
    imageUrl: `${ROOF_SHAPE_IMAGE_BASE_PATH}/crosspitched.png`
  },
  {
    value: 'sawtooth',
    label: 'Sawtooth',
    labelKey: 'buildingModal.roofShapes.sawtooth',
    imageUrl: `${ROOF_SHAPE_IMAGE_BASE_PATH}/sawtooth.png`
  },
  {
    value: 'butterfly',
    label: 'Butterfly',
    labelKey: 'buildingModal.roofShapes.butterfly',
    imageUrl: `${ROOF_SHAPE_IMAGE_BASE_PATH}/butterfly.png`
  },
  {
    value: 'cone',
    label: 'Cone',
    labelKey: 'buildingModal.roofShapes.cone',
    imageUrl: `${ROOF_SHAPE_IMAGE_BASE_PATH}/cone.png`
  },
  {
    value: 'dome',
    label: 'Dome',
    labelKey: 'buildingModal.roofShapes.dome',
    imageUrl: `${ROOF_SHAPE_IMAGE_BASE_PATH}/dome.png`
  },
  {
    value: 'onion',
    label: 'Onion',
    labelKey: 'buildingModal.roofShapes.onion',
    imageUrl: `${ROOF_SHAPE_IMAGE_BASE_PATH}/onion.png`
  },
  {
    value: 'round',
    label: 'Round',
    labelKey: 'buildingModal.roofShapes.round',
    imageUrl: `${ROOF_SHAPE_IMAGE_BASE_PATH}/round.png`
  },
  {
    value: 'many',
    label: 'Many',
    labelKey: 'buildingModal.roofShapes.many',
    imageUrl: `${ROOF_SHAPE_IMAGE_BASE_PATH}/many.jpg`
  }
]);

const ROOF_SHAPE_SELECT_EXCLUDED_VALUES = new Set([
  'gabled_height_moved',
  'bellcast_gable',
  'many'
]);

const ROOF_SHAPE_SELECT_VALUES = Object.freeze(
  ROOF_SHAPE_VALUES.filter((item) => !ROOF_SHAPE_SELECT_EXCLUDED_VALUES.has(item.value))
);

const ROOF_SHAPE_VALUES_SET = new Set(ROOF_SHAPE_VALUES.map((item) => item.value));
const ROOF_SHAPE_VALUE_LOOKUP = new Map(ROOF_SHAPE_VALUES.map((item) => [item.value, item]));
const ROOF_SHAPE_NORMALIZED_ALIASES = new Map([
  ['gabledheightmoved', 'gabled_height_moved'],
  ['halfhipped', 'half-hipped'],
  ['sidehipped', 'side_hipped'],
  ['sidehalfhipped', 'side_half-hipped'],
  ['hippedandgabled', 'hipped-and-gabled'],
  ['bellcastgable', 'bellcast_gable']
]);

function normalizeRoofShapeSelection(value) {
  const raw = String(value == null ? '' : value)
    .trim()
    .toLowerCase();
  if (!raw) return '';
  if (ROOF_SHAPE_VALUES_SET.has(raw)) return raw;

  const collapsed = raw.replace(/[^a-z0-9]+/g, '');
  if (ROOF_SHAPE_NORMALIZED_ALIASES.has(raw)) return ROOF_SHAPE_NORMALIZED_ALIASES.get(raw);
  if (ROOF_SHAPE_NORMALIZED_ALIASES.has(collapsed)) return ROOF_SHAPE_NORMALIZED_ALIASES.get(collapsed);

  return raw;
}

function humanizeRoofShapeValue(value) {
  const text = String(value == null ? '' : value)
    .trim()
    .replace(/[_-]+/g, ' ');
  if (!text) return '';
  return text
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

function toHumanRoofShape(value, translate) {
  const normalized = normalizeRoofShapeSelection(value);
  if (!normalized) return '';
  const option = ROOF_SHAPE_VALUE_LOOKUP.get(normalized);
  if (option?.labelKey && typeof translate === 'function') {
    const localized = translate(option.labelKey);
    if (localized && localized !== option.labelKey) return localized;
  }
  return option?.label || humanizeRoofShapeValue(normalized);
}

function getRoofShapeOption(value) {
  const normalized = normalizeRoofShapeSelection(value);
  if (!normalized) return null;
  return ROOF_SHAPE_VALUE_LOOKUP.get(normalized) || null;
}

export {
  ROOF_SHAPE_VALUES as ROOF_SHAPE_OPTIONS,
  ROOF_SHAPE_SELECT_VALUES as ROOF_SHAPE_SELECT_OPTIONS,
  getRoofShapeOption,
  humanizeRoofShapeValue,
  normalizeRoofShapeSelection,
  toHumanRoofShape
};
