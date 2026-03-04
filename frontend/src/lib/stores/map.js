import { writable } from 'svelte/store';

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
export const mapFocusRequest = writable(null);
export const mapLabelsVisible = writable(getInitialLabelsVisibility());

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
  mapCenter.set({
    lng: Number(center.lng),
    lat: Number(center.lat)
  });
}

export function setMapZoom(zoom) {
  const value = Number(zoom);
  if (!Number.isFinite(value)) {
    mapZoom.set(null);
    return;
  }
  mapZoom.set(value);
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
