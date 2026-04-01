import { get, writable } from 'svelte/store';
import osmtogeojson from 'osmtogeojson';
import { translateNow } from '$lib/i18n/index';
import { buildBboxHash, buildBboxSnapshot } from './filter-bbox.js';
import {
  applyBuildingPartBaseSuppression,
  buildOverpassBuildingDetails,
  buildOverpassFilterDataItem,
  buildOverpassFeaturePayload,
  buildOverpassSearchItem
} from './overpass-data-utils.js';
import { BUILDING_HIDE_BASE_WHEN_PARTS_PROPERTY } from './map-3d-utils.js';
import type { BboxSnapshot } from './filter-types.js';

type OverpassGeoJsonFeature = {
  type: 'Feature';
  id?: number | string | null;
  geometry?: {
    type?: string | null;
    coordinates?: unknown;
  } | null;
  properties?: Record<string, unknown> | null;
};

type OverpassGeoJsonFeatureCollection = {
  type: 'FeatureCollection';
  features: OverpassGeoJsonFeature[];
};

type OverpassTileRecord = {
  key: string;
  bbox: BboxSnapshot;
  fetchedAt: number;
  features: OverpassGeoJsonFeature[];
};

type OverpassViewportContext = {
  viewport: BboxSnapshot | null;
  zoom: number;
  covered: boolean;
  refreshToken?: number;
};

type OverpassRequestState = {
  phase: 'idle' | 'ready' | 'loading' | 'error';
  loading: boolean;
  promptVisible: boolean;
  canLoad: boolean;
  messageKey: 'idle' | 'zoomIn' | 'loadArea' | 'cacheReady' | 'loading' | 'error';
  message: string;
  error: string;
  progressDone: number;
  progressTotal: number;
  viewportHash: string;
  tileZoom: number;
  covered: boolean;
  featureCount: number;
  tileCount: number;
  dataVersion: number;
  endpoint: string;
  lastUpdatedAt: number;
  lastSyncedAt: number;
};

type CachedFeatureEntry = {
  feature: OverpassGeoJsonFeature;
  tileKeys: Set<string>;
  updatedAt: number;
};

type OverpassEndpointHttpError = Error & {
  endpoint: string;
  status: number;
};

const OVERPASS_ENDPOINTS = Object.freeze([
  'https://overpass-api.de/api/interpreter',
  'https://lz4.overpass-api.de/api/interpreter',
  'https://z.overpass-api.de/api/interpreter',
  'https://overpass.openstreetmap.fr/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter'
]);

const OVERPASS_STORAGE_PREFIX = 'archimap-overpass';
const OVERPASS_DB_NAME = `${OVERPASS_STORAGE_PREFIX}-cache-v1`;
const OVERPASS_DB_STORE = 'tiles';
const OVERPASS_LAST_ENDPOINT_KEY = `${OVERPASS_STORAGE_PREFIX}-last-endpoint`;
const OVERPASS_LAST_SYNC_KEY = `${OVERPASS_STORAGE_PREFIX}-last-sync`;
export const OVERPASS_MIN_COVERAGE_CHECK_ZOOM = 12;
const OVERPASS_MIN_RENDER_ZOOM = 13;
const OVERPASS_MIN_LOAD_ZOOM = 13;
const OVERPASS_TILE_PADDING = 1;
const OVERPASS_TILE_FETCH_CONCURRENCY = 3;
const OVERPASS_ENDPOINT_COOLDOWN_MS = 2 * 60 * 1000;
const OVERPASS_MAX_MEMORY_TILES = 96;
const OVERPASS_VIEWPORT_REFRESH_DEBOUNCE_MS = 180;
const OVERPASS_TILE_REQUEST_TIMEOUT_MS = 18000;
const OVERPASS_EMPTY_COLLECTION: OverpassGeoJsonFeatureCollection = {
  type: 'FeatureCollection',
  features: []
};

const initialState: OverpassRequestState = {
  phase: 'idle',
  loading: false,
  promptVisible: false,
  canLoad: false,
  messageKey: 'idle',
  message: '',
  error: '',
  progressDone: 0,
  progressTotal: 0,
  viewportHash: '',
  tileZoom: OVERPASS_MIN_LOAD_ZOOM,
  covered: true,
  featureCount: 0,
  tileCount: 0,
  dataVersion: 0,
  endpoint: '',
  lastUpdatedAt: 0,
  lastSyncedAt: (() => {
    if (typeof window === 'undefined') return 0;
    try {
      const raw = window.localStorage?.getItem?.(OVERPASS_LAST_SYNC_KEY);
      const value = Number(raw || 0);
      return Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
    } catch {
      return 0;
    }
  })()
};

export const overpassBuildingsState = writable(initialState);

let viewportRefreshTimer = null;
let latestViewportContext: OverpassViewportContext | null = null;
let activeLoadAbortController: AbortController | null = null;
let activeLoadToken = 0;
let workingEndpoint: string | null = null;
let featureCollectionVersion = 0;
let lastRenderedFeatureCollectionVersion = -1;
let lastRenderedFeatureCollection: OverpassGeoJsonFeatureCollection = OVERPASS_EMPTY_COLLECTION;
let endpointCooldowns = new Map<string, number>();
let memoryTileCache = new Map<string, OverpassTileRecord>();
let cachedFeatureIndex = new Map<string, CachedFeatureEntry>();
let tileKeyAccessOrder: Array<{ key: string; touchedAt: number }> = [];
let idbPromise: Promise<IDBDatabase | null> | null = null;
let indexedDbAvailable = typeof indexedDB !== 'undefined';
let memoryDbFallback = new Map<string, OverpassTileRecord>();

export function shouldCheckOverpassViewportCoverage(zoom: number | string | null | undefined) {
  const normalizedZoom = Number(zoom);
  return Number.isFinite(normalizedZoom) && normalizedZoom >= OVERPASS_MIN_COVERAGE_CHECK_ZOOM;
}

function patchOverpassState(patch: Partial<OverpassRequestState> = {}) {
  overpassBuildingsState.update((state) => ({
    ...state,
    ...patch
  }));
}

function normalizeBbox(value: unknown): BboxSnapshot | null {
  if (!value || typeof value !== 'object') return null;
  const bounds = value as {
    getWest?: () => number;
    getSouth?: () => number;
    getEast?: () => number;
    getNorth?: () => number;
    west?: unknown;
    south?: unknown;
    east?: unknown;
    north?: unknown;
  };
  if (typeof bounds.getWest === 'function') {
    return buildBboxSnapshot(bounds);
  }
  const west = Number(bounds.west);
  const south = Number(bounds.south);
  const east = Number(bounds.east);
  const north = Number(bounds.north);
  if (![west, south, east, north].every(Number.isFinite)) return null;
  return { west, south, east, north };
}

function getStorageHost() {
  if (typeof window === 'undefined') return null;
  return window;
}

function getLastWorkingEndpoint() {
  const host = getStorageHost();
  if (!host) return null;
  try {
    const value = host.localStorage?.getItem?.(OVERPASS_LAST_ENDPOINT_KEY);
    return value ? String(value) : null;
  } catch {
    return null;
  }
}

function setLastWorkingEndpoint(endpoint) {
  const host = getStorageHost();
  if (!host) return;
  try {
    if (endpoint) {
      host.localStorage?.setItem?.(OVERPASS_LAST_ENDPOINT_KEY, String(endpoint));
    }
  } catch {
    // ignore storage failures
  }
}

function rememberWorkingEndpoint(endpoint: string) {
  const normalized = String(endpoint || '').trim();
  if (!normalized) return;
  workingEndpoint = normalized;
  setLastWorkingEndpoint(normalized);
}

function createOverpassEndpointHttpError(endpoint: string, status: number) {
  const error = new Error(`Overpass endpoint returned HTTP ${status}`) as OverpassEndpointHttpError;
  error.name = 'OverpassEndpointHttpError';
  error.endpoint = String(endpoint || '').trim();
  error.status = Math.trunc(Number(status) || 0);
  return error;
}

function isOverpassEndpointCooldownStatus(status: number) {
  return status === 403 || status === 408 || status === 429 || status >= 500;
}

function clearExpiredOverpassEndpointCooldowns(now = Date.now()) {
  for (const [endpoint, expiresAt] of endpointCooldowns.entries()) {
    if (!Number.isFinite(expiresAt) || expiresAt <= now) {
      endpointCooldowns.delete(endpoint);
    }
  }
}

function isOverpassEndpointCoolingDown(endpoint: string, now = Date.now()) {
  const normalized = String(endpoint || '').trim();
  if (!normalized) return false;
  const expiresAt = endpointCooldowns.get(normalized) || 0;
  if (!Number.isFinite(expiresAt) || expiresAt <= now) {
    if (expiresAt > 0) {
      endpointCooldowns.delete(normalized);
    }
    return false;
  }
  return true;
}

function coolDownOverpassEndpoint(endpoint: string, status: number) {
  const normalized = String(endpoint || '').trim();
  if (!normalized || !isOverpassEndpointCooldownStatus(status)) return;
  endpointCooldowns.set(normalized, Date.now() + OVERPASS_ENDPOINT_COOLDOWN_MS);
  if (workingEndpoint === normalized) {
    workingEndpoint = null;
  }
}

function readStoredNumber(storageKey: string, storageArea: 'localStorage' | 'sessionStorage' = 'localStorage') {
  const host = getStorageHost();
  if (!host) return 0;
  try {
    const storage = storageArea === 'localStorage' ? host.localStorage : host.sessionStorage;
    const raw = storage?.getItem?.(storageKey);
    const value = Number(raw || 0);
    return Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
  } catch {
    return 0;
  }
}

function setStoredNumber(storageKey: string, value: number, storageArea: 'localStorage' | 'sessionStorage' = 'localStorage') {
  const host = getStorageHost();
  if (!host) return;
  try {
    const storage = storageArea === 'localStorage' ? host.localStorage : host.sessionStorage;
    const normalized = Number(value) > 0 ? Math.trunc(Number(value)) : 0;
    if (normalized > 0) {
      storage?.setItem?.(storageKey, String(normalized));
    } else {
      storage?.removeItem?.(storageKey);
    }
  } catch {
    // ignore storage failures
  }
}

function getLastSyncedAt() {
  return readStoredNumber(OVERPASS_LAST_SYNC_KEY, 'localStorage');
}

function setLastSyncedAt(value: number) {
  setStoredNumber(OVERPASS_LAST_SYNC_KEY, value, 'localStorage');
}

function buildViewportContextSignature(context: OverpassViewportContext | null | undefined) {
  if (!context) return 'context:none';
  const viewportHash = context.viewport ? buildBboxHash(context.viewport, 5) : 'bbox:none';
  const zoom = Number.isFinite(Number(context.zoom)) ? Number(Number(context.zoom)).toFixed(2) : 'NaN';
  return `${viewportHash}:${zoom}:${context.covered ? 'covered' : 'open'}`;
}

function areViewportContextsEqual(left: OverpassViewportContext | null | undefined, right: OverpassViewportContext | null | undefined) {
  return buildViewportContextSignature(left) === buildViewportContextSignature(right);
}

function clearTileKeyAccess(tileKey: string) {
  tileKeyAccessOrder = tileKeyAccessOrder.filter((item) => item.key !== tileKey);
}

function detachTileRecordFromFeatureIndex(tileKey: string, record: OverpassTileRecord | null | undefined) {
  if (!record || !Array.isArray(record.features)) return false;
  let changed = false;
  for (const feature of record.features) {
    const osmKey = String(feature?.properties?.osm_key || '').trim();
    if (!osmKey) continue;
    const current = cachedFeatureIndex.get(osmKey);
    if (!current) continue;
    current.tileKeys.delete(tileKey);
    changed = true;
    if (current.tileKeys.size === 0) {
      cachedFeatureIndex.delete(osmKey);
    }
  }
  return changed;
}

async function deleteTileRecordFromDb(tileKey: string) {
  const db = await openOverpassDb();
  if (!db) {
    memoryDbFallback.delete(tileKey);
    return;
  }
  return new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(OVERPASS_DB_STORE, 'readwrite');
      const store = tx.objectStore(OVERPASS_DB_STORE);
      store.delete(tileKey);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    } catch {
      resolve();
    }
  });
}

async function clearTileRecordsFromDb() {
  const db = await openOverpassDb();
  if (!db) {
    memoryDbFallback.clear();
    return;
  }
  return new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(OVERPASS_DB_STORE, 'readwrite');
      const store = tx.objectStore(OVERPASS_DB_STORE);
      store.clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    } catch {
      resolve();
    }
  });
}

async function evictTileRecord(tileKey: string) {
  const existing = memoryTileCache.get(tileKey) || memoryDbFallback.get(tileKey) || await readTileRecordFromDb(tileKey);
  const changed = detachTileRecordFromFeatureIndex(tileKey, existing);
  memoryTileCache.delete(tileKey);
  memoryDbFallback.delete(tileKey);
  clearTileKeyAccess(tileKey);
  await deleteTileRecordFromDb(tileKey);
  return changed;
}

async function evictViewportTiles(context: OverpassViewportContext) {
  const plan = getViewportTilePlan(context.viewport, context.zoom);
  if (plan.tiles.length === 0) {
    return false;
  }
  let changed = false;
  for (const tile of plan.tiles) {
    const tileChanged = await evictTileRecord(tile.key);
    changed = changed || tileChanged;
  }
  if (changed) {
    featureCollectionVersion += 1;
    lastRenderedFeatureCollectionVersion = -1;
  }
  return changed;
}

function resolveBboxTileZoom(zoom: number) {
  const value = Number(zoom);
  if (!Number.isFinite(value)) return OVERPASS_MIN_LOAD_ZOOM;
  return Math.max(OVERPASS_MIN_LOAD_ZOOM, Math.min(15, Math.round(value)));
}

function lonToTileX(lon: number, zoom: number) {
  const scale = 2 ** zoom;
  return Math.floor(((lon + 180) / 360) * scale);
}

function latToTileY(lat: number, zoom: number) {
  const scale = 2 ** zoom;
  const latClamped = Math.max(-85.05112878, Math.min(85.05112878, lat));
  const rad = (latClamped * Math.PI) / 180;
  return Math.floor(((1 - Math.log(Math.tan(rad) + (1 / Math.cos(rad))) / Math.PI) / 2) * scale);
}

function tileXToLon(x: number, zoom: number) {
  const scale = 2 ** zoom;
  return (x / scale) * 360 - 180;
}

function tileYToLat(y: number, zoom: number) {
  const scale = 2 ** zoom;
  const n = Math.PI - (2 * Math.PI * y) / scale;
  return (180 / Math.PI) * Math.atan(Math.sinh(n));
}

function buildTileKey(zoom: number, x: number, y: number) {
  return `${zoom}/${x}/${y}`;
}

function getTileBBox(zoom: number, x: number, y: number): BboxSnapshot {
  const west = tileXToLon(x, zoom);
  const east = tileXToLon(x + 1, zoom);
  const north = tileYToLat(y, zoom);
  const south = tileYToLat(y + 1, zoom);
  return {
    west,
    south,
    east,
    north
  };
}

function getViewportTilePlan(viewport: BboxSnapshot | null, zoom: number) {
  const tileZoom = resolveBboxTileZoom(zoom);
  const tooCoarse = Number(zoom) < OVERPASS_MIN_RENDER_ZOOM;
  if (!viewport || tooCoarse) {
    return {
      tileZoom,
      tileKeys: [] as string[],
      tiles: [] as Array<{ key: string; bbox: BboxSnapshot }>,
      tooCoarse: true
    };
  }

  const worldScale = 2 ** tileZoom;
  const xMin = Math.max(0, lonToTileX(viewport.west, tileZoom) - OVERPASS_TILE_PADDING);
  const xMax = Math.min(worldScale - 1, lonToTileX(viewport.east, tileZoom) + OVERPASS_TILE_PADDING);
  const yMin = Math.max(0, latToTileY(viewport.north, tileZoom) - OVERPASS_TILE_PADDING);
  const yMax = Math.min(worldScale - 1, latToTileY(viewport.south, tileZoom) + OVERPASS_TILE_PADDING);
  const tiles = [];
  for (let x = Math.min(xMin, xMax); x <= Math.max(xMin, xMax); x += 1) {
    for (let y = Math.min(yMin, yMax); y <= Math.max(yMin, yMax); y += 1) {
      tiles.push({
        key: buildTileKey(tileZoom, x, y),
        bbox: getTileBBox(tileZoom, x, y)
      });
    }
  }

  return {
    tileZoom,
    tileKeys: tiles.map((item) => item.key),
    tiles,
    tooCoarse: false
  };
}

function normalizeTileFeature(feature: OverpassGeoJsonFeature, tileKey: string) {
  const payload = buildOverpassFeaturePayload(feature, { tileKey });
  if (!payload) return null;
  return {
    type: 'Feature' as const,
    id: Number.isInteger(encodeFeatureId(payload.osmType, payload.osmId)) ? encodeFeatureId(payload.osmType, payload.osmId) : undefined,
    geometry: feature?.geometry || null,
    properties: {
      ...(feature?.properties && typeof feature.properties === 'object' ? feature.properties : {}),
      id: payload.osmId,
      type: payload.osmType,
      osm_type: payload.osmType,
      osm_id: payload.osmId,
      osm_key: payload.osmKey,
      feature_kind: payload.featureKind,
      source: 'overpass',
      source_tags: payload.sourceTags,
      archiInfo: payload.archiInfo,
      name: payload.name,
      style: payload.style,
      styleRaw: payload.styleRaw,
      design: payload.design,
      design_ref: payload.designRef,
      design_year: payload.designYear,
      levels: payload.levels,
      year_built: payload.yearBuilt,
      architect: payload.architect,
      material: payload.material,
      materialRaw: payload.materialRaw,
      materialConcrete: payload.materialConcrete,
      colour: payload.colour,
      address: payload.address,
      description: payload.description,
      archimap_description: payload.archimapDescription,
      center_lon: payload.centerLon,
      center_lat: payload.centerLat,
      render_height_m: payload.renderHeightMeters,
      render_min_height_m: payload.renderMinHeightMeters,
      [BUILDING_HIDE_BASE_WHEN_PARTS_PROPERTY]: 0,
      search_text: payload.searchText,
      tile_keys: [tileKey],
      loaded_at: Date.now()
    }
  };
}

function encodeFeatureId(osmType: string, osmId: number) {
  return (Number(osmId) * 2) + (osmType === 'relation' ? 1 : 0);
}

function addTileKeyAccess(tileKey: string) {
  const now = Date.now();
  const existingIndex = tileKeyAccessOrder.findIndex((item) => item.key === tileKey);
  if (existingIndex >= 0) {
    tileKeyAccessOrder[existingIndex] = { key: tileKey, touchedAt: now };
  } else {
    tileKeyAccessOrder.push({ key: tileKey, touchedAt: now });
  }
}

function ingestTileRecord(tileKey: string, record: OverpassTileRecord) {
  const normalizedFeatures: OverpassGeoJsonFeature[] = [];
  for (const feature of Array.isArray(record?.features) ? record.features : []) {
    const normalized = normalizeTileFeature(feature, tileKey);
    if (!normalized) continue;
    normalizedFeatures.push(normalized);
    const payload = buildOverpassFeaturePayload(feature, { tileKey });
    if (!payload) continue;
    const existing = cachedFeatureIndex.get(payload.osmKey);
    if (existing) {
      existing.feature = normalized;
      existing.tileKeys.add(tileKey);
      existing.updatedAt = Date.now();
    } else {
      cachedFeatureIndex.set(payload.osmKey, {
        feature: normalized,
        tileKeys: new Set([tileKey]),
        updatedAt: Date.now()
      });
    }
  }

  memoryTileCache.set(tileKey, {
    key: tileKey,
    bbox: record.bbox,
    fetchedAt: record.fetchedAt,
    features: normalizedFeatures
  });
  addTileKeyAccess(tileKey);
  featureCollectionVersion += 1;
}

function pruneMemoryTileCache() {
  if (memoryTileCache.size <= OVERPASS_MAX_MEMORY_TILES) return;
  const ordered = [...tileKeyAccessOrder]
    .sort((left, right) => left.touchedAt - right.touchedAt)
    .map((item) => item.key);
  while (memoryTileCache.size > OVERPASS_MAX_MEMORY_TILES && ordered.length > 0) {
    const key = ordered.shift();
    if (!key || !memoryTileCache.has(key)) continue;
    const entry = memoryTileCache.get(key);
    memoryTileCache.delete(key);
    tileKeyAccessOrder = tileKeyAccessOrder.filter((item) => item.key !== key);
    for (const feature of Array.isArray(entry?.features) ? entry.features : []) {
      const osmKey = String(feature?.properties?.osm_key || '').trim();
      if (!osmKey) continue;
      const current = cachedFeatureIndex.get(osmKey);
      if (!current) continue;
      current.tileKeys.delete(key);
      if (current.tileKeys.size === 0) {
        cachedFeatureIndex.delete(osmKey);
      }
    }
    featureCollectionVersion += 1;
  }
}

async function openOverpassDb() {
  if (!indexedDbAvailable || typeof indexedDB === 'undefined') return null;
  if (idbPromise) return idbPromise;
  idbPromise = new Promise((resolve) => {
    try {
      const request = indexedDB.open(OVERPASS_DB_NAME, 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(OVERPASS_DB_STORE)) {
          db.createObjectStore(OVERPASS_DB_STORE, { keyPath: 'key' });
        }
      };
      request.onerror = () => resolve(null);
      request.onsuccess = () => resolve(request.result);
    } catch {
      resolve(null);
    }
  });
  return idbPromise;
}

async function readTileRecordFromDb(tileKey: string) {
  const db = await openOverpassDb();
  if (!db) {
    return memoryDbFallback.get(tileKey) || null;
  }
  return new Promise<OverpassTileRecord | null>((resolve) => {
    try {
      const tx = db.transaction(OVERPASS_DB_STORE, 'readonly');
      const store = tx.objectStore(OVERPASS_DB_STORE);
      const request = store.get(tileKey);
      request.onerror = () => resolve(null);
      request.onsuccess = () => resolve(request.result || null);
    } catch {
      resolve(null);
    }
  });
}

async function writeTileRecordToDb(record: OverpassTileRecord) {
  const db = await openOverpassDb();
  if (!db) {
    memoryDbFallback.set(record.key, record);
    return;
  }
  return new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(OVERPASS_DB_STORE, 'readwrite');
      const store = tx.objectStore(OVERPASS_DB_STORE);
      store.put(record);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    } catch {
      resolve();
    }
  });
}

function buildOverpassQueryForBbox(bbox: BboxSnapshot) {
  return [
    `[out:json][timeout:${Math.trunc(OVERPASS_TILE_REQUEST_TIMEOUT_MS / 1000)}];`,
    '(',
    `  way["building"](${bbox.south},${bbox.west},${bbox.north},${bbox.east});`,
    `  relation["building"](${bbox.south},${bbox.west},${bbox.north},${bbox.east});`,
    `  way["building:part"](${bbox.south},${bbox.west},${bbox.north},${bbox.east});`,
    `  relation["building:part"](${bbox.south},${bbox.west},${bbox.north},${bbox.east});`,
    ');',
    'out body geom;'
  ].join('\n');
}

async function fetchOverpassJson(endpoint: string, query: string, signal?: AbortSignal | null) {
  const requestBody = new URLSearchParams({
    data: query
  }).toString();
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
      'Accept': 'application/json'
    },
    body: requestBody,
    signal: signal || undefined,
    cache: 'no-store'
  });
  if (!response.ok) {
    coolDownOverpassEndpoint(endpoint, response.status);
    throw createOverpassEndpointHttpError(endpoint, response.status);
  }
  return response.json();
}

function getOverpassEndpointRoster() {
  clearExpiredOverpassEndpointCooldowns();
  const preferred = workingEndpoint || getLastWorkingEndpoint();
  const availableEndpoints = OVERPASS_ENDPOINTS.filter((endpoint) => !isOverpassEndpointCoolingDown(endpoint));
  const rosterSource = availableEndpoints.length > 0 ? availableEndpoints : [...OVERPASS_ENDPOINTS];
  const roster = preferred && rosterSource.includes(preferred) ? [preferred] : [];
  for (const endpoint of rosterSource) {
    if (!roster.includes(endpoint)) {
      roster.push(endpoint);
    }
  }
  return roster.length > 0 ? roster : [...OVERPASS_ENDPOINTS];
}

function getCurrentOverpassEndpoint() {
  return getOverpassEndpointRoster()[0] || workingEndpoint || getLastWorkingEndpoint() || '';
}

function buildFeatureCollection() {
  if (lastRenderedFeatureCollectionVersion === featureCollectionVersion) {
    return lastRenderedFeatureCollection;
  }
  const features = applyBuildingPartBaseSuppression([...cachedFeatureIndex.entries()]
    .sort((left, right) => Number(left[1]?.updatedAt || 0) - Number(right[1]?.updatedAt || 0))
    .map(([, entry]) => entry.feature));
  lastRenderedFeatureCollection = {
    type: 'FeatureCollection',
    features
  };
  lastRenderedFeatureCollectionVersion = featureCollectionVersion;
  return lastRenderedFeatureCollection;
}

function buildSearchItemFromFeature(feature: OverpassGeoJsonFeature) {
  return buildOverpassSearchItem(feature);
}

function normalizeViewportContext(input: {
  viewport?: unknown;
  zoom?: number | string | null;
  covered?: boolean | null;
} = {}) {
  const viewport = normalizeBbox(input.viewport);
  const zoom = Number(input.zoom);
  const covered = Boolean(input.covered);
  return {
    viewport,
    zoom: Number.isFinite(zoom) ? zoom : OVERPASS_MIN_LOAD_ZOOM,
    covered
  } satisfies OverpassViewportContext;
}

async function loadCachedTilesForViewport(context: OverpassViewportContext) {
  const plan = getViewportTilePlan(context.viewport, context.zoom);
  if (plan.tiles.length === 0) {
    return {
      missingTiles: [] as Array<{ key: string; bbox: BboxSnapshot }>,
      loadedTiles: [] as Array<{ key: string; bbox: BboxSnapshot }>
    };
  }

  const loadedTiles: Array<{ key: string; bbox: BboxSnapshot }> = [];
  const missingTiles: Array<{ key: string; bbox: BboxSnapshot }> = [];

  for (const tile of plan.tiles) {
    const memoryRecord = memoryTileCache.get(tile.key);
    if (memoryRecord) {
      loadedTiles.push(tile);
      addTileKeyAccess(tile.key);
      continue;
    }

    const cachedRecord = await readTileRecordFromDb(tile.key);
    if (cachedRecord?.features) {
      ingestTileRecord(tile.key, {
        key: tile.key,
        bbox: cachedRecord.bbox || tile.bbox,
        fetchedAt: Number(cachedRecord.fetchedAt || Date.now()),
        features: Array.isArray(cachedRecord.features) ? cachedRecord.features : []
      });
      pruneMemoryTileCache();
      loadedTiles.push(tile);
      continue;
    }

    missingTiles.push(tile);
  }

  return {
    plan,
    loadedTiles,
    missingTiles
  };
}

function updateViewportState({
  context,
  plan,
  loadedTiles,
  missingTiles
}: {
  context: OverpassViewportContext;
  plan: ReturnType<typeof getViewportTilePlan>;
  loadedTiles: Array<{ key: string; bbox: BboxSnapshot }>;
  missingTiles: Array<{ key: string; bbox: BboxSnapshot }>;
}) {
  const currentLoading = Boolean(get(overpassBuildingsState).loading);
  const featureCount = cachedFeatureIndex.size;
  const promptVisible = Boolean(!context.covered && (plan.tooCoarse || missingTiles.length > 0));
  const canLoad = Boolean(!context.covered && !plan.tooCoarse && missingTiles.length > 0 && !currentLoading);
  const messageKey: OverpassRequestState['messageKey'] = context.covered
    ? 'idle'
    : (plan.tooCoarse
      ? 'zoomIn'
      : (missingTiles.length > 0 ? 'loadArea' : 'cacheReady'));
  const message = context.covered
    ? ''
    : (plan.tooCoarse
      ? translateNow('mapPage.overpassFallback.zoomIn')
      : (missingTiles.length > 0
        ? translateNow('mapPage.overpassFallback.loadArea')
        : translateNow('mapPage.overpassFallback.cacheReady')));

  patchOverpassState({
    phase: 'ready',
    loading: false,
    promptVisible,
    canLoad,
    messageKey,
    message,
    error: '',
    progressDone: 0,
    progressTotal: 0,
    viewportHash: context.viewport ? `${buildBboxHash(context.viewport)}:${plan.tileZoom}` : '',
    tileZoom: plan.tileZoom,
    covered: context.covered,
    featureCount,
    tileCount: memoryTileCache.size,
    dataVersion: featureCollectionVersion,
    endpoint: getCurrentOverpassEndpoint(),
    lastUpdatedAt: Date.now()
  });

  return {
    promptVisible,
    canLoad,
    messageKey,
    message,
    loadedTiles,
    missingTiles
  };
}

export function getOverpassFeatureCollection() {
  return buildFeatureCollection();
}

export function getOverpassBuildingFeature(osmKey: string) {
  const normalizedKey = String(osmKey || '').trim();
  if (!normalizedKey) return null;
  const entry = cachedFeatureIndex.get(normalizedKey);
  return entry?.feature || null;
}

export function getOverpassBuildingSearchItem(osmKey: string) {
  const feature = getOverpassBuildingFeature(osmKey);
  return feature ? buildSearchItemFromFeature(feature) : null;
}

export function getOverpassBuildingDetails(osmKeyOrFeature: string | OverpassGeoJsonFeature | null | undefined) {
  if (!osmKeyOrFeature) return null;
  const feature = typeof osmKeyOrFeature === 'string'
    ? getOverpassBuildingFeature(osmKeyOrFeature)
    : osmKeyOrFeature;
  return feature ? buildOverpassBuildingDetails(feature) : null;
}

export function getOverpassBuildingFilterData(osmKey: string) {
  const feature = getOverpassBuildingFeature(osmKey);
  return feature ? buildOverpassFilterDataItem(feature) : null;
}

export async function scheduleOverpassViewportRefresh(input: {
  viewport?: unknown;
  zoom?: number | string | null;
  covered?: boolean | null;
  force?: boolean;
} = {}) {
  latestViewportContext = normalizeViewportContext(input);
  if (viewportRefreshTimer) {
    clearTimeout(viewportRefreshTimer);
    viewportRefreshTimer = null;
  }
  if (!input.force) {
    viewportRefreshTimer = globalThis.setTimeout(() => {
      viewportRefreshTimer = null;
      const context = latestViewportContext || normalizeViewportContext(input);
      if (get(overpassBuildingsState).loading) {
        return;
      }
      void refreshOverpassViewport(context);
    }, OVERPASS_VIEWPORT_REFRESH_DEBOUNCE_MS);
    return;
  }
  await refreshOverpassViewport(latestViewportContext);
}

export async function refreshOverpassViewport(contextInput: OverpassViewportContext | null | undefined) {
  const context = normalizeViewportContext(contextInput || {});
  if (!context.viewport) {
    patchOverpassState({
      phase: 'idle',
      loading: false,
      promptVisible: false,
      canLoad: false,
      messageKey: 'idle',
      message: '',
      error: '',
      progressDone: 0,
      progressTotal: 0,
      viewportHash: '',
      tileZoom: OVERPASS_MIN_LOAD_ZOOM,
      covered: context.covered,
      featureCount: cachedFeatureIndex.size,
      tileCount: memoryTileCache.size,
      dataVersion: featureCollectionVersion,
      endpoint: getCurrentOverpassEndpoint(),
      lastUpdatedAt: Date.now()
    });
    return;
  }

  if (context.covered) {
    updateViewportState({
      context,
      plan: getViewportTilePlan(context.viewport, context.zoom),
      loadedTiles: [],
      missingTiles: []
    });
    return;
  }

  const plan = getViewportTilePlan(context.viewport, context.zoom);
  if (plan.tooCoarse) {
    updateViewportState({
      context,
      plan,
      loadedTiles: [],
      missingTiles: plan.tiles
    });
    return;
  }

  const { loadedTiles, missingTiles } = await loadCachedTilesForViewport(context);
  updateViewportState({
    context,
    plan,
    loadedTiles,
    missingTiles
  });
}

async function fetchTileRecordFromOverpass(tile: { key: string; bbox: BboxSnapshot }, signal?: AbortSignal | null, endpoint?: string | null) {
  const targetEndpoint = String(endpoint || '').trim() || getOverpassEndpointRoster()[0];
  const query = buildOverpassQueryForBbox(tile.bbox);
  const raw = await fetchOverpassJson(targetEndpoint, query, signal);
  const geojson = osmtogeojson(raw, {
    flatProperties: false
  }) as OverpassGeoJsonFeatureCollection;
  return {
    key: tile.key,
    bbox: tile.bbox,
    fetchedAt: Date.now(),
    features: Array.isArray(geojson?.features) ? geojson.features : []
  } satisfies OverpassTileRecord;
}

async function fetchTileRecordWithEndpointFallback(
  tile: { key: string; bbox: BboxSnapshot },
  signal: AbortSignal | null | undefined,
  startIndex = 0
) {
  const roster = getOverpassEndpointRoster();
  let lastError: unknown = null;

  for (let attempt = 0; attempt < roster.length; attempt += 1) {
    const endpoint = roster[(startIndex + attempt) % roster.length];
    try {
      const record = await fetchTileRecordFromOverpass(tile, signal, endpoint);
      if (!workingEndpoint || (startIndex === 0 && attempt > 0)) {
        rememberWorkingEndpoint(endpoint);
      }
      return record;
    } catch (error) {
      lastError = error;
      if (error?.name === 'AbortError') {
        throw error;
      }
      const status = Number(error?.status || 0);
      if (Number.isFinite(status) && status > 0) {
        coolDownOverpassEndpoint(endpoint, status);
      }
    }
  }

  throw lastError || new Error('Failed to fetch Overpass tile');
}

async function loadMissingTilesForViewport(context: OverpassViewportContext, {
  forceRefresh = false
}: {
  forceRefresh?: boolean;
} = {}) {
  const normalizedContext = normalizeViewportContext(context);
  latestViewportContext = normalizedContext;
  if (forceRefresh) {
    await evictViewportTiles(normalizedContext);
  }

  const plan = getViewportTilePlan(normalizedContext.viewport, normalizedContext.zoom);
  if (plan.tiles.length === 0) {
    return {
      plan,
      missingTiles: [] as Array<{ key: string; bbox: BboxSnapshot }>
    };
  }

  const cached = await loadCachedTilesForViewport(normalizedContext);
  const missingTiles = cached.missingTiles;
  if (missingTiles.length === 0) {
    updateViewportState({
      context: normalizedContext,
      plan,
      loadedTiles: cached.loadedTiles,
      missingTiles
    });
    return {
      plan,
      missingTiles
    };
  }

  if (plan.tooCoarse) {
    return {
      plan,
      missingTiles
    };
  }

  const token = ++activeLoadToken;
  if (activeLoadAbortController) {
    activeLoadAbortController.abort();
  }
  activeLoadAbortController = new AbortController();
  const signal = activeLoadAbortController.signal;
  patchOverpassState({
    phase: 'loading',
    loading: true,
    promptVisible: true,
    canLoad: false,
    messageKey: 'loading',
    message: translateNow('mapPage.overpassFallback.loading'),
    error: '',
    progressDone: 0,
    progressTotal: missingTiles.length,
    viewportHash: normalizedContext.viewport ? `${buildBboxHash(normalizedContext.viewport)}:${plan.tileZoom}` : '',
    tileZoom: plan.tileZoom,
    covered: normalizedContext.covered,
    endpoint: getCurrentOverpassEndpoint(),
    lastUpdatedAt: Date.now()
  });

  const workerCount = Math.max(1, Math.min(OVERPASS_TILE_FETCH_CONCURRENCY, missingTiles.length));
  let nextTileIndex = 0;
  let completed = 0;
  let failedTiles = 0;

  const runWorker = async () => {
    while (true) {
      if (signal.aborted || token !== activeLoadToken) break;
      const tileIndex = nextTileIndex;
      nextTileIndex += 1;
      if (tileIndex >= missingTiles.length) break;
      const tile = missingTiles[tileIndex];
      try {
        const record = await fetchTileRecordWithEndpointFallback(tile, signal);
        await writeTileRecordToDb(record);
        ingestTileRecord(tile.key, record);
        pruneMemoryTileCache();
        const syncedAt = Date.now();
        setLastSyncedAt(syncedAt);
        patchOverpassState({
          lastSyncedAt: syncedAt
        });
      } catch (error) {
        failedTiles += 1;
        if (error?.name === 'AbortError') break;
        // keep going so we can fill the rest of the viewport if another tile succeeds
      } finally {
        completed += 1;
        patchOverpassState({
          progressDone: completed,
          progressTotal: missingTiles.length,
          dataVersion: featureCollectionVersion,
          featureCount: cachedFeatureIndex.size,
          tileCount: memoryTileCache.size,
          lastUpdatedAt: Date.now()
        });
      }
    }
  };

  await Promise.all(Array.from({ length: workerCount }, () => runWorker()));

  if (activeLoadAbortController?.signal === signal) {
    activeLoadAbortController = null;
  }

  if (signal.aborted || token !== activeLoadToken) {
    return {
      plan,
      missingTiles
    };
  }

  const nextViewportContext = latestViewportContext && !areViewportContextsEqual(latestViewportContext, normalizedContext)
    ? latestViewportContext
    : null;
  if (nextViewportContext) {
    await refreshOverpassViewport(nextViewportContext);
    return {
      plan,
      missingTiles
    };
  }

  const refreshed = await loadCachedTilesForViewport(normalizedContext);
  const nextState = updateViewportState({
    context: normalizedContext,
    plan,
    loadedTiles: refreshed.loadedTiles,
    missingTiles: refreshed.missingTiles
  });
  if (failedTiles > 0) {
    patchOverpassState({
      phase: 'error',
      loading: false,
      messageKey: 'error',
      error: translateNow('mapPage.overpassFallback.loadFailed'),
      promptVisible: nextState.promptVisible || refreshed.missingTiles.length > 0,
      canLoad: nextState.canLoad,
      lastSyncedAt: getLastSyncedAt()
    });
  } else {
    patchOverpassState({
      phase: 'ready',
      loading: false,
      messageKey: nextState.messageKey,
      error: '',
      promptVisible: nextState.promptVisible,
      canLoad: nextState.canLoad,
      lastSyncedAt: getLastSyncedAt()
    });
  }
}

function abortActiveOverpassLoad() {
  activeLoadAbortController?.abort();
  activeLoadAbortController = null;
  activeLoadToken += 1;
  patchOverpassState({
    phase: 'idle',
    loading: false,
    messageKey: 'idle',
    progressDone: 0,
    progressTotal: 0,
    message: '',
    error: ''
  });
}

export async function requestOverpassViewportLoad(input: {
  viewport?: unknown;
  zoom?: number | string | null;
  covered?: boolean | null;
} = {}) {
  const context = normalizeViewportContext(input);
  if (!context.viewport || context.covered) return;
  if (viewportRefreshTimer) {
    clearTimeout(viewportRefreshTimer);
    viewportRefreshTimer = null;
  }
  await loadMissingTilesForViewport(context);
}

export async function refreshOverpassViewportData(input: {
  viewport?: unknown;
  zoom?: number | string | null;
  covered?: boolean | null;
} = {}) {
  const context = normalizeViewportContext(input);
  if (!context.viewport || context.covered) return;
  if (viewportRefreshTimer) {
    clearTimeout(viewportRefreshTimer);
    viewportRefreshTimer = null;
  }
  await loadMissingTilesForViewport(context, { forceRefresh: true });
}

export async function clearOverpassCache() {
  if (viewportRefreshTimer) {
    clearTimeout(viewportRefreshTimer);
    viewportRefreshTimer = null;
  }
  abortActiveOverpassLoad();
  setLastSyncedAt(0);
  memoryTileCache = new Map();
  cachedFeatureIndex = new Map();
  tileKeyAccessOrder = [];
  memoryDbFallback = new Map();
  featureCollectionVersion = 0;
  lastRenderedFeatureCollectionVersion = -1;
  lastRenderedFeatureCollection = OVERPASS_EMPTY_COLLECTION;
  await clearTileRecordsFromDb();

  const endpoint = getCurrentOverpassEndpoint();
  const context = latestViewportContext;
  patchOverpassState({
    ...initialState,
    loading: false,
    promptVisible: false,
    canLoad: false,
    messageKey: 'idle',
    message: '',
    error: '',
    progressDone: 0,
    progressTotal: 0,
    viewportHash: '',
    tileZoom: OVERPASS_MIN_LOAD_ZOOM,
    covered: context?.covered ?? true,
    featureCount: 0,
    tileCount: 0,
    dataVersion: featureCollectionVersion,
    endpoint,
    lastSyncedAt: 0
  });

  if (context) {
    await refreshOverpassViewport(context);
  }
}

export function cancelOverpassViewportLoad() {
  if (viewportRefreshTimer) {
    clearTimeout(viewportRefreshTimer);
    viewportRefreshTimer = null;
  }
  abortActiveOverpassLoad();
  if (latestViewportContext) {
    void refreshOverpassViewport(latestViewportContext);
  }
}

export function resetOverpassState() {
  if (viewportRefreshTimer) {
    clearTimeout(viewportRefreshTimer);
    viewportRefreshTimer = null;
  }
  abortActiveOverpassLoad();
  latestViewportContext = null;
  patchOverpassState({
    ...initialState,
    lastSyncedAt: getLastSyncedAt()
  });
}

export function searchOverpassBuildings(query: string, {
  viewport = null,
  limit = 250
}: {
  viewport?: unknown;
  limit?: number;
} = {}) {
  const text = String(query || '').trim().toLowerCase();
  if (text.length < 2) return [];
  const viewportBbox = normalizeBbox(viewport);
  const items: Array<{ item: Record<string, unknown>; score: number }> = [];
  for (const entry of cachedFeatureIndex.values()) {
    const feature = entry.feature;
    const props = feature?.properties || {};
    const searchText = String(props?.search_text || '').toLowerCase();
    if (!searchText.includes(text)) continue;
    const lon = Number(props?.center_lon);
    const lat = Number(props?.center_lat);
    if (viewportBbox && (!Number.isFinite(lon) || !Number.isFinite(lat))) {
      continue;
    }
    if (viewportBbox && Number.isFinite(lon) && Number.isFinite(lat)) {
      const inside = lon >= viewportBbox.west
        && lon <= viewportBbox.east
        && lat >= viewportBbox.south
        && lat <= viewportBbox.north;
      if (!inside) continue;
    }
    const item = buildSearchItemFromFeature(feature);
    if (!item) continue;
    const scoreParts = [
      String(item.name || '').toLowerCase().includes(text) ? 6 : 0,
      String(item.address || '').toLowerCase().includes(text) ? 5 : 0,
      String(item.style || '').toLowerCase().includes(text) ? 4 : 0,
      String(item.architect || '').toLowerCase().includes(text) ? 3 : 0,
      String(item.designRef || '').toLowerCase().includes(text) ? 2 : 0,
      searchText.includes(text) ? 1 : 0
    ];
    items.push({
      item,
      score: scoreParts.reduce((sum, value) => sum + value, 0)
    });
  }

  return items
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      return String(left.item?.name || '').localeCompare(String(right.item?.name || ''), 'en');
    })
    .slice(0, Math.max(1, Math.trunc(Number(limit) || 250)))
    .map((entry) => entry.item);
}

export function getOverpassFilterDataForLoadedFeature(feature: OverpassGeoJsonFeature) {
  return buildOverpassFilterDataItem(feature);
}

export function getOverpassStateSnapshot() {
  return get(overpassBuildingsState);
}
