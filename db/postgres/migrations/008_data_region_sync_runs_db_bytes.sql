ALTER TABLE public.data_region_sync_runs ADD COLUMN IF NOT EXISTS db_bytes BIGINT;
ALTER TABLE public.data_region_sync_runs ADD COLUMN IF NOT EXISTS db_bytes_approximate BOOLEAN DEFAULT FALSE;
