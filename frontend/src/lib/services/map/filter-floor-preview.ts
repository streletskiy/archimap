import { buildRegionBuildingLayerFilterExpression } from './building-3d-stack';

function floorRuleExpression(rule) {
  if (!['building:levels', 'levels'].includes(rule.key)) return null;
  const value = ['coalesce', ['get', 'filter_levels'], ''];
  const exists = ['!=', value, ''];
  const expected = String(rule.valueNormalized ?? rule.value ?? '')
    .trim()
    .toLowerCase();
  if (rule.op === 'exists') return exists;
  if (rule.op === 'not_exists') return ['!', exists];
  const numericOperators = { greater_than: '>', greater_or_equals: '>=', less_than: '<', less_or_equals: '<=' };
  if (numericOperators[rule.op]) {
    const number = Number(rule.numericValue ?? rule.value);
    if (!Number.isFinite(number)) return null;
    return [
      'all',
      ['==', ['typeof', ['get', 'filter_levels_num']], 'number'],
      [numericOperators[rule.op], ['to-number', ['get', 'filter_levels_num'], 0], number]
    ];
  }
  // Empty values in historical OSM tags are ambiguous; let the API resolve them.
  if (!expected) return null;
  if (rule.op === 'equals') return ['==', value, expected];
  if (rule.op === 'not_equals') return ['all', exists, ['!=', value, expected]];
  if (rule.op === 'contains') return ['in', expected, value];
  if (rule.op === 'starts_with') return ['==', ['slice', value, 0, expected.length], expected];
  return null;
}

export function buildFloorPreviewExpressions(prepared) {
  const specs = Array.isArray(prepared?.requestSpecs) ? prepared.requestSpecs : [];
  if (specs.length === 0) return null;
  const predicates = new Map();
  for (const spec of specs) {
    const expressions = spec.rules.map(floorRuleExpression);
    if (expressions.length === 0 || expressions.some((expression) => !expression)) return null;
    predicates.set(spec.id, ['all', ...expressions]);
  }
  const groups = specs
    .filter((spec) => spec.kind === 'layer')
    .map((spec) => ({
      priority: spec.priority,
      color: spec.color,
      predicate: predicates.get(spec.id)
    }));
  if (prepared.combinedGroup) {
    const and = specs.filter((spec) => spec.kind === 'combined-and').map((spec) => predicates.get(spec.id));
    const or = specs.filter((spec) => spec.kind === 'combined-or').map((spec) => predicates.get(spec.id));
    groups.unshift({ ...prepared.combinedGroup, predicate: ['all', ...and, ...(or.length ? [['any', ...or]] : [])] });
  }
  groups.sort((a, b) => a.priority - b.priority);
  if (groups.length === 0) return null;
  return {
    filter: ['all', ['==', ['get', 'filter_schema'], 1], ['any', ...groups.map((group) => group.predicate)]],
    color: ['case', ...groups.flatMap((group) => [group.predicate, group.color]), 'transparent']
  };
}

export function applyFloorPreview({ map, layerIds, prepared, buildingPartsVisible = true }) {
  const expressions = buildFloorPreviewExpressions(prepared);
  if (!map || !expressions) return false;
  let applied = false;
  for (const part of [false, true]) {
    const prefix = part ? 'buildingPartFilterHighlight' : 'filterHighlight';
    const kind = buildRegionBuildingLayerFilterExpression({
      featureKind: part ? 'building_part' : 'building',
      active: false,
      hideBaseWhenParts: !part && buildingPartsVisible
    });
    for (const [suffix, property, opacity] of [
      ['FillLayerIds', 'fill-color', 'fill-opacity'],
      ['LineLayerIds', 'line-color', 'line-opacity'],
      ['ExtrusionLayerIds', 'fill-extrusion-color', 'fill-extrusion-opacity']
    ]) {
      for (const id of layerIds[`${prefix}${suffix}`] || []) {
        if (!map.getLayer?.(id)) continue;
        map.setFilter(id, ['all', expressions.filter, kind]);
        map.setPaintProperty(id, property, expressions.color);
        map.setPaintProperty(id, opacity, 1);
        if (property === 'line-color') map.setPaintProperty(id, 'line-width', 1.8);
        applied = true;
      }
    }
  }
  return applied;
}
