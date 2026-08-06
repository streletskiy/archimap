ALTER TABLE public.data_region_sync_runs
  ADD COLUMN IF NOT EXISTS stage TEXT;
ALTER TABLE public.data_region_sync_runs
  ADD COLUMN IF NOT EXISTS stage_progress INTEGER;
ALTER TABLE public.data_region_sync_runs
  ADD COLUMN IF NOT EXISTS stage_detail TEXT;
ALTER TABLE public.data_region_sync_runs
  ADD COLUMN IF NOT EXISTS stage_updated_at TIMESTAMPTZ;
ALTER TABLE public.data_region_sync_runs
  ADD COLUMN IF NOT EXISTS cancel_requested BOOLEAN NOT NULL DEFAULT FALSE;
