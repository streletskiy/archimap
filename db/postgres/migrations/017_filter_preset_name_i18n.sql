ALTER TABLE public.data_filter_presets
  ADD COLUMN IF NOT EXISTS preset_name_i18n_json TEXT;
