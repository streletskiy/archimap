ALTER TABLE public.data_sync_regions
  ADD COLUMN IF NOT EXISTS parent_region_id BIGINT REFERENCES public.data_sync_regions(id) ON DELETE CASCADE;
ALTER TABLE public.data_sync_regions
  ADD COLUMN IF NOT EXISTS region_kind TEXT NOT NULL DEFAULT 'standalone';
ALTER TABLE public.data_sync_regions
  ADD COLUMN IF NOT EXISTS order_in_parent INTEGER;
ALTER TABLE public.data_sync_regions
  ADD COLUMN IF NOT EXISTS visible_in_admin INTEGER NOT NULL DEFAULT 1;
ALTER TABLE public.data_sync_regions
  ADD COLUMN IF NOT EXISTS country_code TEXT;

CREATE INDEX IF NOT EXISTS idx_data_sync_regions_parent
  ON public.data_sync_regions (parent_region_id, order_in_parent);

ALTER TABLE public.data_region_sync_runs
  ADD COLUMN IF NOT EXISTS parent_run_id BIGINT;
ALTER TABLE public.data_region_sync_runs
  ADD COLUMN IF NOT EXISTS subregion_index INTEGER;
ALTER TABLE public.data_region_sync_runs
  ADD COLUMN IF NOT EXISTS subregion_total INTEGER;
ALTER TABLE public.data_region_sync_runs
  ADD COLUMN IF NOT EXISTS current_subregion_id BIGINT;
ALTER TABLE public.data_region_sync_runs
  ADD COLUMN IF NOT EXISTS current_subregion_name TEXT;

CREATE INDEX IF NOT EXISTS idx_data_region_sync_runs_parent
  ON public.data_region_sync_runs (parent_run_id, id);
