-- Per-region history of ingested source PBF snapshots.
-- Primary role in Phase 1: record the fingerprint of the canonical extract that
-- was actually applied in the last successful sync. Phase 2 will use the same
-- table to locate the previous snapshot for osmium derive-changes.
CREATE TABLE IF NOT EXISTS public.data_region_source_snapshots (
  id BIGSERIAL PRIMARY KEY,
  region_id BIGINT NOT NULL REFERENCES public.data_sync_regions(id) ON DELETE CASCADE,
  extract_source TEXT,
  extract_id TEXT,
  sha256 TEXT NOT NULL,
  size_bytes BIGINT NOT NULL,
  source_mtime TIMESTAMPTZ,
  local_path TEXT,
  imported_feature_count BIGINT,
  pmtiles_bytes BIGINT,
  is_active SMALLINT NOT NULL DEFAULT 0,
  superseded_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_region_source_snapshots_region_created
  ON public.data_region_source_snapshots (region_id, created_at DESC);

-- Exactly one active snapshot per region.
CREATE UNIQUE INDEX IF NOT EXISTS ux_region_source_snapshots_active
  ON public.data_region_source_snapshots (region_id)
  WHERE is_active = 1;

CREATE INDEX IF NOT EXISTS idx_region_source_snapshots_region_sha
  ON public.data_region_source_snapshots (region_id, sha256);
