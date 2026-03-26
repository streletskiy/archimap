import type { OsmElementType, UnknownRecord } from './common';

export type BuildingEditKnownStatus =
  | 'pending'
  | 'accepted'
  | 'partially_accepted'
  | 'rejected'
  | 'superseded'
  | 'withdrawn'
  | (string & {});

export type BuildingEditSyncStatus =
  | 'unsynced'
  | 'syncing'
  | 'synced'
  | 'cleaned'
  | 'failed'
  | (string & {});

export interface BuildingEditFieldChange {
  field: string;
  label: string;
  osmTag: string | null;
  osmValue: string | number | null;
  localValue: string | number | null;
}

export interface BuildingEditValueMap {
  name: string | null;
  style: string | null;
  design: string | null;
  design_ref: string | null;
  design_year: string | number | null;
  material: string | null;
  material_raw: string | null;
  material_concrete: string | null;
  colour: string | null;
  levels: string | number | null;
  year_built: string | number | null;
  architect: string | null;
  address: string | null;
  archimap_description: string | null;
}

export interface BuildingEditMergedInfo {
  name: string | null;
  style: string | null;
  design: string | null;
  design_ref: string | null;
  design_year: string | number | null;
  material: string | null;
  material_concrete: string | null;
  colour: string | null;
  levels: string | number | null;
  year_built: string | number | null;
  architect: string | null;
  address: string | null;
  description: string | null;
  archimap_description: string | null;
  updated_by: string | null;
  updated_at: string | null;
}

export interface BuildingEditSummary {
  id: number;
  editId: number;
  osmType: OsmElementType;
  osmId: number;
  updatedBy: string | null;
  updatedAt: string | null;
  createdAt: string | null;
  status: BuildingEditKnownStatus;
  osmPresent: boolean;
  syncStatus: BuildingEditSyncStatus;
  syncAttemptedAt: string | null;
  syncSucceededAt: string | null;
  syncCleanedAt: string | null;
  syncChangesetId: string | number | null;
}

export interface BuildingEdit {
  editId: number;
  osmType: OsmElementType;
  osmId: number;
  updatedBy: string | null;
  updatedAt: string | null;
  createdAt: string | null;
  status: BuildingEditKnownStatus;
  adminComment: string | null;
  reviewedBy: string | null;
  reviewedAt: string | null;
  mergedBy: string | null;
  mergedAt: string | null;
  sourceOsmVersion: string | number | null;
  osmPresent: boolean;
  orphaned: boolean;
  hasMergedLocal: boolean;
  sourceOsmChanged: boolean;
  canReassign: boolean;
  canHardDelete: boolean;
  hardDeleteBlockedReason: string | null;
  mergedEditsForTarget: number;
  sourceOsmUpdatedAt: string | null;
  currentOsmUpdatedAt: string | null;
  syncStatus: BuildingEditSyncStatus;
  syncReadOnly: boolean;
  syncAttemptedAt: string | null;
  syncSucceededAt: string | null;
  syncCleanedAt: string | null;
  syncChangesetId: string | number | null;
  syncSummary: UnknownRecord | null;
  syncError: string | null;
  displayAddress?: string | null;
  editedFields: string[] | null;
  mergedFields: string[] | null;
  values: BuildingEditValueMap;
  changes: BuildingEditFieldChange[];
  tags?: Record<string, string>;
  currentTags?: Record<string, string>;
  sourceTags?: Record<string, string>;
  latestMerged?: BuildingEditMergedInfo | null;
}

export interface BuildingEditListQuery {
  status?: string;
  limit?: number;
}

export interface BuildingEditMergeValues extends Partial<BuildingEditValueMap> {
  material_concrete?: string | null;
}

export interface BuildingEditMergeCandidate {
  currentMerged: BuildingEditMergedInfo & {
    osm_type?: string;
    osm_id?: number;
  };
  editCreatedTs: number;
  currentMergedTs: number;
  editSource: BuildingEditValueMap;
  mergedCandidate: BuildingEditValueMap;
}
