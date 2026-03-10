ALTER TABLE public.data_sync_regions
  ADD COLUMN IF NOT EXISTS extract_source TEXT;

ALTER TABLE public.data_sync_regions
  ADD COLUMN IF NOT EXISTS extract_id TEXT;

ALTER TABLE public.data_sync_regions
  ADD COLUMN IF NOT EXISTS extract_label TEXT;

ALTER TABLE public.data_sync_regions
  ADD COLUMN IF NOT EXISTS extract_resolution_status TEXT NOT NULL DEFAULT 'needs_resolution';

ALTER TABLE public.data_sync_regions
  ADD COLUMN IF NOT EXISTS extract_resolution_error TEXT;

UPDATE public.data_sync_regions
SET source_type = 'extract'
WHERE COALESCE(BTRIM(source_type), '') IN ('', 'extract_query');

UPDATE public.data_sync_regions
SET extract_resolution_status = 'resolved'
WHERE COALESCE(BTRIM(extract_id), '') <> ''
  AND COALESCE(BTRIM(extract_source), '') <> '';
