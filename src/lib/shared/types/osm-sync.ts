import type { OsmElementType, UnknownRecord } from './common';

export interface SyncCandidateStateChange {
  key: string;
  before: string | number | null;
  after: string | number | null;
}

export interface SyncCandidateConflict {
  type: 'upstream_drift';
  message: string;
  sourceFingerprint: string;
  liveFingerprint: string | null;
}

export interface SyncCandidateLiveElement {
  type: string;
  attrs: UnknownRecord | null;
  tags: Record<string, string>;
}

export interface SyncCandidateSummary {
  osmType: OsmElementType;
  osmId: number;
  totalEdits: number;
  syncableEdits: number;
  latestEditId: number;
  latestUpdatedAt: string | null;
  latestCreatedBy: string | null;
  latestStatus: string | null;
  latestLocalName: string | null;
  latestLocalUpdatedAt: string | null;
  sourceOsmUpdatedAt: string | null;
  sourceOsmVersion: string | number | null;
  syncStatus: string;
  syncAttemptedAt: string | null;
  syncSucceededAt: string | null;
  syncCleanedAt: string | null;
  syncChangesetId: string | number | null;
  syncSummary: UnknownRecord | null;
  syncErrorText: string | null;
  currentContourUpdatedAt: string | null;
  localState: Record<string, string>;
  contourState: Record<string, string>;
  changes: SyncCandidateStateChange[];
  syncReadOnly: boolean;
  canSync: boolean;
  hasLocalState: boolean;
  explicitFields: string[];
}

export interface SyncCandidate extends SyncCandidateSummary {
  currentContourTags: Record<string, string>;
  liveElement: SyncCandidateLiveElement | null;
  desiredTags: Record<string, string>;
  changedFields: SyncCandidateStateChange[];
  sourceMatches: boolean;
  conflict: SyncCandidateConflict | null;
  preflightError: string | null;
}
