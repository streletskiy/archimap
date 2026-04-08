ALTER TABLE public.data_sync_regions
  ADD COLUMN IF NOT EXISTS source_data_updated_at TIMESTAMPTZ;
