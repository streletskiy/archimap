import { writable } from 'svelte/store';
import { apiJson } from '$lib/services/http';

function normalizeStyleOverrideItem(item) {
  if (!item || typeof item !== 'object') return null;
  const styleKey = String(item.style_key || '').trim().toLowerCase();
  const regionPattern = String(item.region_pattern || '').trim().toLowerCase();
  if (!styleKey || !regionPattern) return null;
  return {
    id: Number(item.id || 0),
    region_pattern: regionPattern,
    style_key: styleKey,
    is_allowed: Boolean(item.is_allowed),
    created_at: item.created_at ? String(item.created_at) : null,
    updated_by: item.updated_by ? String(item.updated_by) : null
  };
}

function normalizeStyleOverrideList(items) {
  return (Array.isArray(items) ? items : [])
    .map((item) => normalizeStyleOverrideItem(item))
    .filter(Boolean);
}

export const styleRegionOverrides = writable([]);

let styleRegionOverridesLoaded = false;
let styleRegionOverridesLoadPromise = null;

export function setStyleRegionOverrides(items) {
  styleRegionOverrides.set(normalizeStyleOverrideList(items));
  styleRegionOverridesLoaded = true;
}

export async function loadStyleRegionOverrides(options: LooseRecord = {}) {
  const force = Boolean(options.force);
  if (!force && styleRegionOverridesLoaded) {
    return null;
  }
  if (!force && styleRegionOverridesLoadPromise) {
    return styleRegionOverridesLoadPromise;
  }

  styleRegionOverridesLoadPromise = apiJson('/api/style-overrides')
    .then((payload) => {
      const items = normalizeStyleOverrideList(payload?.items);
      styleRegionOverrides.set(items);
      styleRegionOverridesLoaded = true;
      return items;
    })
    .finally(() => {
      styleRegionOverridesLoadPromise = null;
    });

  return styleRegionOverridesLoadPromise;
}
