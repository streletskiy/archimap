import { writable } from 'svelte/store';

export const buildingFilterRules = writable([]);

export function setBuildingFilterRules(rules) {
  const normalized = Array.isArray(rules)
    ? rules
      .map((rule) => ({
        key: String(rule?.key || '').trim(),
        op: String(rule?.op || 'contains').trim(),
        value: String(rule?.value || '').trim()
      }))
      .filter((rule) => rule.key)
    : [];
  buildingFilterRules.set(normalized);
}

export function resetBuildingFilterRules() {
  buildingFilterRules.set([]);
}

