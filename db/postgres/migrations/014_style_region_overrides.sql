CREATE TABLE IF NOT EXISTS public.data_style_region_overrides (
  id BIGSERIAL PRIMARY KEY,
  region_pattern TEXT NOT NULL,
  style_key TEXT NOT NULL,
  is_allowed BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_data_style_region_overrides_pattern_style
  ON public.data_style_region_overrides (region_pattern, style_key);

CREATE INDEX IF NOT EXISTS idx_data_style_region_overrides_style_key
  ON public.data_style_region_overrides (style_key, id DESC);
