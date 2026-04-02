ALTER TABLE public.app_general_settings
  ADD COLUMN IF NOT EXISTS custom_basemap_url TEXT NOT NULL DEFAULT '';

ALTER TABLE public.app_general_settings
  ADD COLUMN IF NOT EXISTS custom_basemap_api_key TEXT;
