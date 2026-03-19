CREATE TABLE IF NOT EXISTS public.data_filter_presets (
  id BIGSERIAL PRIMARY KEY,
  preset_key TEXT NOT NULL,
  preset_name TEXT NOT NULL,
  preset_description TEXT,
  layers_json TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_data_filter_presets_key
  ON public.data_filter_presets (preset_key);

CREATE INDEX IF NOT EXISTS idx_data_filter_presets_name
  ON public.data_filter_presets (preset_name, id);
