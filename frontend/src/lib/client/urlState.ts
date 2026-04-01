import { decodeFilterLayersFromUrl, encodeFilterLayersForUrl } from './filterUrlState.js';

const CAMERA_PRECISION = 6;
const CAMERA_ORIENTATION_PRECISION = 2;
const ZOOM_PRECISION = 2;

function toFiniteNumber(value) {
  if (value == null) return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function normalizeLatLng(lat, lng) {
  const latNum = toFiniteNumber(lat);
  const lngNum = toFiniteNumber(lng);
  if (latNum == null || lngNum == null) return null;
  if (latNum < -90 || latNum > 90 || lngNum < -180 || lngNum > 180) return null;
  return { lat: latNum, lng: lngNum };
}

function round(value, precision) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Number(n.toFixed(precision));
}

function parseBooleanFlag(value) {
  const text = String(value || '').trim().toLowerCase();
  if (!text) return null;
  if (text === '1' || text === 'true' || text === 'yes' || text === 'on') return true;
  if (text === '0' || text === 'false' || text === 'no' || text === 'off') return false;
  return null;
}

function parseCameraFromLl(params) {
  const llRaw = String(params.get('ll') || '').trim();
  if (!llRaw) return null;
  const parts = llRaw.split(',');
  if (parts.length !== 2) return null;
  const normalized = normalizeLatLng(parts[0], parts[1]);
  if (!normalized) return null;
  return normalized;
}

function parseCameraCore(params): LooseRecord | null {
  const direct = normalizeLatLng(params.get('lat'), params.get('lng'));
  const fromLl = direct ? null : parseCameraFromLl(params);
  const base = direct || fromLl;
  if (!base) return null;
  const zoom = toFiniteNumber(params.get('z'));
  const camera: LooseRecord = {
    lat: base.lat,
    lng: base.lng,
    z: zoom == null ? null : zoom
  };
  const pitch = toFiniteNumber(params.get('pitch'));
  if (pitch != null) {
    camera.pitch = pitch;
  }
  const bearing = toFiniteNumber(params.get('bearing'));
  if (bearing != null) {
    camera.bearing = bearing;
  }
  return camera;
}

function parseBuildings3dEnabled(params) {
  return parseBooleanFlag(params.get('3d'));
}

function parsePositiveInt(value) {
  if (value == null) return null;
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function decodeEncodedFeatureId(rawId) {
  const n = parsePositiveInt(rawId);
  if (n == null) return null;
  const osmType = (n % 2) === 1 ? 'relation' : 'way';
  const osmId = Math.floor(n / 2);
  if (!Number.isInteger(osmId) || osmId <= 0) return null;
  return { osmType, osmId };
}

function parseBuildingParam(raw) {
  const text = String(raw || '').trim().toLowerCase();
  if (!text) return null;
  if (text.includes('/')) {
    const [osmType, osmIdRaw] = text.split('/');
    const osmId = parsePositiveInt(osmIdRaw);
    if ((osmType === 'way' || osmType === 'relation') && osmId != null) {
      return { osmType, osmId };
    }
  }
  return decodeEncodedFeatureId(text);
}

function parseInfoState(params) {
  const tabRaw = String(params.get('tab') || params.get('info') || '').trim().toLowerCase();
  const docRaw = String(params.get('doc') || params.get('section') || '').trim().toLowerCase();
  if (tabRaw === 'user-agreement') return { tab: 'legal', doc: 'terms' };
  if (tabRaw === 'privacy-policy') return { tab: 'legal', doc: 'privacy' };

  if (tabRaw === 'legal') {
    if (docRaw === 'privacy') return { tab: 'legal', doc: 'privacy' };
    if (docRaw === 'cookies') return { tab: 'legal', doc: 'cookies' };
    return { tab: 'legal', doc: 'terms' };
  }
  if (tabRaw === 'about' || tabRaw === 'overview') return { tab: 'about', doc: null };
  if (!tabRaw && docRaw) {
    if (docRaw === 'privacy') return { tab: 'legal', doc: 'privacy' };
    if (docRaw === 'cookies') return { tab: 'legal', doc: 'cookies' };
    return { tab: 'legal', doc: 'terms' };
  }
  return null;
}

export function parseUrlState(input) {
  const url = input instanceof URL ? input : new URL(String(input || ''), 'http://localhost');
  const params = url.searchParams;
  return {
    buildings3dEnabled: parseBuildings3dEnabled(params),
    camera: parseCameraCore(params),
    filters: decodeFilterLayersFromUrl(params.get('f')),
    building: parseBuildingParam(params.get('building')),
    editId: parsePositiveInt(params.get('edit') || params.get('adminEdit')),
    info: parseInfoState(params)
  };
}

export function patchUrlState(currentUrl, patch: LooseRecord = {}) {
  const nextUrl = currentUrl instanceof URL ? new URL(currentUrl.toString()) : new URL(String(currentUrl || ''), 'http://localhost');
  const params = nextUrl.searchParams;
  params.delete('buildings3d');
  params.delete('b3d');

  if (Object.prototype.hasOwnProperty.call(patch, 'camera')) {
    const camera = patch.camera;
    if (!camera) {
      params.delete('lat');
      params.delete('lng');
      params.delete('z');
      params.delete('ll');
      params.delete('pitch');
      params.delete('bearing');
    } else {
      const normalized = normalizeLatLng(camera.lat, camera.lng);
      if (normalized) {
        params.set('lat', String(round(normalized.lat, CAMERA_PRECISION)));
        params.set('lng', String(round(normalized.lng, CAMERA_PRECISION)));
        params.delete('ll');
      }
      const zoom = toFiniteNumber(camera.z);
      if (zoom == null) {
        params.delete('z');
      } else {
        params.set('z', String(round(zoom, ZOOM_PRECISION)));
      }
      const pitch = toFiniteNumber(camera.pitch);
      if (pitch == null) {
        params.delete('pitch');
      } else {
        params.set('pitch', String(round(pitch, CAMERA_ORIENTATION_PRECISION)));
      }
      const bearing = toFiniteNumber(camera.bearing);
      if (bearing == null) {
        params.delete('bearing');
      } else {
        params.set('bearing', String(round(bearing, CAMERA_ORIENTATION_PRECISION)));
      }
    }
  }

  if (Object.prototype.hasOwnProperty.call(patch, 'buildings3dEnabled')) {
    const value = patch.buildings3dEnabled;
    if (value == null) params.delete('3d');
    else params.set('3d', value ? '1' : '0');
    if (value === false) {
      params.delete('pitch');
      params.delete('bearing');
    }
  }

  if (Object.prototype.hasOwnProperty.call(patch, 'building')) {
    const building = patch.building;
    const osmType = String(building?.osmType || '').trim().toLowerCase();
    const osmId = parsePositiveInt(building?.osmId);
    if ((osmType !== 'way' && osmType !== 'relation') || osmId == null) {
      params.delete('building');
    } else {
      params.set('building', `${osmType}/${osmId}`);
    }
  }

  if (Object.prototype.hasOwnProperty.call(patch, 'filters')) {
    const encodedFilters = encodeFilterLayersForUrl(patch.filters);
    if (!encodedFilters) {
      params.delete('f');
    } else {
      params.set('f', encodedFilters);
    }
  }

  if (Object.prototype.hasOwnProperty.call(patch, 'editId')) {
    const id = parsePositiveInt(patch.editId);
    params.delete('adminEdit');
    if (id == null) params.delete('edit');
    else params.set('edit', String(id));
  }

  if (Object.prototype.hasOwnProperty.call(patch, 'info')) {
    const info = patch.info;
    if (!info) {
      params.delete('tab');
      params.delete('doc');
      params.delete('info');
      params.delete('section');
    } else if (String(info.tab || '').trim().toLowerCase() === 'about') {
      params.set('tab', 'about');
      params.delete('doc');
      params.delete('info');
      params.delete('section');
    } else {
      const docRaw = String(info.doc || '').trim().toLowerCase();
      const doc = docRaw === 'privacy' || docRaw === 'cookies' ? docRaw : 'terms';
      params.set('tab', 'legal');
      params.set('doc', doc);
      params.delete('info');
      params.delete('section');
    }
  }

  return nextUrl;
}
