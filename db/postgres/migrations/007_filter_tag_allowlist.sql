ALTER TABLE public.app_data_settings
  ADD COLUMN IF NOT EXISTS filter_tag_allowlist_json TEXT;
