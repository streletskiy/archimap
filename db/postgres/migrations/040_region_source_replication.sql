-- Validators and replication position belong to the source applied in the same
-- transaction as canonical contours and memberships, never a pending download.
ALTER TABLE public.data_region_source_snapshots
  ADD COLUMN download_url TEXT,
  ADD COLUMN source_etag TEXT,
  ADD COLUMN source_last_modified TEXT,
  ADD COLUMN replication_base_url TEXT,
  ADD COLUMN replication_sequence BIGINT CHECK (replication_sequence >= 0),
  ADD COLUMN replication_timestamp TIMESTAMPTZ,
  ADD COLUMN last_full_download_at TIMESTAMPTZ,
  ADD COLUMN import_signature TEXT,
  ADD COLUMN building_input_sha256 TEXT;

COMMENT ON COLUMN public.data_region_source_snapshots.local_path IS
  'Immutable cached dependency-complete PBF for committed managed sources; legacy paths may no longer exist.';
COMMENT ON COLUMN public.data_region_source_snapshots.import_signature IS
  'Import contract fingerprint; NULL legacy snapshots cannot skip import on HTTP validators alone.';
