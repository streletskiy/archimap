ALTER TABLE public.data_sync_regions ADD COLUMN IF NOT EXISTS sync_failure_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE osm.building_contours SET (autovacuum_vacuum_scale_factor = 0.005, autovacuum_analyze_scale_factor = 0.01, autovacuum_vacuum_threshold = 20000);
ALTER TABLE public.data_region_memberships SET (autovacuum_vacuum_scale_factor = 0.005, autovacuum_analyze_scale_factor = 0.01, autovacuum_vacuum_threshold = 20000);
ALTER TABLE public.data_region_sync_runs SET (autovacuum_vacuum_scale_factor = 0.02, autovacuum_analyze_scale_factor = 0.02);
CREATE INDEX IF NOT EXISTS idx_region_runs_parent ON public.data_region_sync_runs(parent_run_id) WHERE parent_run_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_building_search_style ON public.building_search_source(lower(style));
CREATE TABLE IF NOT EXISTS public.data_region_sync_daily (
  day DATE NOT NULL, region_id BIGINT NOT NULL, status TEXT NOT NULL,
  run_count BIGINT NOT NULL DEFAULT 0, duration_seconds DOUBLE PRECISION NOT NULL DEFAULT 0,
  PRIMARY KEY (day, region_id, status)
);
