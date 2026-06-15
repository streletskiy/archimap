import { get, type Writable } from 'svelte/store';

import {
  MAP_REGION_EXTRACT_ID_KEYS,
  MAP_REGION_EXTRACT_SOURCE_KEYS,
  MAP_REGION_NAME_KEYS,
  MAP_REGION_SLUG_KEYS,
  buildRegionExtractIdentity,
  getRecordTextValue,
  normalizeLookupValue,
  slugifyLoose
} from './admin-data.shared';
import type { AdminDataSettings, Region as DataRegion, RegionDraft } from '$shared/types';

type DataTranslator = (key: string, params?: LooseRecord) => string;
type FeatureLike = { properties?: Record<string, unknown> | null } | null;

type RegionControllerArgs = {
  dataSettings: Writable<AdminDataSettings>;
  dataStatus: Writable<string>;
  regionDraft: Writable<RegionDraft>;
  patchRegionDraft: (patch: Partial<RegionDraft>) => void;
  dataT: DataTranslator;
};

function createMapRegionController({
  dataSettings,
  dataStatus,
  patchRegionDraft,
  dataT
}: RegionControllerArgs) {
  const regionLookupCache = new WeakMap();

  function getMapRegionFeatureMeta(feature: FeatureLike) {
    const properties = feature?.properties && typeof feature.properties === 'object' ? feature.properties : {};
    const name = getRecordTextValue(properties, MAP_REGION_NAME_KEYS);
    const slug = getRecordTextValue(properties, MAP_REGION_SLUG_KEYS) || slugifyLoose(name);
    const extractId = getRecordTextValue(properties, MAP_REGION_EXTRACT_ID_KEYS);
    const extractSource = getRecordTextValue(properties, MAP_REGION_EXTRACT_SOURCE_KEYS) || 'osmfr';

    return {
      name,
      slug,
      extractSource,
      extractId
    };
  }

  function getRegionLookup(regions: DataRegion[] = []) {
    const items = Array.isArray(regions) ? regions : [];
    const cached = regionLookupCache.get(items);
    if (cached) return cached;

    const bySlug = new Map();
    const byExtractIdentity = new Map();
    const byExtractId = new Map();

    for (const region of items) {
      const slug = normalizeLookupValue(region?.slug);
      const extractId = normalizeLookupValue(region?.extractId);
      const extractIdentity = buildRegionExtractIdentity(region?.extractSource, region?.extractId);

      if (slug && !bySlug.has(slug)) {
        bySlug.set(slug, region);
      }

      if (extractIdentity && !byExtractIdentity.has(extractIdentity)) {
        byExtractIdentity.set(extractIdentity, region);
      }

      if (extractId) {
        const current = byExtractId.get(extractId);
        if (current) {
          current.push(region);
        } else {
          byExtractId.set(extractId, [region]);
        }
      }
    }

    const nextLookup = {
      bySlug,
      byExtractIdentity,
      byExtractId
    };
    regionLookupCache.set(items, nextLookup);
    return nextLookup;
  }

  function findRegionByMapFeature(feature: FeatureLike, regions: DataRegion[] | null = null) {
    const items = Array.isArray(regions) ? regions : get(dataSettings).regions;
    const meta = getMapRegionFeatureMeta(feature);
    const featureSlug = normalizeLookupValue(meta.slug);
    const featureExtractSource = normalizeLookupValue(meta.extractSource);
    const featureExtractId = normalizeLookupValue(meta.extractId);
    const featureExtractIdentity = buildRegionExtractIdentity(meta.extractSource, meta.extractId);
    const lookup = getRegionLookup(items);

    if (featureSlug && lookup.bySlug.has(featureSlug)) {
      return lookup.bySlug.get(featureSlug) || null;
    }

    if (featureExtractIdentity && lookup.byExtractIdentity.has(featureExtractIdentity)) {
      return lookup.byExtractIdentity.get(featureExtractIdentity) || null;
    }

    if (featureExtractId) {
      const candidates = lookup.byExtractId.get(featureExtractId) || [];
      for (const region of candidates) {
        const regionExtractSource = normalizeLookupValue(region?.extractSource);
        if (!featureExtractSource || !regionExtractSource || regionExtractSource === featureExtractSource) {
          return region;
        }
      }
    }

    return null;
  }

  function applyRegionDraftFromMapFeature(feature: FeatureLike) {
    const meta = getMapRegionFeatureMeta(feature);
    if (!meta.name && !meta.slug && !meta.extractId) return false;

    patchRegionDraft({
      name: meta.name,
      slug: meta.slug,
      extractSource: meta.extractSource || 'osmfr',
      extractId: meta.extractId,
      extractLabel: meta.name || meta.extractId,
      extractResolutionStatus: meta.extractId ? 'resolved' : 'needs_resolution',
      extractResolutionError: null
    });
    dataStatus.set(
      meta.name ? dataT('status.mapRegionSelected', { name: meta.name }) : dataT('status.mapRegionSelectedFallback')
    );
    return true;
  }

  function getRegionSyncState(region: Partial<DataRegion> | null) {
    const code = String(region?.lastSyncStatus || '')
      .trim()
      .toLowerCase();
    if (code === 'running' || code === 'queued') return 'syncing';
    if (code === 'success') return 'ready';
    if (code === 'idle' && region?.lastSuccessfulSyncAt) return 'ready';
    if (code === 'failed' || code === 'abandoned') return 'failed';
    return 'pending';
  }

  return {
    getMapRegionFeatureMeta,
    getRegionLookup,
    findRegionByMapFeature,
    applyRegionDraftFromMapFeature,
    getRegionSyncState
  };
}

export { createMapRegionController };
