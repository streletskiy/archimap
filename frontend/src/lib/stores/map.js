import { get, writable } from 'svelte/store';

const LAST_MAP_CAMERA_STORAGE_KEY = 'archimap-last-map-camera';

function normalizeLastMapCamera(value) {
  const lat = Number(value?.lat);
  const lng = Number(value?.lng);
  const zoom = Number(value?.z);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return {
    lat,
    lng,
    z: Number.isFinite(zoom) ? zoom : null
  };
}

function getInitialLastMapCamera() {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.sessionStorage.getItem(LAST_MAP_CAMERA_STORAGE_KEY);
    if (!raw) return null;
    return normalizeLastMapCamera(JSON.parse(raw));
  } catch {
    return null;
  }
}

function persistLastMapCamera(camera) {
  if (typeof window === 'undefined') return;
  try {
    const normalized = normalizeLastMapCamera(camera);
    if (!normalized) return;
    window.sessionStorage.setItem(LAST_MAP_CAMERA_STORAGE_KEY, JSON.stringify(normalized));
  } catch {
    // ignore
  }
}

function patchLastMapCamera(patch = {}) {
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

export const selectedBuilding = writable(null);
export const mapReady = writable(false);
export const mapCenter = writable(null);
export const mapZoom = writable(null);
export const mapViewport = writable(null);
export const mapFocusRequest = writable(null);
export const mapLabelsVisible = writable(getInitialLabelsVisibility());
export const lastMapCamera = writable(getInitialLastMapCamera());

export function setSelectedBuilding(item) {
  selectedBuilding.set(item || null);
}

export function setMapReady(value) {
  mapReady.set(Boolean(value));
}

export function setMapCenter(center) {
  if (!center || !Number.isFinite(Number(center.lng)) || !Number.isFinite(Number(center.lat))) {
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
  const value = Number(zoom);
  if (!Number.isFinite(value)) {
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

export function requestMapFocus(payload = {}) {
  const lon = Number(payload?.lon);
  const lat = Number(payload?.lat);
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return;
  mapFocusRequest.set({
    id: Date.now() + Math.random(),
    lon,
    lat,
    offsetX: Number(payload?.offsetX || 0),
    offsetY: Number(payload?.offsetY || 0),
    zoom: Number.isFinite(Number(payload?.zoom)) ? Number(payload.zoom) : null,
    duration: Number.isFinite(Number(payload?.duration)) ? Number(payload.duration) : 420
  });
}

export function setMapLabelsVisible(value) {
  mapLabelsVisible.set(Boolean(value));
}
