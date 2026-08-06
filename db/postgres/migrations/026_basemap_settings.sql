ALTER TABLE public.app_general_settings
  ADD COLUMN IF NOT EXISTS basemap_provider TEXT NOT NULL DEFAULT 'carto';

ALTER TABLE public.app_general_settings
  ADD COLUMN IF NOT EXISTS maptiler_api_key TEXT;
