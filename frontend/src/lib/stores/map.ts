import { get, writable } from 'svelte/store';
import { parseUrlState } from '../client/urlState.js';

const LAST_MAP_CAMERA_STORAGE_KEY = 'archimap-last-map-camera';
const MAP_BUILDING_PARTS_VISIBLE_STORAGE_KEY = 'archimap-map-building-parts-visible';

function getStorageHost(storageHost = null) {
  if (storageHost) return storageHost;
  if (typeof window === 'undefined') return null;
  return window;
}

export function normalizeOptionalMapZoom(value) {
  if (value == null) return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  const zoom = Number(value);
  return Number.isFinite(zoom) ? zoom : null;
}

export function normalizeLastMapCamera(value) {
  const lat = Number(value?.lat);
  const lng = Number(value?.lng);
  const zoom = normalizeOptionalMapZoom(value?.z);
  if (!Number.isFinite(lat) || lat < -90 || lat > 90) return null;
  if (!Number.isFinite(lng) || lng < -180 || lng > 180) return null;
  return {
    lat,
    lng,
    z: Number.isFinite(zoom) ? zoom : null
  };
}

function readLastMapCameraFromStorage(storage) {
  if (!storage?.getItem) return null;
  try {
    const raw = storage.getItem(LAST_MAP_CAMERA_STORAGE_KEY);
    if (!raw) return null;
    return normalizeLastMapCamera(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function getInitialLastMapCamera(storageHost = null) {
  const host = getStorageHost(storageHost);
  if (!host) return null;
  const fromLocalStorage = readLastMapCameraFromStorage(host.localStorage);
  if (fromLocalStorage) return fromLocalStorage;
  const fromSessionStorage = readLastMapCameraFromStorage(host.sessionStorage);
  if (!fromSessionStorage) return null;
  try {
    host.localStorage?.setItem?.(LAST_MAP_CAMERA_STORAGE_KEY, JSON.stringify(fromSessionStorage));
  } catch {
    // ignore
  }
  return fromSessionStorage;
}

function persistLastMapCamera(camera, storageHost = null) {
  const host = getStorageHost(storageHost);
  if (!host) return;
  try {
    const normalized = normalizeLastMapCamera(camera);
    if (!normalized) return;
    host.localStorage?.setItem?.(LAST_MAP_CAMERA_STORAGE_KEY, JSON.stringify(normalized));
    host.sessionStorage?.removeItem?.(LAST_MAP_CAMERA_STORAGE_KEY);
  } catch {
    // ignore
  }
}

function withFallbackZoom(camera, fallbackCamera) {
  if (!camera) return null;
  return {
    lat: camera.lat,
    lng: camera.lng,
    z: camera.z != null ? camera.z : fallbackCamera.z
  };
}

export function resolveInitialMapCamera({ url, fallbackCamera, persistedCamera }: LooseRecord = {}) {
  const normalizedFallbackCamera = normalizeLastMapCamera(fallbackCamera);
  if (!normalizedFallbackCamera) return null;
  const urlCamera = normalizeLastMapCamera(parseUrlState(url || 'http://localhost').camera);
  if (urlCamera) {
    return withFallbackZoom(urlCamera, normalizedFallbackCamera);
  }
  const normalizedPersistedCamera = normalizeLastMapCamera(persistedCamera);
  if (normalizedPersistedCamera) {
    return withFallbackZoom(normalizedPersistedCamera, normalizedFallbackCamera);
  }
  return normalizedFallbackCamera;
}

function patchLastMapCamera(patch: LooseRecord = {}) {
  const current = get(lastMapCamera) || {};
  const next = normalizeLastMapCamera({
    ...current,
    ...patch
  });
  if (!next) return;
  lastMapCamera.set(next);
  persistLastMapCamera(next);
}

function getInitialLabelsVisibility() {
  if (typeof window === 'undefined') return true;
  try {
    const stored = localStorage.getItem('archimap-map-labels-visible');
    if (stored === '0') return false;
    if (stored === '1') return true;
  } catch {
    // ignore
  }
  return true;
}

function getInitialBuildingPartsVisibility() {
  if (typeof window === 'undefined') return false;
  try {
    const stored = localStorage.getItem(MAP_BUILDING_PARTS_VISIBLE_STORAGE_KEY);
    if (stored === '0') return false;
    if (stored === '1') return true;
  } catch {
    // ignore
  }
  return false;
}

export const selectedBuilding = writable(null);
export const selectedBuildings = writable([]);
export const mapSelectionShiftKey = writable(false);
export const mapReady = writable(false);
export const mapCenter = writable(null);
export const mapZoom = writable(null);
export const mapViewport = writable(null);
export const mapFocusRequest = writable(null);
export const mapLabelsVisible = writable(getInitialLabelsVisibility());
export const mapBuildingPartsVisible = writable(getInitialBuildingPartsVisibility());
export const lastMapCamera = writable(getInitialLastMapCamera());

function getSelectedBuildingKey(selection) {
  const osmType = String(selection?.osmType || '').trim();
  const osmId = Number(selection?.osmId);
  if (!['way', 'relation'].includes(osmType) || !Number.isInteger(osmId) || osmId <= 0) {
    return '';
  }
  return `${osmType}/${osmId}`;
}

function normalizeSelectedBuilding(item) {
  const osmType = String(item?.osmType ?? item?.osm_type ?? '').trim();
  const osmId = Number(item?.osmId ?? item?.osm_id);
  if (!['way', 'relation'].includes(osmType) || !Number.isInteger(osmId) || osmId <= 0) return null;

  const lonRaw = item?.lon;
  const latRaw = item?.lat;
  const lon = lonRaw == null || lonRaw === '' ? null : Number(lonRaw);
  const lat = latRaw == null || latRaw === '' ? null : Number(latRaw);

  return {
    osmType,
    osmId,
    lon: lon != null && Number.isFinite(lon) ? lon : null,
    lat: lat != null && Number.isFinite(lat) ? lat : null,
    featureKind: String(item?.featureKind ?? item?.feature_kind ?? '').trim() || null
  };
}

function normalizeSelectedBuildings(items) {
  const normalized = [];
  const seen = new Set();
  for (const item of Array.isArray(items) ? items : []) {
    const selection = normalizeSelectedBuilding(item);
    if (!selection) continue;
    const key = getSelectedBuildingKey(selection);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    normalized.push(selection);
  }
  return normalized;
}

function syncSelectedBuildingSelection(items) {
  const normalized = normalizeSelectedBuildings(items);
  selectedBuildings.set(normalized);
  selectedBuilding.set(normalized[0] || null);
  return normalized;
}

export function setSelectedBuilding(item) {
  syncSelectedBuildingSelection(item ? [item] : []);
}

export function setSelectedBuildings(items) {
  syncSelectedBuildingSelection(items);
}

export function toggleSelectedBuilding(item) {
  const selection = normalizeSelectedBuilding(item);
  if (!selection) return;
  const current = get(selectedBuildings);
  const key = getSelectedBuildingKey(selection);
  const index = current.findIndex((entry) => getSelectedBuildingKey(entry) === key);
  if (index >= 0) {
    syncSelectedBuildingSelection([
      ...current.slice(0, index),
      ...current.slice(index + 1)
    ]);
    return;
  }
  syncSelectedBuildingSelection([...current, selection]);
}

export function clearSelectedBuildings() {
  syncSelectedBuildingSelection([]);
}

export function setMapSelectionShiftKey(value) {
  mapSelectionShiftKey.set(Boolean(value));
}

export function setMapReady(value) {
  mapReady.set(Boolean(value));
}

export function setMapCenter(center) {
  if (!center || !Number.isFinite(+center.lng) || !Number.isFinite(+center.lat)) {
    mapCenter.set(null);
    return;
  }
  const nextCenter = {
    lng: Number(center.lng),
    lat: Number(center.lat)
  };
  mapCenter.set(nextCenter);
  patchLastMapCamera({
    lng: nextCenter.lng,
    lat: nextCenter.lat
  });
}

export function setMapZoom(zoom) {
  const value = normalizeOptionalMapZoom(zoom);
  if (value == null) {
    mapZoom.set(null);
    return;
  }
  mapZoom.set(value);
  patchLastMapCamera({ z: value });
}

export function setMapViewport(viewport) {
  const west = Number(viewport?.west);
  const south = Number(viewport?.south);
  const east = Number(viewport?.east);
  const north = Number(viewport?.north);
  if (![west, south, east, north].every(Number.isFinite) || west >= east || south >= north) {
    mapViewport.set(null);
    return;
  }
  mapViewport.set({
    west,
    south,
    east,
    north
  });
}

export function requestMapFocus(payload: LooseRecord = {}) {
  const lon = Number(payload?.lon);
  const lat = Number(payload?.lat);
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return;
  const zoom = normalizeOptionalMapZoom(payload?.zoom);
  mapFocusRequest.set({
    id: Date.now() + Math.random(),
    lon,
    lat,
    offsetX: Number(payload?.offsetX || 0),
    offsetY: Number(payload?.offsetY || 0),
    zoom,
    duration: Number.isFinite(+payload?.duration) ? Number(payload.duration) : 420
  });
}

export function setMapLabelsVisible(value) {
  mapLabelsVisible.set(Boolean(value));
}

export function setMapBuildingPartsVisible(value) {
  const next = Boolean(value);
  mapBuildingPartsVisible.set(next);
  try {
    localStorage.setItem(MAP_BUILDING_PARTS_VISIBLE_STORAGE_KEY, next ? '1' : '0');
  } catch {
    // ignore
  }
}
