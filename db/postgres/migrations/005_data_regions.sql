CREATE TABLE IF NOT EXISTS public.app_data_settings (
  id INTEGER PRIMARY KEY,
  env_bootstrap_completed INTEGER NOT NULL DEFAULT 0,
  env_bootstrap_source TEXT,
  updated_by TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT app_data_settings_singleton CHECK (id = 1)
);

CREATE TABLE IF NOT EXISTS public.data_sync_regions (
  id BIGSERIAL PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  source_type TEXT NOT NULL DEFAULT 'extract',
  source_value TEXT NOT NULL DEFAULT '',
  extract_source TEXT,
  extract_id TEXT,
  extract_label TEXT,
  extract_resolution_status TEXT NOT NULL DEFAULT 'needs_resolution',
  extract_resolution_error TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  auto_sync_enabled INTEGER NOT NULL DEFAULT 1,
  auto_sync_on_start INTEGER NOT NULL DEFAULT 0,
  auto_sync_interval_hours INTEGER NOT NULL DEFAULT 168,
  pmtiles_min_zoom INTEGER NOT NULL DEFAULT 13,
  pmtiles_max_zoom INTEGER NOT NULL DEFAULT 16,
  source_layer TEXT NOT NULL DEFAULT 'buildings',
  last_sync_started_at TIMESTAMPTZ,
  last_sync_finished_at TIMESTAMPTZ,
  last_sync_status TEXT NOT NULL DEFAULT 'idle',
  last_sync_error TEXT,
  last_successful_sync_at TIMESTAMPTZ,
  next_sync_at TIMESTAMPTZ,
  bounds_west DOUBLE PRECISION,
  bounds_south DOUBLE PRECISION,
  bounds_east DOUBLE PRECISION,
  bounds_north DOUBLE PRECISION,
  last_feature_count BIGINT,
  updated_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_data_sync_regions_enabled_next
  ON public.data_sync_regions (enabled, next_sync_at);

CREATE TABLE IF NOT EXISTS public.data_region_sync_runs (
  id BIGSERIAL PRIMARY KEY,
  region_id BIGINT NOT NULL REFERENCES public.data_sync_regions(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'queued',
  trigger_reason TEXT NOT NULL DEFAULT 'manual',
  requested_by TEXT,
  requested_at TIMESTAMPTZ,
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  error_text TEXT,
  imported_feature_count BIGINT,
  active_feature_count BIGINT,
  orphan_deleted_count BIGINT,
  pmtiles_bytes BIGINT,
  bounds_west DOUBLE PRECISION,
  bounds_south DOUBLE PRECISION,
  bounds_east DOUBLE PRECISION,
  bounds_north DOUBLE PRECISION,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_data_region_sync_runs_region_id
  ON public.data_region_sync_runs (region_id, id DESC);

CREATE INDEX IF NOT EXISTS idx_data_region_sync_runs_status
  ON public.data_region_sync_runs (status, id DESC);

CREATE TABLE IF NOT EXISTS public.data_region_memberships (
  region_id BIGINT NOT NULL REFERENCES public.data_sync_regions(id) ON DELETE CASCADE,
  osm_type TEXT NOT NULL,
  osm_id BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (region_id, osm_type, osm_id)
);

CREATE INDEX IF NOT EXISTS idx_data_region_memberships_feature
  ON public.data_region_memberships (osm_type, osm_id);
