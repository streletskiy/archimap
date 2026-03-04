import { writable } from 'svelte/store';

export const buildingFilterRules = writable([]);
export const buildingFilterRuntime = writable({
  phase: 'idle',
  statusCode: 'idle',
  message: '',
  count: 0,
  elapsedMs: 0,
  cacheHit: false,
  setFeatureStateCalls: 0,
  updatedAt: 0
});

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

export function setBuildingFilterRuntimeStatus(status = {}) {
  buildingFilterRuntime.update((prev) => ({
    phase: status.phase != null ? String(status.phase) : String(prev.phase || 'idle'),
    statusCode: status.statusCode != null ? String(status.statusCode) : String(prev.statusCode || 'idle'),
    message: status.message != null ? String(status.message) : String(prev.message || ''),
    count: status.count != null ? Number(status.count || 0) : Number(prev.count || 0),
    elapsedMs: status.elapsedMs != null ? Number(status.elapsedMs || 0) : Number(prev.elapsedMs || 0),
    cacheHit: status.cacheHit != null ? Boolean(status.cacheHit) : Boolean(prev.cacheHit),
    setFeatureStateCalls: status.setFeatureStateCalls != null
      ? Number(status.setFeatureStateCalls || 0)
      : Number(prev.setFeatureStateCalls || 0),
    updatedAt: Number(status.updatedAt || Date.now())
  }));
}

