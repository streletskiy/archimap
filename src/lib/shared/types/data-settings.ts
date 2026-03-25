import type { FilterPreset, FilterPresetInput, FilterPresetState } from './filter-presets';
import type { OsmElementType } from './common';

export type RegionResolutionStatus =
  | 'resolved'
  | 'needs_resolution'
  | 'resolution_required'
  | 'resolution_error';

export type RegionSourceType = 'extract';

export interface RegionBounds {
  west: number;
  south: number;
  east: number;
  north: number;
}

export interface Region {
  id: number;
  slug: string;
  name: string;
  sourceType: RegionSourceType;
  searchQuery: string;
  extractSource: string;
  extractId: string;
  extractLabel: string | null;
  extractResolutionStatus: RegionResolutionStatus;
  extractResolutionError: string | null;
  resolutionRequired: boolean;
  canSync: boolean;
  enabled: boolean;
  autoSyncEnabled: boolean;
  autoSyncOnStart: boolean;
  autoSyncIntervalHours: number;
  pmtilesMinZoom: number;
  pmtilesMaxZoom: number;
  sourceLayer: string;
  lastSyncStartedAt: string | null;
  lastSyncFinishedAt: string | null;
  lastSyncStatus: string;
  lastSyncError: string | null;
  lastSuccessfulSyncAt: string | null;
  nextSyncAt: string | null;
  bounds: RegionBounds | null;
  lastFeatureCount: number | null;
  pmtilesBytes: number | null;
  dbBytes: number | null;
  dbBytesApproximate: boolean;
  updatedBy: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  __optimistic?: boolean;
}

export interface RegionDraft {
  id: number | null;
  name: string;
  slug: string;
  searchQuery: string;
  extractSource: string;
  extractId: string;
  extractLabel: string;
  extractResolutionStatus: RegionResolutionStatus;
  extractResolutionError: string | null;
  enabled: boolean;
  autoSyncEnabled: boolean;
  autoSyncOnStart: boolean;
  autoSyncIntervalHours: number;
  pmtilesMinZoom: number;
  pmtilesMaxZoom: number;
  sourceLayer: string;
}

export interface RegionInput {
  id?: number | string | null;
  name?: string;
  slug?: string;
  searchQuery?: string;
  search_query?: string;
  extractSource?: string;
  extract_source?: string;
  extractId?: string;
  extract_id?: string;
  extractLabel?: string;
  extract_label?: string;
  sourceType?: string;
  source_type?: string;
  sourceValue?: string;
  source_value?: string;
  enabled?: boolean | number | string;
  autoSyncEnabled?: boolean | number | string;
  autoSyncOnStart?: boolean | number | string;
  autoSyncIntervalHours?: number | string;
  pmtilesMinZoom?: number | string;
  pmtilesMaxZoom?: number | string;
  sourceLayer?: string;
}

export interface RegionExtractCandidate {
  extractSource: string;
  extractId: string;
  extractLabel: string;
  downloadUrl: string | null;
  matchKind: string | null;
  exact: boolean;
}

export interface RegionExtractSearchResult {
  query: string;
  items: RegionExtractCandidate[];
}

export interface RegionExtractValidationResult {
  candidate: RegionExtractCandidate | null;
  error: string | null;
}

export interface DataSettingsBootstrapState {
  completed: boolean;
  source: string | null;
}

export interface FilterTagAllowlistState {
  source: string;
  allowlist: string[];
  defaultAllowlist: string[];
  availableKeys: string[];
  updatedBy: string | null;
  updatedAt: string | null;
}

export interface AdminDataSettings {
  source: string;
  bootstrap: DataSettingsBootstrapState;
  regions: Region[];
  filterTags: FilterTagAllowlistState;
  filterPresets: FilterPresetState;
}

export interface AdminDataSettingsPayload {
  source: string;
  bootstrap: DataSettingsBootstrapState;
  regions: Region[];
  filterTags: FilterTagAllowlistState;
  filterPresets: FilterPresetState;
}

export type RegionWithStorageStats = Region;
export type RegionSaveInput = RegionInput;
export type FilterPresetSaveInput = FilterPresetInput;

export type RegionTarget = Pick<Region, 'id' | 'slug' | 'extractSource' | 'extractId' | 'name'> | null;

export type RegionIdentity = {
  slug?: string | null;
  extractSource?: string | null;
  extractId?: string | null;
};

export type RegionSourceTypeName = OsmElementType;
