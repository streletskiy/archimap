import { derived, writable } from 'svelte/store';
import {
  FILTER_LAYER_BASE_COLOR,
  FILTER_LAYER_COLOR_PALETTE
} from '$lib/constants/filter-presets';
import {
  createFilterLayerId,
  flattenFilterLayers,
  normalizeFilterColor,
  normalizeFilterLayerMode,
  normalizeFilterLayers,
  normalizeFilterRules
} from '$lib/components/map/filter-pipeline-utils';

const FILTER_RULE_FALLBACK_OP = 'contains';

export const buildingFilterLayers = writable([]);
export const buildingFilterRules = derived(buildingFilterLayers, ($buildingFilterLayers) => flattenFilterLayers($buildingFilterLayers));
export const buildingFilterRuntime = writable({
  phase: 'idle',
  statusCode: 'idle',
  message: '',
  count: 0,
  elapsedMs: 0,
  cacheHit: false,
  setPaintPropertyCalls: 0,
  updatedAt: 0
});

let filterDraftRuleSeq = 0;

export function createBuildingFilterRuleDraft(rule: LooseRecord = {}) {
  filterDraftRuleSeq += 1;
  return {
    id: String(rule.id || `filter-rule-${Date.now()}-${filterDraftRuleSeq}`),
    key: String(rule.key || '').trim(),
    op: String(rule.op || FILTER_RULE_FALLBACK_OP).trim(),
    value: String(rule.value || '').trim()
  };
}

export function getNextBuildingFilterLayerColor(layers: LooseRecord[] = []) {
  const normalizedLayers = Array.isArray(layers) ? layers : [];
  if (normalizedLayers.length === 0) return FILTER_LAYER_BASE_COLOR;
  const usedColors = new Set(normalizedLayers.map((layer) => normalizeFilterColor(layer?.color, '')));
  for (const color of FILTER_LAYER_COLOR_PALETTE) {
    if (!usedColors.has(color)) return color;
  }
  const paletteIndex = (normalizedLayers.length - 1) % FILTER_LAYER_COLOR_PALETTE.length;
  return FILTER_LAYER_COLOR_PALETTE[paletteIndex] || FILTER_LAYER_BASE_COLOR;
}

export function createBuildingFilterLayerDraft(layer: LooseRecord = {}, layers: LooseRecord[] = []) {
  return {
    id: String(layer.id || createFilterLayerId()),
    color: normalizeFilterColor(layer.color, getNextBuildingFilterLayerColor(layers)),
    priority: Number.isFinite(Number(layer.priority)) ? Number(layer.priority) : normalizedPriorityFromLayers(layers),
    mode: normalizeFilterLayerMode(layer.mode),
    rules: createBuildingFilterRuleDraftList(layer.rules)
  };
}

function createBuildingFilterRuleDraftList(rules) {
  const rawRules = Array.isArray(rules) ? rules : [];
  if (rawRules.length === 0) {
    return [createBuildingFilterRuleDraft()];
  }
  return rawRules.map((rule) => createBuildingFilterRuleDraft(rule));
}

function normalizedPriorityFromLayers(layers) {
  return Array.isArray(layers) ? layers.length : 0;
}

export function createBuildingFilterLayersFromPreset(preset) {
  const presetIdentity = String(preset?.key || preset?.id || 'filter');
  const layers = Array.isArray(preset?.layers)
    ? preset.layers.map((layer, index) => ({
      ...layer,
      id: createFilterLayerId(`preset-${presetIdentity}`),
      priority: index
    }))
    : [];
  return normalizeFilterLayers(layers).layers;
}

export function setBuildingFilterLayers(layers) {
  const normalized = normalizeFilterLayers(layers);
  buildingFilterLayers.set(normalized.invalidReason ? [] : normalized.layers);
}

export function resetBuildingFilterLayers() {
  buildingFilterLayers.set([]);
}

export function setBuildingFilterRules(rules) {
  const normalized = normalizeFilterRules(rules);
  if (normalized.invalidReason || normalized.rules.length === 0) {
    buildingFilterLayers.set([]);
    return;
  }
  setBuildingFilterLayers([{
    id: createFilterLayerId('compat-filter-layer'),
    color: FILTER_LAYER_BASE_COLOR,
    priority: 0,
    mode: 'and',
    rules: normalized.rules
  }]);
}

export function resetBuildingFilterRules() {
  resetBuildingFilterLayers();
}

export function setBuildingFilterRuntimeStatus(status: LooseRecord = {}) {
  buildingFilterRuntime.update((prev) => ({
    phase: status.phase != null ? String(status.phase) : String(prev.phase || 'idle'),
    statusCode: status.statusCode != null ? String(status.statusCode) : String(prev.statusCode || 'idle'),
    message: status.message != null ? String(status.message) : String(prev.message || ''),
    count: status.count != null ? Number(status.count || 0) : Number(prev.count || 0),
    elapsedMs: status.elapsedMs != null ? Number(status.elapsedMs || 0) : Number(prev.elapsedMs || 0),
    cacheHit: status.cacheHit != null ? Boolean(status.cacheHit) : Boolean(prev.cacheHit),
    setPaintPropertyCalls: status.setPaintPropertyCalls != null
      ? Number(status.setPaintPropertyCalls || 0)
      : Number(prev.setPaintPropertyCalls || 0),
    updatedAt: Number(status.updatedAt || Date.now())
  }));
}
