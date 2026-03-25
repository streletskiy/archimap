import { get, type Writable } from 'svelte/store';

import { apiJson } from '$lib/services/http';

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

type DataTranslator = (key: string, params?: LooseRecord) => string;

type RegionControllerArgs = {
  dataSettings: Writable<LooseRecord>;
  dataStatus: Writable<string>;
  regionDraft: Writable<LooseRecord>;
  regionResolveBusy: Writable<boolean>;
  regionExtractCandidates: Writable<LooseRecord[]>;
  patchRegionDraft: (patch: LooseRecord) => void;
  dataT: DataTranslator;
};

function createMapRegionController({
  dataSettings,
  dataStatus,
  regionDraft,
  regionResolveBusy,
  regionExtractCandidates,
  patchRegionDraft,
  dataT
}: RegionControllerArgs) {
  const regionLookupCache = new WeakMap();

  function getMapRegionFeatureMeta(feature: LooseRecord | null) {
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

  function getRegionLookup(regions: LooseRecord[] = []) {
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

  function findRegionByMapFeature(feature: LooseRecord | null, regions: LooseRecord[] | null = null) {
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

  function applyRegionDraftFromMapFeature(feature: LooseRecord | null) {
    const meta = getMapRegionFeatureMeta(feature);
    if (!meta.name && !meta.slug && !meta.extractId) return false;

    patchRegionDraft({
      name: meta.name,
      slug: meta.slug,
      searchQuery: meta.name || meta.slug || meta.extractId,
      extractSource: meta.extractSource || 'osmfr',
      extractId: meta.extractId,
      extractLabel: meta.name || meta.extractId,
      extractResolutionStatus: meta.extractId ? 'resolved' : 'needs_resolution',
      extractResolutionError: null
    });
    regionResolveBusy.set(false);
    regionExtractCandidates.set([]);
    dataStatus.set(meta.name ? dataT('status.mapRegionSelected', { name: meta.name }) : dataT('status.mapRegionSelectedFallback'));
    return true;
  }

  function clearRegionExtractSelection() {
    patchRegionDraft({
      extractSource: '',
      extractId: '',
      extractLabel: '',
      extractResolutionStatus: 'needs_resolution',
      extractResolutionError: null
    });
  }

  function applyRegionExtractCandidate(candidate: LooseRecord | null, options: LooseRecord = {}) {
    const next = candidate && typeof candidate === 'object' ? candidate : {};
    patchRegionDraft({
      extractSource: String(next.extractSource || '').trim(),
      extractId: String(next.extractId || '').trim(),
      extractLabel: String(next.extractLabel || '').trim(),
      extractResolutionStatus: 'resolved',
      extractResolutionError: null
    });
    if (options.setStatus !== false) {
      dataStatus.set(dataT('status.extractSelected'));
    }
  }

  function handleRegionSearchQueryInput(event: { currentTarget?: { value?: string } } | null) {
    const nextValue = String(event?.currentTarget?.value || '');
    const currentDraft = get(regionDraft);
    const searchChanged = nextValue !== String(currentDraft.searchQuery || '');

    patchRegionDraft({
      searchQuery: nextValue
    });
    if (searchChanged && (currentDraft.extractId || currentDraft.extractSource)) {
      clearRegionExtractSelection();
    }
    regionExtractCandidates.set([]);
  }

  async function resolveRegionExtractCandidates() {
    const query = String(get(regionDraft).searchQuery || '').trim();
    if (!query) {
      dataStatus.set(dataT('status.resolveExtractMissingQuery'));
      regionExtractCandidates.set([]);
      clearRegionExtractSelection();
      return;
    }

    regionResolveBusy.set(true);
    dataStatus.set(dataT('status.resolvingExtract'));

    try {
      const data = await apiJson('/api/admin/app-settings/data/regions/resolve-extract', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query })
      });
      const items = Array.isArray(data?.items) ? data.items : [];
      regionExtractCandidates.set(items);

      if (items.length === 1) {
        applyRegionExtractCandidate(items[0], { setStatus: false });
        dataStatus.set(dataT('status.extractResolvedSingle'));
        return;
      }

      clearRegionExtractSelection();
      dataStatus.set(
        items.length > 0 ? dataT('status.extractCandidatesLoaded', { count: items.length }) : dataT('status.resolveExtractNoMatches')
      );
    } catch (error) {
      regionExtractCandidates.set([]);
      clearRegionExtractSelection();
      dataStatus.set(String(error?.message || dataT('status.resolveExtractFailed')));
    } finally {
      regionResolveBusy.set(false);
    }
  }

  function getRegionSyncState(region) {
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
    applyRegionExtractCandidate,
    handleRegionSearchQueryInput,
    resolveRegionExtractCandidates,
    getRegionSyncState
  };
}

export { createMapRegionController };
